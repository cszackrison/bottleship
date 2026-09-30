import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../ui/cx";
import s from "./App.module.css";
import { AudioEngine, AudioPlayEncodedPayload, AudioPlayPayload, AudioUpdatePayload } from "../audio/audio-engine";
import { netplayRelayUrl } from "./netplay-url";
import { getLogClient, sendLogToServer, writeDebugFile, writeDebugFileBase64, rotateLogFile } from "../utils/log-client";
import { installHarnessFacade } from "../harness/facade";
import ExitOverlay from "./ExitOverlay";
import MessageBoxModal, { type MessageBoxRequest } from "./MessageBoxModal";
import type { GuestExitInfo } from "../guest-report";
import { detectBrowserSupport, probeWebGPU, type WebGPUProbeResult } from "../browser-support";
import WebGPUErrorOverlay from "./WebGPUErrorOverlay";
import { ensurePersistentStorageRequested } from "../storage-manager";
import { DEFAULT_QUALITY } from "../worker/core/quality-config";

const GAME_NAME = "StarCraft: Brood War";
const GAME_BUNDLE_URL = "/apps/starcraft_retail.wgb";
const GUEST_MOUSE_COORDS = true;

const INPUT_BUFFER_SIZE = 1024;
const INPUT_INDEX = {
  seq: 0,
  mouseX: 1,
  mouseY: 2,
  buttons: 3,
  keyCode: 4,
  keyState: 5,
  gamepadConnected: 6,
  gamepadButtons: 7,
  gamepadAxis0: 8,
  gamepadAxis1: 9,
  gamepadAxis2: 10,
  gamepadAxis3: 11,
  mouseWheel: 12,
  mouseInside: 13,  // 1 = cursor inside canvas, 0 = outside
  dinputDX: 14,     // accumulated DInput raw movementX delta (Atomics.add / exchange)
  dinputDY: 15,     // accumulated DInput raw movementY delta
  // 16..23 reserved for the keyboard bitfield (KEY_BITFIELD_BASE)
  guestGamepadSeq: 24  // worker bumps when the GAME reads the joystick/gamepad API
} as const;

// Keyboard bitfield: 256 virtual keys as 8 x Int32 = 256 bits
const KEY_BITFIELD_BASE = 16;
const KEY_BITFIELD_COUNT = 8;

type WorkerStatus = "idle" | "ready" | "error";

// CrashFault + formatGuestReport (the crash/exit report machinery) live in
// ./guest-report.ts; the overlay that renders them is ./ExitOverlay.tsx.

type InputSample = {
  t: number;
  mouseX: number;
  mouseY: number;
  buttons: number;
  keyCode: number;
  keyState: number;
  gamepadConnected: number;
  gamepadButtons: number;
  gamepadAxis0: number;
  gamepadAxis1: number;
  gamepadAxis2: number;
  gamepadAxis3: number;
  mouseWheel: number;
};

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...part);
  }
  return btoa(binary);
}

// BrowserSupportInfo + detectBrowserName/detectBrowserSupport (the capability
// gate) live in ./browser-support.ts.

// Persistent state outside the component scope to survive re-mounts
let globalWorker: Worker | null = null;
let globalSab: SharedArrayBuffer | null = null;
let globalInputView: Int32Array | null = null;
let globalOffscreen: OffscreenCanvas | null = null;
let capturePending: { resolve: (blob: Blob) => void; reject: (err: Error) => void } | null = null;
let statsPending: { resolve: (stats: Record<string, number>) => void; reject: (err: Error) => void } | null = null;
let verboseLogPending: { resolve: (text: string) => void; reject: (err: Error) => void } | null = null;
let audioEngine: AudioEngine | null = null;
let isRecording = false;
let recordStart = 0;
let recordedInputs: InputSample[] = [];

// Track currently pressed keys as a Set; serialized to bitfield in SharedArrayBuffer
const pressedKeys = new Set<number>();

function syncKeyBitfield(inputView: Int32Array): void {
    for (let word = 0; word < KEY_BITFIELD_COUNT; word++) {
        let bits = 0;
        const base = word * 32;
        for (const vk of pressedKeys) {
            if (vk >= base && vk < base + 32) bits |= (1 << (vk - base));
        }
        inputView[KEY_BITFIELD_BASE + word] = bits;
    }
}

// --- SAB input seqlock (writer side) ---------------------------------------
// The input record spans many Int32 slots but is published via the single `seq`
// counter. Plain payload writes with only a trailing Atomics bump let the worker
// reader observe a HALF-updated record (torn read). Bracket every payload update
// in a seqlock: bump seq to ODD before touching payload (writer-in-progress),
// write the payload slots, then bump seq to EVEN to publish. Atomics.add is a
// sequentially-consistent RMW, so it fences the plain payload stores between the
// two markers; the reader's paired Atomics.load(seq) acquire sees either an odd
// value (retry/skip) or a stable even snapshot. seq stays even between updates,
// so the reader's "changed since lastSeq" gate is unaffected (each update = +2).
// Zero-alloc, hot-path cheap: two atomic increments per input event.
function beginInputWrite(inputView: Int32Array): void {
    Atomics.add(inputView, INPUT_INDEX.seq, 1); // even -> odd: writer in progress
}
function endInputWrite(inputView: Int32Array): void {
    Atomics.add(inputView, INPUT_INDEX.seq, 1); // odd -> even: publish (release)
}

