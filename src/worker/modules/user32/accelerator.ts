/**
 * User32 keyboard accelerators: accelerator tables (created from ACCEL arrays or loaded from an
 * RT_ACCELERATOR resource) and TranslateAccelerator, which turns a matching keystroke into a
 * WM_COMMAND sent synchronously to the window procedure — how games bind Ctrl/Shift+key hotkeys.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import { findResourceInPE } from '../kernel32/resource';
import { getWindowByHandle } from './window';
import { invokeGuestWndProcSync } from './message';

const RT_ACCELERATOR = 9;
const FVIRTKEY = 0x01;
const FSHIFT = 0x04;
const FCONTROL = 0x08;
const FALT = 0x10;
const ACCEL_SIZE = 6;
const RES_ENTRY_SIZE = 8;
const RES_LAST_ENTRY = 0x80;

const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSCHAR = 0x0106;
const WM_COMMAND = 0x0111;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;

interface Accel { fVirt: number; key: number; cmd: number }

const tables = new Map<number, Accel[]>();
let nextHandle = 0x1acc0001;

function addTable(entries: Accel[]): number {
    const h = nextHandle++;
    tables.set(h, entries);
    return h;
}

function readAccelArray(mem: Uint8Array, ptr: number, count: number): Accel[] {
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const out: Accel[] = [];
    for (let i = 0; i < count; i++) {
        const p = ptr + i * ACCEL_SIZE;
        out.push({ fVirt: mem[p], key: v.getUint16(p + 2, true), cmd: v.getUint16(p + 4, true) });
    }
    return out;
}

/** RT_ACCELERATOR resource: {WORD fFlags; WORD wAnsi; WORD wId; WORD pad}[], 0x80 in fFlags marks the last. */
function parseAccelResource(mem: Uint8Array, addr: number, size: number): Accel[] {
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const out: Accel[] = [];
    for (let off = 0; off + RES_ENTRY_SIZE <= size; off += RES_ENTRY_SIZE) {
        const flags = v.getUint16(addr + off, true);
        out.push({ fVirt: flags & 0x7f, key: v.getUint16(addr + off + 2, true), cmd: v.getUint16(addr + off + 4, true) });
        if (flags & RES_LAST_ENTRY) break;
    }
    return out;
}

function matches(a: Accel, message: number, key: number, lParam: number): boolean {
    const im = System.getInstance().inputManager;
    const down = (vk: number) => (im.getKeyState(vk) & 0x8000) !== 0;
    const alt = message === WM_SYSKEYDOWN || message === WM_SYSCHAR ? ((lParam >>> 29) & 1) === 1 || down(VK_MENU) : down(VK_MENU);
    if (a.fVirt & FVIRTKEY) {
        if (message !== WM_KEYDOWN && message !== WM_SYSKEYDOWN) return false;
        if (a.key !== (key & 0xff)) return false;
        return down(VK_SHIFT) === !!(a.fVirt & FSHIFT) && down(VK_CONTROL) === !!(a.fVirt & FCONTROL) && alt === !!(a.fVirt & FALT);
    }
    if (message !== WM_CHAR && message !== WM_SYSCHAR) return false;
    return a.key === (key & 0xffff) && alt === !!(a.fVirt & FALT);
}

export function createAcceleratorExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['CreateAcceleratorTableA'] = exports['CreateAcceleratorTableW'] = (_ctx, mem, args) => {
        const lpaccl = args[0] >>> 0;
        const cEntries = args[1] | 0;
        if (!lpaccl || cEntries <= 0) return 0;
        return addTable(readAccelArray(mem, lpaccl, cEntries));
    };

    const loadAccelerators = (wide: boolean): ThunkImplementation => (_ctx, mem, args) => {
        const hInstance = args[0] >>> 0;
        const lpTableName = args[1] >>> 0;
        const name: number | string = lpTableName < 0x10000
            ? lpTableName
            : (wide ? Marshaler.readWideString(mem, lpTableName) : Marshaler.readString(mem, lpTableName));
        const entry = findResourceInPE(mem, hInstance || 0x00400000, RT_ACCELERATOR, name);
        if (!entry) {
            Logger.warn(LogCategory.USER32, `LoadAccelerators(0x${hInstance.toString(16)}, ${JSON.stringify(name)}): resource not found`);
            return 0;
        }
        return addTable(parseAccelResource(mem, entry.moduleBase + entry.dataRVA, entry.size));
    };
    exports['LoadAcceleratorsA'] = loadAccelerators(false);
    exports['LoadAcceleratorsW'] = loadAccelerators(true);

    exports['CopyAcceleratorTableA'] = exports['CopyAcceleratorTableW'] = (_ctx, mem, args) => {
        const table = tables.get(args[0] >>> 0);
        const dst = args[1] >>> 0;
        const count = args[2] | 0;
        if (!table) return 0;
        if (!dst) return table.length;
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const n = Math.min(count, table.length);
        for (let i = 0; i < n; i++) {
            const p = dst + i * ACCEL_SIZE;
            mem[p] = table[i].fVirt;
            mem[p + 1] = 0;
            v.setUint16(p + 2, table[i].key, true);
            v.setUint16(p + 4, table[i].cmd, true);
        }
        return n;
    };

    exports['DestroyAcceleratorTable'] = (_ctx, _mem, args) => (tables.delete(args[0] >>> 0) ? 1 : 0);

    exports['TranslateAcceleratorA'] = exports['TranslateAcceleratorW'] = (ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const table = tables.get(args[1] >>> 0);
        const lpMsg = args[2] >>> 0;
        if (!table || !lpMsg || !hWnd) return 0;
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const message = v.getUint32(lpMsg + 4, true);
        if (message !== WM_KEYDOWN && message !== WM_SYSKEYDOWN && message !== WM_CHAR && message !== WM_SYSCHAR) return 0;
        const key = v.getUint32(lpMsg + 8, true);
        const lParam = v.getUint32(lpMsg + 12, true);
        const hit = table.find((a) => matches(a, message, key, lParam));
        if (!hit) return 0;

        const win = getWindowByHandle(hWnd);
        if (!win?.wndProc) return 1;
        const wParam = (hit.cmd | (1 << 16)) >>> 0;
        return invokeGuestWndProcSync(ctx, mem, win.wndProc, hWnd, WM_COMMAND, wParam, 0, 12, 'TranslateAccelerator', () => 1) ?? 1;
    };

    return exports;
}