// Win32 MessageBox button tables + the dev-mode modal live in ./MessageBoxModal.tsx.

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const canvasRectRef = useRef<DOMRect | null>(null);
  const cursorVisibleRef = useRef(true);
  const isCanvasHoveredRef = useRef(false);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Set when the guest process exits; `crashed` distinguishes a clean exit from an unhandled fault.
  const [exitInfo, setExitInfo] = useState<GuestExitInfo | null>(null);
  // Launch overlay: "init" (worker/v86 boot) → downloading/caching/loading → starting → "booting"
  // (guest running until its first frame). `fadingOut` crossfades it away on first present.
  const [loadingProgress, setLoadingProgress] = useState<{
    phase: string; percent: number; label?: string; indeterminate?: boolean; fadingOut?: boolean;
  } | null>(null);
  const loadingFadeTimerRef = useRef<number | null>(null);
  const [messageBox, setMessageBox] = useState<MessageBoxRequest | null>(null);
  const [guestResolution, setGuestResolution] = useState({ width: 640, height: 480 });
  const guestResolutionRef = useRef({ width: 640, height: 480 });

  // ?game=dev = bare emulator (no auto-load) for the harness.
  const bareMode = useMemo(() => new URLSearchParams(window.location.search).get("game") === "dev", []);
  const browserSupport = useMemo(() => detectBrowserSupport(), []);
  const browserUnsupportedMessage = useMemo(() => {
    if (browserSupport.supported) return null;
    const missing = browserSupport.missing.join(", ");
    return `This browser is missing features required to run ${GAME_NAME}: ${missing}. Detected browser: ${browserSupport.detectedBrowser}. Please use an up-to-date Google Chrome or Safari 26+.`;
  }, [browserSupport]);

  // detectBrowserSupport() only checks the API is present; the adapter can still fail to acquire
  // (hardware accel off, GPU blocklisted), so probe for real and block with an overlay. null = probing.
  const [webgpuProbe, setWebgpuProbe] = useState<WebGPUProbeResult | null>(null);
  useEffect(() => {
    if (!browserSupport.supported) return;
    let cancelled = false;
    probeWebGPU().then(
      (r) => { if (!cancelled) setWebgpuProbe(r); },
      () => { if (!cancelled) setWebgpuProbe({ ok: true, stage: "ok", reason: "", hints: [] }); },
    );
    return () => { cancelled = true; };
  }, [browserSupport.supported]);

  const autoLoadDoneRef = useRef(false);
  useEffect(() => {
    if (bareMode || !browserSupport.supported || (webgpuProbe !== null && !webgpuProbe.ok)) return;
    if (workerStatus !== "ready" || autoLoadDoneRef.current) return;
    autoLoadDoneRef.current = true;
    (window as any).loadApp?.(GAME_BUNDLE_URL);
  }, [bareMode, browserSupport.supported, workerStatus, webgpuProbe]);

  // Cover the worker/v86 boot phase too: before "ready" there is no load progress yet.
  useEffect(() => {
    if (bareMode || !browserSupport.supported) return;
    if (workerStatus === "ready" || workerStatus === "error" || errorMessage || exitInfo) return;
    setLoadingProgress((prev) => prev ?? { phase: "init", percent: 0, indeterminate: true });
  }, [bareMode, browserSupport.supported, workerStatus, errorMessage, exitInfo]);

  useEffect(() => () => {
    if (loadingFadeTimerRef.current !== null) window.clearTimeout(loadingFadeTimerRef.current);
  }, []);

  // Pointer lock state for relative mouse input
  const pointerLockedRef   = useRef(false);
  const wantsPointerLockRef = useRef(false);
  const virtualMouseRef    = useRef({ x: 0, y: 0 });
  // Cooldown after exitPointerLock — browser rejects re-acquire for ~1 frame after exit
  const pointerLockCooldownRef = useRef(false);
  // Relative-mouse engagement = cursor hidden (ShowCursor) OR ClipCursor confined OR exclusive DInput mouse.
  const cursorClippedRef = useRef(false);
  const mouseCapturedRef = useRef(false);
  // Right Ctrl deliberately released the lock — suppress auto re-acquire until the next canvas click.
  const userReleasedLockRef = useRef(false);
  const toggleFullscreenRef = useRef<() => void>(() => {});

  const requestPointerLockSafe = (canvas: HTMLCanvasElement) => {
    if (pointerLockCooldownRef.current) return;
    Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  };

  const updatePointerLockIntent = () => {
    const wants = !cursorVisibleRef.current || cursorClippedRef.current || mouseCapturedRef.current;
    wantsPointerLockRef.current = wants;
    if (wants) {
      const c = canvasRef.current;
      if (c && document.hasFocus() && !pointerLockedRef.current && !userReleasedLockRef.current) {
        requestPointerLockSafe(c);
      }
    } else if (document.pointerLockElement) {
      pointerLockCooldownRef.current = true;
      document.exitPointerLock();
      setTimeout(() => { pointerLockCooldownRef.current = false; }, 32);
    }
  };

  const sabAvailable = typeof SharedArrayBuffer !== "undefined";
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
  const secureContext = typeof window !== "undefined" ? window.isSecureContext : true;

  const resolutionRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    if (workerStatus !== "ready") return;
    globalWorker?.postMessage({ type: "set_quality", quality: DEFAULT_QUALITY });
  }, [workerStatus]);

  useEffect(() => {
    if (!browserSupport.supported || !sabAvailable || !isolated) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateCanvasCursor = (forceHovered?: boolean) => {
      const hovered = forceHovered ?? isCanvasHoveredRef.current;
      if (!cursorVisibleRef.current && hovered) {
        canvas.style.cursor = "none";
      } else {
        canvas.style.cursor = "";
      }
    };

    // 1. Initialize Worker (only once)
    if (!globalWorker) {
      globalWorker = new Worker(
        new URL("../worker/emulator.worker.ts", import.meta.url),
        { type: "module" }
      );

      // Expose worker to console for debugging
      (window as any).worker = globalWorker;

      // Persisted debug flags (e.g. __noHeapSlab to A/B the WASM heap slab). Replayed to
      // the worker on EVERY page load BEFORE any game loads, so a toggle survives F5.
      // Set from the console: dbgFlag('__noHeapSlab', true)  → persists + applies live.
      try {
        const flags = JSON.parse(localStorage.getItem("bs_debug_flags") || "{}");
        for (const [key, value] of Object.entries(flags)) {
          globalWorker.postMessage({ type: "set_debug_flag", key, value });
        }
        if (Object.keys(flags).length) console.info("[bs] replayed debug flags:", flags);
      } catch { /* corrupt/no flags */ }
      const netplayUrl = netplayRelayUrl(new URLSearchParams(window.location.search));
      if (netplayUrl) globalWorker.postMessage({ type: "netplay_config", url: netplayUrl });
      (window as any).joinRoom = (room: string | null) => {
        const url = room ? netplayRelayUrl(new URLSearchParams({ room })) : null;
        globalWorker?.postMessage({ type: "netplay_config", url });
        return url;
      };
      (window as any).dbgFlag = (key: string, value: unknown) => {
        const flags = JSON.parse(localStorage.getItem("bs_debug_flags") || "{}");
        if (value === undefined || value === null) delete flags[key]; else flags[key] = value;
        localStorage.setItem("bs_debug_flags", JSON.stringify(flags));
        globalWorker?.postMessage({ type: "set_debug_flag", key, value });
        return { [key]: value, note: "persisted; takes effect on next game load" };
      };

      // AI-agent harness facade: window.__BS__.harness. Thin page-side
      // forwarder over harness_rpc + the normalized event bus; logic lives in the
      // worker HarnessService. Coexists with the legacy window.dbg Proxy below.
      installHarnessFacade(globalWorker);

      // Guest debugger bridge: window.dbg.<cmd>(...args) -> worker {type:"dbg"} ->
      // handleDbgCommand() -> wasm dbg_* primitives. Output flows back via console.
      // Usage: dbg.enable(); dbg.bp("0x1309e110"); dbg.stepOnBp(300); then load the game.
      //
      // Dialog instrumentation: the worker posts {type:"dbg_event"} for dialog enumeration
      // (dlgList) and live dialog appearance (dialogShow). We buffer the latest per event so
      // loops can drive game launchers without the worker DevTools:
      //   const d = await window.dbg.waitForEvent("dialogShow");   // catch a launcher dialog
      //   window.dbg.dlgClick("Play Game");                        // faithful click (by title)
      // window.dbg.lastEvent("dlgList") reads the most recent enumeration after dbg.dlgList().
      const dbgLastEvents: Record<string, any> = {};
      const dbgWaiters: Record<string, Array<(d: any) => void>> = {};
      globalWorker?.addEventListener("message", (ev: MessageEvent) => {
        const m = ev.data;
        if (m?.type !== "dbg_event") return;
        dbgLastEvents[m.event] = m.data;
        const ws = dbgWaiters[m.event];
        if (ws && ws.length) {
          dbgWaiters[m.event] = [];
          for (const w of ws) w(m.data);
        }
      });
      (window as any).dbg = new Proxy(
        {},
        {
          get: (_t, cmd: string) => {
            if (cmd === "waitForEvent") {
              return (name: string, timeoutMs = 60000) =>
                new Promise((resolve) => {
                  let done = false;
                  const finish = (d: any) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(d);
                  };
                  const timer = setTimeout(() => finish(null), timeoutMs);
                  (dbgWaiters[name] ??= []).push(finish);
                });
            }
            if (cmd === "lastEvent") return (name: string) => dbgLastEvents[name] ?? null;
            return (...args: any[]) => globalWorker?.postMessage({ type: "dbg", cmd, args });
          },
        }
      );

      // Convenience function: getPixelStats() - returns promise with GetPixel statistics
      (window as any).getPixelStats = () => {
        return new Promise((resolve) => {
          const handler = (e: MessageEvent) => {
            if (e.data?.type === "get_pixel_stats") {
              globalWorker!.removeEventListener("message", handler);
              console.table(e.data.stats);
              resolve(e.data.stats);
            }
          };
          globalWorker!.addEventListener("message", handler);
          globalWorker!.postMessage({ type: "get_pixel_stats" });
        });
      };

      // dbg.snapshot() posts JSON back — usable from MCP without worker DevTools.
      (window as any).dbgSnapshot = () => {
        return new Promise((resolve, reject) => {
          const handler = (e: MessageEvent) => {
            if (e.data?.type === "dbg_snapshot") {
              globalWorker!.removeEventListener("message", handler);
              if (e.data.ok) resolve(e.data.data);
              else reject(new Error(e.data.error || "dbg snapshot failed"));
            }
          };
          globalWorker!.addEventListener("message", handler);
          globalWorker!.postMessage({ type: "dbg", cmd: "snapshot", args: [] });
        });
      };

      (window as any).dbgGalaxyReport = () => {
        return new Promise((resolve, reject) => {
          const handler = (e: MessageEvent) => {
            if (e.data?.type === "dbg_galaxy_report") {
              globalWorker!.removeEventListener("message", handler);
              if (e.data.ok) resolve(e.data.data);
              else reject(new Error(e.data.error || "galaxy report failed"));
            }
          };
          globalWorker!.addEventListener("message", handler);
          globalWorker!.postMessage({ type: "dbg", cmd: "galaxyReport", args: [] });
        });
      };

      (window as any).dbgHleReport = () => {
        return new Promise((resolve, reject) => {
          const handler = (e: MessageEvent) => {
            if (e.data?.type === "dbg_hle_report") {
              globalWorker!.removeEventListener("message", handler);
              if (e.data.ok) resolve(e.data.data);
              else reject(new Error(e.data.error || "hle report failed"));
            }
          };
          globalWorker!.addEventListener("message", handler);
          globalWorker!.postMessage({ type: "dbg", cmd: "hleReport", args: [] });
        });
      };

      // Enable log client for server logging (only in dev mode)
      getLogClient().enable();
    }
    const worker = globalWorker;

    // 2. Initialize SharedArrayBuffer (only once)
    if (!globalSab) {
      console.log('BottleShip: Initializing SharedArrayBuffer');
      globalSab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
      globalInputView = new Int32Array(globalSab);
    }
    const inputBuffer = globalSab;
    if (!audioEngine) audioEngine = new AudioEngine();
    // Resume the AudioContext on the first user gesture anywhere on the page (and
    // auto-recover from later browser suspensions). Without this the context stays
    // SUSPENDED under the autoplay policy → frozen AudioWorklet/SAB play cursor →
    // audio-gated guest logic silently stalls when autoplay policy blocks the AudioContext.
    audioEngine.armAutoResume();
    audioEngine.onEnded = (id: number) => {
      if (globalWorker) {
        globalWorker.postMessage({ type: "audio_ended", id });
      }
    };
    audioEngine.onStatusChange = (id: number, status: "started" | "error", error?: string) => {
      if (globalWorker) {
        if (status === "started") {
          globalWorker.postMessage({ type: "audio_started", id });
        } else if (status === "error") {
          globalWorker.postMessage({ type: "audio_error", id, error: error || "Unknown error" });
        }
      }
    };
    audioEngine.onPosition = (id: number, positionFrames: number) => {
      if (globalWorker) {
        globalWorker.postMessage({ type: "audio_position", id, positionFrames });
      }
    };

    const resize = () => {
      const devicePixelRatio = window.devicePixelRatio || 1;
      const renderWidth = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
      const renderHeight = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));

      // Update ref for event calculations (cannot set canvas.width/height anymore)
      resolutionRef.current = { width: renderWidth, height: renderHeight };
      canvasRectRef.current = canvas.getBoundingClientRect();

      const useGuestCoords = GUEST_MOUSE_COORDS;
      const target = useGuestCoords
        ? guestResolutionRef.current
        : { width: renderWidth, height: renderHeight };

      worker.postMessage({ type: "resize", width: target.width, height: target.height });
    };

    // 3. Setup Worker Message Handling
    worker.onmessage = (event: MessageEvent) => {
      //console.log('BottleShip: Worker message received:', event.data?.type);
      
      // Forward logs to server (if enabled)
      if (event.data?.type === "log_stream_entry") {
        // Legacy single-entry format (backward compatibility)
        const entry = event.data.entry;
        if (entry) {
          sendLogToServer({
            timestamp: entry.timestamp || Date.now(),
            category: entry.category || "UNKNOWN",
            level: entry.level ?? 2,
            message: entry.message || "",
          });
        }
      } else if (event.data?.type === "log_stream_batch") {
        // New batch format - process all entries
        const entries = event.data.entries;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            sendLogToServer({
              timestamp: entry.timestamp || Date.now(),
              category: entry.category || "UNKNOWN",
              level: entry.level ?? 2,
              message: entry.message || "",
            });
          }
        }
      } else if (event.data?.type === "seh_runtime_dump") {
        const payload = event.data?.payload;
        const fileStem = typeof payload?.fileStem === "string" ? payload.fileStem : "";
        const manifest = payload?.manifest;
        const bytes = payload?.bytes as ArrayBuffer | undefined;
        if (fileStem && manifest && bytes instanceof ArrayBuffer) {
          const base = `seh-dumps/${fileStem}`;
          const manifestOk = writeDebugFile(`${base}.json`, JSON.stringify(manifest, null, 2));
          const dumpOk = writeDebugFileBase64(`${base}.bin`, bytesToBase64(new Uint8Array(bytes)));
          if (manifestOk && dumpOk) {
            console.log(`BottleShip: SEH runtime dump saved -> logs/${base}.{json,bin}`);
          } else {
            console.warn(`BottleShip: SEH runtime dump not persisted (log server disconnected?) -> ${base}`);
          }
        }
      } else if (event.data?.type === "debug_png_dump") {
        // Worker-side bitmap dump for visual debugging: base64 PNG -> logs/debug/<name>.png
        const name = typeof event.data?.name === "string" ? event.data.name : "dump";
        const base64 = typeof event.data?.base64 === "string" ? event.data.base64 : "";
        if (base64) {
          const ok = writeDebugFileBase64(`debug/${name}.png`, base64);
          console.log(`BottleShip: debug PNG ${ok ? "saved" : "NOT saved (log server?)"} -> logs/debug/${name}.png`);
        }
      }

      if (event.data?.type === "ready") {
        setWorkerStatus("ready");
      }
      if (event.data?.type === "error") {
        setWorkerStatus("error");
        setErrorMessage(event.data.message ?? "Worker error");
        // Tear down the launch overlay so the error surfaces instead of a stuck "booting".
        setLoadingProgress(null);
      }
      if (event.data?.type === "process_exit") {
        // The guest process called ExitProcess (or crashed → SEH → ExitProcess).
        // The emulator has torn down all threads; reflect a clean exit instead of
        // leaving the last (now stale) frame on screen.
        setExitInfo({
          code: typeof event.data.exitCode === "number" ? event.data.exitCode : 0,
          crashed: !!event.data.crashed,
          fault: event.data.fault ?? undefined,
        });
        // The worker is gone but the worklet keeps rendering whatever ring/legacy
        // sources were still PLAYING — a looping/circular buffer drones the stale
        // ring forever. Silence everything on guest exit.
        audioEngine?.stopAll();
        setLoadingProgress(null);
      }
      if (event.data?.type === "loading_progress") {
        const { phase, percent, label } = event.data;
        // A fresh load clears any prior "game exited" state.
        setExitInfo(null);
        if (phase === "done") {
          // PE is loaded but the guest hasn't drawn yet. DON'T hide the overlay here —
          // switch it to an indeterminate "booting" state and keep it up until the worker
          // signals `first_present` (the real first flip). Hiding now exposes a black canvas
          // through CRT/DirectX/asset init.
          setLoadingProgress({ phase: "booting", percent: 100, indeterminate: true });
          globalWorker?.postMessage({ type: "set_quality", quality: DEFAULT_QUALITY });
        } else {
          // Byte-counted phases (downloading/caching/installing) show a real bar; the rest
          // (loading/starting) have no measurable progress → indeterminate shimmer.
          const determinate = phase === "downloading" || phase === "caching" || phase === "installing" || phase === "prefetch";
          setLoadingProgress({ phase, percent: percent ?? 0, label, indeterminate: !determinate });
        }
      }
      if (event.data?.type === "first_present") {
        // The guest composited its first real frame — crossfade the launch overlay out.
        setLoadingProgress((prev) => (prev ? { ...prev, fadingOut: true } : null));
        if (loadingFadeTimerRef.current !== null) window.clearTimeout(loadingFadeTimerRef.current);
        loadingFadeTimerRef.current = window.setTimeout(() => {
          // Only clear if still fading — a fresh load may have replaced the overlay.
          setLoadingProgress((prev) => (prev?.fadingOut ? null : prev));
          loadingFadeTimerRef.current = null;
        }, 450);
      }
      if (event.data?.type === "install_progress") {
        const { phase, doneBytes, totalBytes } = event.data;
        const doneMb = (doneBytes / 1024 / 1024).toFixed(0);
        const totalMb = totalBytes > 0 ? (totalBytes / 1024 / 1024).toFixed(0) : "?";
        const pct = totalBytes > 0 ? Math.round(doneBytes / totalBytes * 100) : 0;
        setLoadingProgress({
          phase: phase === "installing" ? "installing" : phase,
          percent: pct,
          label: phase === "installing" ? `${doneMb} / ${totalMb} MB` : phase,
          indeterminate: phase !== "installing",
        });
        if (phase === "starting") {
          setLoadingProgress({ phase: "starting", percent: 100, label: "", indeterminate: true });
        }
      }
      if (event.data?.type === "installer_unsupported") {
        setLoadingProgress(null);
        setErrorMessage(event.data.message ?? "This installer format is not supported.");
      }
      if (event.data?.type === "capture_frame") {
        if (!capturePending) return;
        if (event.data?.ok) {
          const blob = new Blob([event.data.buffer], { type: "image/png" });
          capturePending.resolve(blob);
        } else {
          capturePending.reject(new Error(event.data?.error ?? "Capture failed"));
        }
        capturePending = null;
      }
      if (event.data?.type === "render_stats") {
        if (!statsPending) return;
        if (event.data?.ok) {
          statsPending.resolve(event.data?.stats ?? {});
        } else {
          statsPending.reject(new Error(event.data?.error ?? "Stats request failed"));
        }
        statsPending = null;
      }
      if (event.data?.type === "msg_timer_diag" || event.data?.type === "h3_timer_diag") {
        const label = event.data.type;
        if (event.data?.ok) {
          console.log(`BottleShip: ${label}`, event.data?.config ?? null);
        } else {
          console.warn(`BottleShip: ${label} error`, event.data?.error ?? "unknown");
        }
      }
      if (event.data?.type === "ui_gate_diag" || event.data?.type === "h3_gate_diag") {
        const label = event.data.type;
        if (event.data?.ok) {
          console.log(`BottleShip: ${label}`, event.data?.config ?? null);
        } else {
          console.warn(`BottleShip: ${label} error`, event.data?.error ?? "unknown");
        }
      }
      if (event.data?.type === "log_verbose_export") {
        if (!verboseLogPending) return;
        if (event.data?.ok) {
          verboseLogPending.resolve(String(event.data?.text ?? ""));
        } else {
          verboseLogPending.reject(new Error(event.data?.error ?? "Log export failed"));
        }
        verboseLogPending = null;
      }
      if (event.data?.type === "log_verbose_clear") {
        if (event.data?.ok) {
          console.log("BottleShip: Verbose logs cleared");
        } else {
          console.error("BottleShip: Failed to clear verbose logs:", event.data?.error);
        }
      }
      if (event.data?.type === "diag_download") {
        const content = String(event.data?.content ?? "");
        const filename = String(event.data?.filename ?? "diag.txt");
        const blob = new Blob([content], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
      }
      if (event.data?.type === "audio_play") {
        audioEngine?.play(event.data?.payload as AudioPlayPayload);
      }
      if (event.data?.type === "audio_play_encoded") {
        audioEngine?.playEncoded(event.data?.payload as AudioPlayEncodedPayload);
      }
      if (event.data?.type === "audio_stop") {
        const id = Number(event.data?.payload?.id ?? 0);
        if (id) audioEngine?.stop(id);
      }
      if (event.data?.type === "audio_pause") {
        const id = Number(event.data?.payload?.id ?? 0);
        if (id) audioEngine?.pauseSource(id);
      }
      if (event.data?.type === "audio_resume") {
        const id = Number(event.data?.payload?.id ?? 0);
        if (id) audioEngine?.resumeSource(id);
      }
      if (event.data?.type === "audio_seek") {
        const id = Number(event.data?.payload?.id ?? 0);
        const timeMs = Number(event.data?.payload?.timeMs ?? 0);
        if (id) audioEngine?.seekSource(id, timeMs);
      }
      if (event.data?.type === "audio_update") {
        const payload = event.data?.payload as AudioUpdatePayload;
        if (payload?.id) {
          audioEngine?.update(payload);
        }
      }
      if (event.data?.type === "audio_append") {
        const payload = event.data?.payload as { id: number; data: Float32Array };
        if (payload?.id && payload?.data) {
          audioEngine?.append(payload);
        }
      }
      if (event.data?.type === "audio_replace") {
        const payload = event.data?.payload as { id: number; data: Float32Array; channels: number };
        if (payload?.id && payload?.data) {
          audioEngine?.replace(payload);
        }
      }
      if (event.data?.type === "audio_register") {
        const id = Number(event.data?.payload?.id ?? 0);
        const sab = event.data?.payload?.sab as SharedArrayBuffer | undefined;
        if (id && sab) {
          // Resume AudioContext immediately — video may start before a user gesture,
          // but the user likely already clicked (load game) so the gesture is in the past.
          void audioEngine?.resume();
          audioEngine?.registerBuffer(id, sab);
        }
      }
      if (event.data?.type === "audio_unregister") {
        const id = Number(event.data?.payload?.id ?? 0);
        if (id) audioEngine?.unregisterBuffer(id);
      }
      if (event.data?.type === "audio_listener_sab") {
        const sab = event.data?.payload?.sab as SharedArrayBuffer | undefined;
        if (sab) audioEngine?.registerListenerSab(sab);
      }
      if (event.data?.type === "audio_stats_sab") {
        const sab = event.data?.payload?.sab as SharedArrayBuffer | undefined;
        if (sab) audioEngine?.registerStatsSab(sab);
      }
      // video_frame and video_end are handled in the worker via WebGPU compositor (smackw32.ts → backend.composite)
      if (event.data?.type === "cursor_visibility") {
        const visible = event.data?.visible !== false;
        cursorVisibleRef.current = visible;
        updateCanvasCursor();
        // Engage/release pointer-lock on the faithful relative signal (hidden OR clipped).
        updatePointerLockIntent();
      }
      if (event.data?.type === "clip_cursor") {
        // Guest ClipCursor(rect) confines the cursor (relative/captured mouse, e.g. Unreal
        // SetMouseCapture); ClipCursor(NULL) releases it. Feed it into the same intent as
        // ShowCursor so confined-but-visible games also engage pointer-lock.
        cursorClippedRef.current = event.data?.clip === true;
        updatePointerLockIntent();
      }
      if (event.data?.type === "mouse_capture") {
        // Guest acquired/released an exclusive-mode DirectInput mouse. On real Windows this
        // implicitly captures the cursor (relative mode) with no ShowCursor/ClipCursor call,
        // so feed it into the same intent to engage/release pointer-lock.
        mouseCapturedRef.current = event.data?.capture === true;
        updatePointerLockIntent();
      }
      if (event.data?.type === "set_cursor_pos") {
        // Guest called SetCursorPos — update virtual cursor so next movement continues from here
        const x = Number(event.data.x) | 0;
        const y = Number(event.data.y) | 0;
        virtualMouseRef.current = { x, y };
        if (pointerLockedRef.current && globalInputView) {
          beginInputWrite(globalInputView);
          globalInputView[INPUT_INDEX.mouseX] = x;
          globalInputView[INPUT_INDEX.mouseY] = y;
          endInputWrite(globalInputView);
        }
      }
      if (event.data?.type === "show_message_box") {
        const { id, text, caption, uType } = event.data;
        const targetWorker = event.target as Worker;
        const typeMask = (Number(uType) || 0) & 0xf;
        // Harness auto-modal resolver answers first; otherwise show a non-blocking in-page dialog
        // (window.alert/confirm would freeze the main thread and break CDP screenshots).
        const autoReply = (window as any).__BS__?.harness?.autoModalReply?.({ text, caption });
        if (typeof autoReply === "number") {
          targetWorker.postMessage({ type: "message_box_result", id, result: autoReply });
        } else {
          setMessageBox({ id, text: text || "", caption: caption || "", typeMask, worker: targetWorker });
        }
      }
      if (event.data?.type === "app_resize") {
        const width = Math.max(1, Number(event.data.width) || 1);
        const height = Math.max(1, Number(event.data.height) || 1);
        guestResolutionRef.current = { width, height };
        setGuestResolution({ width, height });
        // Expose for the harness UI-overlay tool (gridShot): maps guest pixels —
        // the space clickAt() injects into — onto the on-screen canvas rect.
        ((window as any).__BS__ ??= {}).guestResolution = { width, height };
        if (canvas) {
          canvasRectRef.current = canvas.getBoundingClientRect();
          worker.postMessage({ type: "resize", width, height });
          // setGuestResolution() re-renders the canvas with a new aspect-ratio, shifting its position;
          // a size-only ResizeObserver misses position shifts, so re-capture the rect after layout.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (canvasRef.current) canvasRectRef.current = canvasRef.current.getBoundingClientRect();
          }));
        }
      }
      if (event.data?.type === "window_title") {
        const title = String(event.data.title || "");
        document.title = title || GAME_NAME;
      }
      if (event.data?.type === "window_icon") {
        const buffer = event.data.data as ArrayBuffer | undefined;
        if (buffer && buffer.byteLength > 0) {
          const blob = new Blob([buffer], { type: "image/x-icon" });
          const url = URL.createObjectURL(blob);
          // Replace or create <link rel="icon">
          let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
          if (!link) {
            link = document.createElement("link");
            link.rel = "icon";
            document.head.appendChild(link);
          }
          // Revoke previous blob URL to avoid memory leak
          if (link.href.startsWith("blob:")) URL.revokeObjectURL(link.href);
          link.type = "image/x-icon";
          link.href = url;
        }
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      setWorkerStatus("error");
      setErrorMessage(event.message);
    };

    // 4. Initialize Offscreen Control (only once)
    if (!globalOffscreen) {
      const devicePixelRatio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));

      resolutionRef.current = { width, height };

      try {
        globalOffscreen = canvas.transferControlToOffscreen();
        console.log('BottleShip: Sending init to worker (new canvas)');
        worker.postMessage(
          {
            type: "init",
            canvas: globalOffscreen,
            inputBuffer,
            width,
            height
          },
          [globalOffscreen]
        );
      } catch (err) {
        console.warn('BottleShip: Failed to transfer control (maybe already transferred), signaling worker anyway');
        worker.postMessage({ type: "init" });
      }
    } else {
      console.log('BottleShip: Already have offscreen canvas, signaling worker');
      const { width, height } = resolutionRef.current;
      worker.postMessage({
        type: "init",
        inputBuffer,
        width,
        height
      });
    }


    // Initial resize to sync measurement
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    document.addEventListener("fullscreenchange", resize);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    // 5. Input Handlers
    const writePointer = (event: PointerEvent) => {
      const inputView = globalInputView;
      if (!inputView) return;

      // Opportunistic re-acquire after an ESC-exit: if the guest still wants relative mouse and
      // the user didn't deliberately release (Right Ctrl), retry on pointermove. Many browsers
      // don't treat pointermove as a valid activation gesture, so this is best-effort — the
      // reliable path is the canvas click in handlePointerDown. Guarded so a rejection is silent.
      if (
        !pointerLockedRef.current &&
        wantsPointerLockRef.current &&
        !userReleasedLockRef.current &&
        !pointerLockCooldownRef.current &&
        document.hasFocus()
      ) {
        try { requestPointerLockSafe(canvas); } catch { /* not a valid gesture in this browser */ }
      }

      // --- Pointer Lock mode: use relative movementX/Y, skip canvas bounds check ---
      if (pointerLockedRef.current) {
        const pointerSpace =
          GUEST_MOUSE_COORDS
            ? guestResolutionRef.current
            : resolutionRef.current;
        const width  = Math.max(1, pointerSpace.width);
        const height = Math.max(1, pointerSpace.height);
        const rect   = canvasRectRef.current ?? canvas.getBoundingClientRect();
        const scaleX = width  / Math.max(1, rect.width);
        const scaleY = height / Math.max(1, rect.height);
        const virt   = virtualMouseRef.current;
        virt.x = Math.max(0, Math.min(width  - 1, virt.x + event.movementX * scaleX));
        virt.y = Math.max(0, Math.min(height - 1, virt.y + event.movementY * scaleY));
        beginInputWrite(inputView);
        inputView[INPUT_INDEX.mouseX]  = Math.round(virt.x);
        inputView[INPUT_INDEX.mouseY]  = Math.round(virt.y);
        inputView[INPUT_INDEX.buttons] = event.buttons;
        // DirectInput reports RAW device deltas (relative axes), NOT canvas-scaled — feed the
        // accumulator unscaled movementX/Y. The virtual cursor above stays scaled (CSS→guest).
        // (dinputDX/DY are independent atomic accumulators, not part of the seqlock snapshot.)
        Atomics.add(inputView, INPUT_INDEX.dinputDX, Math.round(event.movementX));
        Atomics.add(inputView, INPUT_INDEX.dinputDY, Math.round(event.movementY));
        endInputWrite(inputView);
        globalWorker?.postMessage({ type: "input_tick" });
        return;
      }

      // --- Normal absolute mode ---
      const rect = canvasRectRef.current ?? canvas.getBoundingClientRect();

      // When pointer is captured (button held), process events even outside canvas
      const hasCaptured = canvas.hasPointerCapture(event.pointerId);
      const insideCanvas = event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!insideCanvas && !hasCaptured) {
        if (isCanvasHoveredRef.current) {
          handlePointerLeave(event);
        }
        return;
      }

      const pointerSpace =
        GUEST_MOUSE_COORDS
          ? guestResolutionRef.current
          : resolutionRef.current;
      const width = Math.max(1, pointerSpace.width);
      const height = Math.max(1, pointerSpace.height);

      // Coordinate scaling: mouse events are in client/CSS pixels
      // We map them to the virtual resolution [0..width/height]
      const scaleX = width / rect.width;
      const scaleY = height / rect.height;
      const x = Math.max(0, Math.min(width, (event.clientX - rect.left) * scaleX));
      const y = Math.max(0, Math.min(height, (event.clientY - rect.top) * scaleY));

      beginInputWrite(inputView);
      inputView[INPUT_INDEX.mouseX] = Math.round(x);
      inputView[INPUT_INDEX.mouseY] = Math.round(y);
      inputView[INPUT_INDEX.buttons] = event.buttons;
      Atomics.add(inputView, INPUT_INDEX.dinputDX, Math.round(event.movementX * scaleX));
      Atomics.add(inputView, INPUT_INDEX.dinputDY, Math.round(event.movementY * scaleY));
      endInputWrite(inputView);
      globalWorker?.postMessage({ type: "input_tick" });
      if (isRecording) {
        recordedInputs.push({
          t: performance.now() - recordStart,
          mouseX: inputView[INPUT_INDEX.mouseX],
          mouseY: inputView[INPUT_INDEX.mouseY],
          buttons: inputView[INPUT_INDEX.buttons],
          keyCode: inputView[INPUT_INDEX.keyCode],
          keyState: inputView[INPUT_INDEX.keyState],
          gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
          gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
          gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
          gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
          gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
          gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
          mouseWheel: inputView[INPUT_INDEX.mouseWheel] ?? 0,
        });
      }
    };

    const handlePointerEnter = () => {
      isCanvasHoveredRef.current = true;
      updateCanvasCursor(true);
      const inputView = globalInputView;
      if (inputView && inputView[INPUT_INDEX.mouseInside] === 0) {
        beginInputWrite(inputView);
        inputView[INPUT_INDEX.mouseInside] = 1;
        endInputWrite(inputView);
        globalWorker?.postMessage({ type: "input_tick" });
      }
    };

    const handlePointerLeave = (event?: PointerEvent) => {
      if (!isCanvasHoveredRef.current) return;
      // Don't leave if pointer is captured (button held down while moving outside)
      if (event && canvas.hasPointerCapture(event.pointerId)) return;

      isCanvasHoveredRef.current = false;
      updateCanvasCursor(false);
      const inputView = globalInputView;
      if (!inputView) return;

      // Always signal mouse-outside so InputManager can fire WM_MOUSELEAVE
      const insideChanged  = inputView[INPUT_INDEX.mouseInside] !== 0;
      const buttonsChanged = inputView[INPUT_INDEX.buttons] !== 0;
      if (insideChanged || buttonsChanged) {
        beginInputWrite(inputView);
        if (insideChanged)  inputView[INPUT_INDEX.mouseInside] = 0;
        if (buttonsChanged) inputView[INPUT_INDEX.buttons] = 0;
        endInputWrite(inputView);
        globalWorker?.postMessage({ type: "input_tick" });
      }
      if (isRecording) {
        recordedInputs.push({
          t: performance.now() - recordStart,
          mouseX: inputView[INPUT_INDEX.mouseX],
          mouseY: inputView[INPUT_INDEX.mouseY],
          buttons: inputView[INPUT_INDEX.buttons],
          keyCode: inputView[INPUT_INDEX.keyCode],
          keyState: inputView[INPUT_INDEX.keyState],
          gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
          gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
          gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
          gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
          gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
          gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
          mouseWheel: inputView[INPUT_INDEX.mouseWheel] ?? 0,
        });
      }
    };

    const handleKey = (event: KeyboardEvent, state: number) => {
      const inputView = globalInputView;
      if (!inputView) return;

      // F11 = host fullscreen (Element Fullscreen API on the canvas panel). Not forwarded
      // to the guest — browsers reserve F11 for chrome fullscreen, and our hint advertises it.
      if (event.code === "F11") {
        event.preventDefault();
        event.stopPropagation();
        if (state === 1) toggleFullscreenRef.current();
        return;
      }

      // Right Ctrl = deliberate host-release key for pointer lock. When locked, release and
      // suppress auto re-acquire (handlePointerLockChange / updatePointerLockIntent) until the
      // next explicit canvas click. Consumed as a host key (not forwarded to the guest) so it
      // can't be confused with an in-game RControl bind while it's the escape hatch.
      // (ESC is left untouched — the browser force-exits lock on ESC and it must still reach
      // the guest as the menu key.)
      if (event.code === "ControlRight" && state === 1) {
        if (pointerLockedRef.current || document.pointerLockElement) {
          userReleasedLockRef.current = true;
          pointerLockCooldownRef.current = true;
          document.exitPointerLock();
          setTimeout(() => { pointerLockCooldownRef.current = false; }, 32);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      // Pointer-locked: swallow browser chrome handling (Tab focus cycle, Alt menus, …)
      // so keys like Max Payne's painkiller Tab reach the guest. Capture-phase listeners
      // (below) run before focus navigation. ESC stays un-preventDefault'd so the UA can
      // exit lock; we still forward it to the guest as the menu key.
      if (pointerLockedRef.current || document.pointerLockElement === canvas) {
        if (event.code !== "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
      }

      // Ctrl/Alt+digit are guest hotkeys (control groups); keep the browser from switching tabs.
      if ((event.ctrlKey || event.altKey) && /^(Digit|Numpad)\d$/.test(event.code)) event.preventDefault();

      if (state === 1) void audioEngine?.resume();

      // Update pressed keys set and serialize to bitfield
      const vk = event.keyCode & 0xff;
      if (state === 1) {
        pressedKeys.add(vk);
      } else {
        pressedKeys.delete(vk);
      }
      beginInputWrite(inputView);
      syncKeyBitfield(inputView);

      // Clear legacy single-event slots (deprecated)
      inputView[INPUT_INDEX.keyCode] = 0;
      inputView[INPUT_INDEX.keyState] = 0;

      endInputWrite(inputView);
      globalWorker?.postMessage({ type: "input_tick" });
      if (isRecording) {
        recordedInputs.push({
          t: performance.now() - recordStart,
          mouseX: inputView[INPUT_INDEX.mouseX],
          mouseY: inputView[INPUT_INDEX.mouseY],
          buttons: inputView[INPUT_INDEX.buttons],
          keyCode: vk,
          keyState: state,
          gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
          gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
          gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
          gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
          gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
          gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
          mouseWheel: inputView[INPUT_INDEX.mouseWheel] ?? 0,
        });
      }
    };


    const handleKeyDown = (event: KeyboardEvent) => handleKey(event, 1);
    const handleKeyUp = (event: KeyboardEvent) => handleKey(event, 0);

    const handlePointerDown = (event: PointerEvent) => {
      // Capture pointer to receive events even when cursor leaves canvas.
      // Guarded: throws InvalidStateError if the pointer was released before
      // this handler ran (fast tap, synthetic events, etc.) — safe to ignore.
      try { canvas.setPointerCapture(event.pointerId); } catch { }
      // A deliberate click on the canvas is the re-engage gesture: clear the Right-Ctrl
      // host-release suppression so lock can be re-acquired.
      userReleasedLockRef.current = false;
      // If cursor is hidden by guest, request pointer lock (user click = valid gesture)
      if (wantsPointerLockRef.current && !pointerLockedRef.current) {
        requestPointerLockSafe(canvas);
        // Still forward this click — before pointer lock is acquired, absolute coords
        // are still valid (pointermove has been syncing them). Without forwarding,
        // button state never reaches the SAB and the game never sees WM_LBUTTONDOWN.
        // Games like HoMM3 call ShowCursor(FALSE) to draw a custom cursor but still
        // rely on WndProc mouse messages for click handling.
      }
      void audioEngine?.resume();
      writePointer(event);
    };

    const handlePointerUp = (event: PointerEvent) => {
      // Release capture (usually automatic, but be explicit)
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      writePointer(event);
    };

    const handleContextMenu = (event: Event) => {
      event.preventDefault();
    };

    canvas.addEventListener("pointermove", writePointer);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerenter", handlePointerEnter);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("contextmenu", handleContextMenu);
    
    const handleWheel = (event: WheelEvent) => {
      const rect = canvasRectRef.current ?? canvas.getBoundingClientRect();
      const inputView = globalInputView;
      if (!inputView) return;

      const insideCanvas = event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!insideCanvas) return;

      const pointerSpace =
        GUEST_MOUSE_COORDS
          ? guestResolutionRef.current
          : resolutionRef.current;
      const width = Math.max(1, pointerSpace.width);
      const height = Math.max(1, pointerSpace.height);

      const scaleX = width / rect.width;
      const scaleY = height / rect.height;
      const x = Math.max(0, Math.min(width, (event.clientX - rect.left) * scaleX));
      const y = Math.max(0, Math.min(height, (event.clientY - rect.top) * scaleY));

      beginInputWrite(inputView);
      inputView[INPUT_INDEX.mouseX] = Math.round(x);
      inputView[INPUT_INDEX.mouseY] = Math.round(y);
      // Normalize deltaY to CSS pixel equivalent regardless of deltaMode:
      //   DOM_DELTA_PIXEL (0): use as-is (~100px per notch → InputManager * 1.2 ≈ 120 WHEEL_DELTA)
      //   DOM_DELTA_LINE  (1): ~33px per line; 3 lines/notch → 99px → * 1.2 ≈ 120
      //   DOM_DELTA_PAGE  (2): ~500px per page → * 1.2 = 600 = 5 notches (sensible for page-scroll)
      let pixelDelta: number;
      switch (event.deltaMode) {
        case 1: pixelDelta = event.deltaY * 33;  break; // DOM_DELTA_LINE
        case 2: pixelDelta = event.deltaY * 500; break; // DOM_DELTA_PAGE
        default: pixelDelta = event.deltaY;              // DOM_DELTA_PIXEL
      }
      inputView[INPUT_INDEX.mouseWheel] = Math.round(pixelDelta);
      endInputWrite(inputView);
      globalWorker?.postMessage({ type: "input_tick" });
      if (isRecording) {
        recordedInputs.push({
          t: performance.now() - recordStart,
          mouseX: inputView[INPUT_INDEX.mouseX],
          mouseY: inputView[INPUT_INDEX.mouseY],
          buttons: inputView[INPUT_INDEX.buttons],
          keyCode: inputView[INPUT_INDEX.keyCode],
          keyState: inputView[INPUT_INDEX.keyState],
          gamepadConnected: inputView[INPUT_INDEX.gamepadConnected],
          gamepadButtons: inputView[INPUT_INDEX.gamepadButtons],
          gamepadAxis0: inputView[INPUT_INDEX.gamepadAxis0],
          gamepadAxis1: inputView[INPUT_INDEX.gamepadAxis1],
          gamepadAxis2: inputView[INPUT_INDEX.gamepadAxis2],
          gamepadAxis3: inputView[INPUT_INDEX.gamepadAxis3],
          mouseWheel: inputView[INPUT_INDEX.mouseWheel],
        });
      }
      
      // Prevent default scrolling behavior when over canvas
      event.preventDefault();
    };
    
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    // Capture phase: Tab focus-navigation runs before bubble, so we must see keys while
    // pointer-locked before the browser moves focus off the canvas.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);

    // Pointer lock change: update locked state and seed virtual cursor from current position.
    // The click that engages pointer lock already wrote correct absolute coordinates to the
    // SAB (handlePointerDown calls writePointer before lock is acquired). Seeding virtualMouse
    // from those coordinates keeps the game cursor where the user clicked — matching real
    // Windows behavior where ShowCursor(FALSE) doesn't move the cursor. Seeding at screen
    // center would make LBUTTONUP jump to (width/2, height/2) mid-click (drag mismatch).
    const handlePointerLockChange = () => {
      pointerLockedRef.current = document.pointerLockElement === canvas;
      if (pointerLockedRef.current) {
        const iv = globalInputView;
        if (iv) {
          // Seed from the last absolute position already in the SAB
          virtualMouseRef.current = {
            x: iv[INPUT_INDEX.mouseX],
            y: iv[INPUT_INDEX.mouseY],
          };
        } else {
          // Fallback: center of guest resolution
          const guest = guestResolutionRef.current;
          virtualMouseRef.current = {
            x: Math.round(guest.width / 2),
            y: Math.round(guest.height / 2),
          };
        }
        // No SAB write needed — position hasn't changed
      } else {
        // Lock was lost (commonly ESC, which is also Unreal's menu key — the browser
        // force-exits lock on ESC). If the guest still wants relative mouse and the user did
        // NOT deliberately release via Right Ctrl, arm a re-acquire. handlePointerDown
        // re-requests on the next click (the reliable gesture); we also opportunistically
        // attempt on the next pointermove via writePointer.
        if (wantsPointerLockRef.current && !userReleasedLockRef.current) {
          // ESC force-exit briefly rejects re-acquire; cooldown gates the click/move retries.
          pointerLockCooldownRef.current = true;
          setTimeout(() => { pointerLockCooldownRef.current = false; }, 32);
        }
      }
    };
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    const unlockAudio = () => { void audioEngine?.resume(); };
    window.addEventListener("pointerdown", unlockAudio, { passive: true });

    // Clear all pressed keys on focus loss to prevent stuck keys
    const handleBlur = () => {
      pressedKeys.clear();
      const inputView = globalInputView;
      if (inputView) {
        beginInputWrite(inputView);
        syncKeyBitfield(inputView); // all zeros
        inputView[INPUT_INDEX.buttons] = 0; // mouse buttons too
        inputView[INPUT_INDEX.keyCode] = 0;
        inputView[INPUT_INDEX.keyState] = 0;
        endInputWrite(inputView);
        globalWorker?.postMessage({ type: "input_tick" });
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) handleBlur();
    };

    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    (window as any).loadApp = async (path: string) => {
      console.log(`BottleShip: Loading App from ${path}`);
      rotateLogFile(path.split(/[\\/]/).pop()?.replace(/\.wgb$/i, "") || "game");
      ensurePersistentStorageRequested();
      setErrorMessage(null); // Clear any previous errors
      setExitInfo(null); // Fresh load supersedes a prior exit/crash overlay
      audioEngine?.stopAll(); // Silence stale ring buffers from the previous game
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      canvasRef.current?.focus();
      const lower = path.toLowerCase();
      if (lower.endsWith(".wgb")) {
        setLoadingProgress({ phase: "loading", percent: 0, label: "" });
        globalWorker.postMessage({ type: "load_bundle", url: path });
        return;
      }
      try {
        const resp = await fetch(path);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }
        const buf = await resp.arrayBuffer();
        globalWorker.postMessage({
          type: "load_pe",
          data: new Uint8Array(buf)
        });
      } catch (e) {
        const errorMessage = `Failed to load app from ${path}: ${e instanceof Error ? e.message : String(e)}`;
        console.error("BottleShip:", errorMessage);
        setErrorMessage(errorMessage);
        setLoadingProgress(null);
      }
    };

    const applyInputSample = (sample: InputSample) => {
      const inputView = globalInputView;
      if (!inputView) return;
      beginInputWrite(inputView);
      inputView[INPUT_INDEX.mouseX] = sample.mouseX;
      inputView[INPUT_INDEX.mouseY] = sample.mouseY;
      inputView[INPUT_INDEX.buttons] = sample.buttons;
      inputView[INPUT_INDEX.keyCode] = sample.keyCode;
      inputView[INPUT_INDEX.keyState] = sample.keyState;
      inputView[INPUT_INDEX.gamepadConnected] = sample.gamepadConnected;
      inputView[INPUT_INDEX.gamepadButtons] = sample.gamepadButtons;
      inputView[INPUT_INDEX.gamepadAxis0] = sample.gamepadAxis0;
      inputView[INPUT_INDEX.gamepadAxis1] = sample.gamepadAxis1;
      inputView[INPUT_INDEX.gamepadAxis2] = sample.gamepadAxis2;
      inputView[INPUT_INDEX.gamepadAxis3] = sample.gamepadAxis3;
      inputView[INPUT_INDEX.mouseWheel] = sample.mouseWheel ?? 0;
      endInputWrite(inputView);
      globalWorker?.postMessage({ type: "input_tick" });
    };

    (window as any).startRecording = () => {
      recordedInputs = [];
      recordStart = performance.now();
      isRecording = true;
      console.log("BottleShip: Recording started");
    };

    (window as any).stopRecording = () => {
      isRecording = false;
      console.log(`BottleShip: Recording stopped (${recordedInputs.length} samples)`);
      return recordedInputs.slice();
    };

    (window as any).playRecording = (recording: InputSample[], options?: { deterministic?: boolean }) => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      if (!recording || recording.length === 0) {
        console.warn("BottleShip: No recording provided");
        return;
      }

      const deterministic = options?.deterministic ?? true;
      const sorted = [...recording].sort((a, b) => a.t - b.t);
      const baseTime = sorted[0]?.t ?? 0;
      let index = 0;
      let timeoutId: number | null = null;

      const finishReplay = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (deterministic) {
          globalWorker?.postMessage({ type: "time_mode", mode: "realtime" });
          globalWorker?.postMessage({ type: "replay_mode", enabled: false });
        }
      };

      const scheduleNext = () => {
        if (index >= sorted.length) {
          finishReplay();
          return;
        }

        const sample = sorted[index];
        const relativeTime = Math.max(0, sample.t - baseTime);
        if (deterministic) {
          globalWorker?.postMessage({ type: "time_set", nowMs: relativeTime });
        }
        applyInputSample(sample);
        index++;

        if (index >= sorted.length) {
          finishReplay();
          return;
        }

        const delay = Math.max(0, sorted[index].t - sample.t);
        timeoutId = window.setTimeout(scheduleNext, delay);
      };

      if (deterministic) {
        globalWorker.postMessage({ type: "time_mode", mode: "manual", nowMs: 0, unixMs: Date.now() });
        globalWorker.postMessage({ type: "replay_mode", enabled: true });
      }

      scheduleNext();
    };

    (window as any).captureFrame = async () => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      if (capturePending) {
        console.warn("BottleShip: Capture already in progress");
        return;
      }
      const capturePromise = new Promise<Blob>((resolve, reject) => {
        capturePending = { resolve, reject };
      });
      globalWorker.postMessage({ type: "capture_frame" });
      try {
        const blob = await capturePromise;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "frame.png";
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("BottleShip: Capture failed", err);
      }
    };

    (window as any).renderStats = async () => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      if (statsPending) {
        console.warn("BottleShip: Stats request already in progress");
        return;
      }
      const statsPromise = new Promise<Record<string, number>>((resolve, reject) => {
        statsPending = { resolve, reject };
      });
      globalWorker.postMessage({ type: "render_stats" });
      try {
        const stats = await statsPromise;
        console.log("BottleShip: Render stats", stats);
      } catch (err) {
        console.error("BottleShip: Stats failed", err);
      }
    };

    const postMsgTimerDiag = (payload: Record<string, unknown>, legacy = false) => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      globalWorker.postMessage({ type: legacy ? "h3_timer_diag" : "msg_timer_diag", ...payload });
    };
    const postUiGateDiag = (payload: Record<string, unknown>, legacy = false) => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      globalWorker.postMessage({ type: legacy ? "h3_gate_diag" : "ui_gate_diag", ...payload });
    };

    const bindTimerDiagApi = (prefix: string, legacy: boolean) => {
      (window as any)[`${prefix}SetEnabled`] = (enabled: boolean = true) => {
        postMsgTimerDiag({ enabled: Boolean(enabled) }, legacy);
      };
      (window as any)[`${prefix}SetIntervalMs`] = (logIntervalMs: number = 500) => {
        postMsgTimerDiag({ logIntervalMs: Number(logIntervalMs) }, legacy);
      };
      (window as any)[`${prefix}SetQueueSkipped`] = (queueSkipped: boolean = true) => {
        postMsgTimerDiag({ queueSkipped: Boolean(queueSkipped) }, legacy);
      };
      (window as any)[`${prefix}SetFlushMax`] = (flushMax: number = 4) => {
        postMsgTimerDiag({ flushMax: Number(flushMax) }, legacy);
      };
      (window as any)[`${prefix}GetConfig`] = () => {
        postMsgTimerDiag({}, legacy);
      };
      (window as any)[`${prefix}LogNow`] = () => {
        postMsgTimerDiag({ logNow: true }, legacy);
      };
    };
    bindTimerDiagApi("msgTimerDiag", false);
    bindTimerDiagApi("h3TimerDiag", true); // deprecated alias

    const bindUiGateDiagApi = (prefix: string, legacy: boolean) => {
      (window as any)[`${prefix}SetForceScreenObj`] = (enabled: boolean = true) => {
        postUiGateDiag({ forceScreenObjFallback: Boolean(enabled) }, legacy);
      };
      (window as any)[`${prefix}SetForceAdvMap`] = (enabled: boolean = true) => {
        postUiGateDiag({ forceAdvMapFallback: Boolean(enabled) }, legacy);
      };
      (window as any)[`${prefix}SetForceGameScreenChildList`] = (enabled: boolean = true) => {
        postUiGateDiag({ forceGameScreenChildListFallback: Boolean(enabled) }, legacy);
      };
      (window as any)[`${prefix}GetConfig`] = () => {
        postUiGateDiag({}, legacy);
      };
    };
    bindUiGateDiagApi("uiGateDiag", false);
    bindUiGateDiagApi("h3GateDiag", true); // deprecated alias

    (window as any).enableVerboseLogCapture = (enabled: boolean = true) => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      globalWorker.postMessage({ type: "log_verbose_enable", enabled });
    };

    const requestVerboseLogExport = () => {
      if (!globalWorker) {
        return Promise.reject(new Error("Worker not initialized"));
      }
      if (verboseLogPending) {
        return Promise.reject(new Error("Log export already in progress"));
      }
      const promise = new Promise<string>((resolve, reject) => {
        verboseLogPending = { resolve, reject };
      });
      globalWorker.postMessage({ type: "log_verbose_export" });
      return promise;
    };

    const downloadVerboseLog = async () => {
      try {
        const text = await requestVerboseLogExport();
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "bottleship-verbose.log";
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("BottleShip: Log export failed", err);
      }
    };

    (window as any).downloadVerboseLog = downloadVerboseLog;

    const clearVerboseLog = () => {
      if (!globalWorker) {
        console.error("BottleShip: Worker not initialized");
        return;
      }
      globalWorker.postMessage({ type: "log_verbose_clear" });
    };

    (window as any).clearVerboseLog = clearVerboseLog;

    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      document.removeEventListener("fullscreenchange", resize);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointermove", writePointer);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointerenter", handlePointerEnter);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("pointerlockchange", handlePointerLockChange);
      // Keep loadApp exposed for buttons
    };
    // Deps are mount-stable only. Pause/load/worker-ready are read via refs
    // (isPausedRef) or module globals (globalWorker), NOT captured here — so a
    // pause or load_bundle does not tear down and recreate the worker wiring,
    // audio engine, input listeners, and window API.
  }, [browserSupport.supported, sabAvailable, isolated]);

  useEffect(() => {
    // Keyboard Lock: while fullscreen, capture Escape so it reaches the guest as the
    // in-game menu key instead of the browser consuming it to exit fullscreen. The UA
    // still honors a long-press Escape to leave fullscreen, so this is not a trap.
    const kb = (navigator as Navigator & {
      keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
    }).keyboard;

    const syncFullscreenState = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const fs = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
      // Unsupported / not granted → ESC keeps exiting fullscreen, same as before.
      if (fs) kb?.lock?.(["Escape"]).catch(() => { /* best-effort */ });
      else kb?.unlock?.();
    };

    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState as EventListener);
    syncFullscreenState();

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState as EventListener);
      kb?.unlock?.();
    };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const panel = panelRef.current;
    const target = panel ?? canvasRef.current;
    if (!target) return;

    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const element = target as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };

    try {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else {
          await doc.webkitExitFullscreen?.();
        }
        return;
      }

      if (target.requestFullscreen) {
        await target.requestFullscreen();
      } else {
        await element.webkitRequestFullscreen?.();
      }
    } catch (err) {
      setErrorMessage(`Fullscreen failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);
  toggleFullscreenRef.current = () => {
    void toggleFullscreen();
  };

  if (!browserSupport.supported) {
    return (
      <div className={s["app__notice"]}>
        <div className={s["app__notice-card"]}>
          <h1>Unsupported browser</h1>
          <p>{browserUnsupportedMessage}</p>
        </div>
      </div>
    );
  }

  if (webgpuProbe && !webgpuProbe.ok) {
    return <WebGPUErrorOverlay probe={webgpuProbe} detectedBrowser={browserSupport.detectedBrowser} variant="page" />;
  }

  return (
    <div className={s["app"]}>
      <section className={s["app__panel"]} ref={panelRef}>
        <canvas ref={canvasRef} tabIndex={-1} className={s["app__canvas"]} style={{ ["--guest-w" as string]: guestResolution.width, ["--guest-h" as string]: guestResolution.height } as React.CSSProperties} />
        {loadingProgress && !errorMessage && !exitInfo && (
          <div className={cx(s, "loading-overlay", loadingProgress.fadingOut && "loading-overlay--done")}>
            <div className={cx(s, "loading-overlay__bar-wrap", loadingProgress.indeterminate && "is-indeterminate")}>
              <div className={s["loading-overlay__bar"]} style={loadingProgress.indeterminate ? undefined : { width: `${loadingProgress.percent}%` }} />
            </div>
          </div>
        )}
        {!sabAvailable || !isolated ? (
          <div className={s["app__warning"]}>
            <p>SharedArrayBuffer requires COOP/COEP headers and cross-origin isolation.</p>
            {!secureContext && <p>Current context is not secure. Use https:// or localhost.</p>}
            <p>Check the dev server headers and reload the page.</p>
          </div>
        ) : null}
        <ExitOverlay exitInfo={exitInfo} errorMessage={errorMessage} gameName={GAME_NAME} onDismissError={() => setErrorMessage(null)} />
      </section>
      {messageBox && <MessageBoxModal messageBox={messageBox} onClose={() => setMessageBox(null)} />}
    </div>
  );
}
