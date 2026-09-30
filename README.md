# BottleShip — StarCraft

StarCraft: Brood War in the browser, with LAN-style multiplayer between tabs or machines and a
curated library of classic custom (UMS) maps.

This is a StarCraft-focused fork of [BottleShip](https://github.com/jenissimo/bottleship), an
engine that runs real x86 Windows executables in the browser by reimplementing Win32 / DirectDraw /
DirectSound on top of WebGPU, WebAudio and OPFS. Upstream is a general-purpose game library; this
fork narrows it to one game and tunes everything around playing StarCraft well: the page boots
straight into Brood War, scales it to fill the window at the game's aspect ratio, and adds netplay,
input and map tooling that upstream doesn't have.

## Run locally

Requirements: [Bun](https://bun.sh/), and a browser with WebGPU (Chrome / Edge 113+) and
SharedArrayBuffer.

```bash
bun install
bun run dev          # game at http://localhost:5174
bun run dev:netplay  # multiplayer relay on :3002
```

The game bundle is not in git: put `starcraft_retail.wgb` (StarCraft + Brood War) in `public/apps/`
(build one from a game folder with `bun tools/make-wgb.ts <game-dir> public/apps/starcraft_retail.wgb --exe StarCraft.exe`).

F11 toggles fullscreen. The mouse is captured with pointer lock so edge-scrolling and the game's
own cursor confinement behave like the desktop game.

## Multiplayer

Open the game in two or more tabs (or on other machines on your network) with the same room:

```
http://<host>:5174/?room=<name>
```

Everyone in a room shares one virtual IPX network, so pick **IPX** under Multiplayer in the game.
The relay defaults to port 3002 on the page's host; override it with `&relay=ws://host:port/netplay`
or the `VITE_NETPLAY_RELAY` build variable. `curl localhost:3002/health` lists rooms and peer counts.

## Custom maps

`tools/scmscx.ts` is a command-line client for [scmscx.com](https://scmscx.com/), a searchable
archive of 250k+ StarCraft maps. It talks to the site's JSON API directly, so you can search,
filter and download without the web UI. Downloads are verified against the site's sha256.

```bash
bun tools/scmscx.ts search "lost temple" --players 4 --tileset jungle --details --classic --no-eud
bun tools/scmscx.ts info <id>
bun tools/scmscx.ts download <id...> --out maps
bun tools/scmscx.ts fetch "tower defense" --limit 25 --classic --out maps   # search + download
```

`--classic` drops Remastered-only maps (they won't load in 1.16.1), `--no-eud` drops maps that
rely on memory-editing triggers, and `--details` shows version, size, tileset, triggers, downloads
and views.

`tools/scmscx-ums.txt` pins 45 classics (Fastest Possible Map, Turret Defense, Marine Special
Forces, Zone Control, Golem Madness, Pokémon RPG, …): English, 1.16.1-compatible, and the
most-downloaded version of each. Build a bundle with them under `Maps\UMS`:

```bash
bun tools/scmscx.ts bundle tools/scmscx-ums.txt public/apps/starcraft_retail.wgb public/apps/starcraft_ums.wgb
```

To play it, open `http://localhost:5174/?game=dev` and run
`window.loadApp('/apps/starcraft_ums.wgb')` in the console, then choose **Use Map Settings** and
the `UMS` folder when creating a game. To add a map, append its scmscx id and a filename to the
list and rebuild.

## What this fork changes

- **Single-game app** — boots Brood War by default, fills the window, one progress bar while loading.
- **Netplay** — IPX and UDP over a WebSocket relay (`tools/netplay-relay.ts`), one virtual network per room.
- **Input** — pointer lock with edge pinning, `ClipCursor` confinement, double-clicks, key
  auto-repeat, keyboard accelerators, and Ctrl/Alt+digit kept in the game instead of switching tabs.
- **Maps** — the scmscx client and curated UMS list above.

Generic emulation fixes found while bringing StarCraft up (user32 timers, `MsgWaitForMultipleObjects`,
`FindFirstFile`, DirectDraw palettes, …) are written against the real Win32 behavior, not as
StarCraft-specific hacks, so they're candidates to send upstream.

To pull in upstream engine work: `git pull origin main` (`origin` is jenissimo/bottleship; this
fork lives at [cszackrison/bottleship](https://github.com/cszackrison/bottleship)).

## How it works

BottleShip doesn't boot Windows. It loads the game's PE executable into a 4 GB guest address
space, runs its x86 code through a fork of [v86](https://github.com/copy/v86), and intercepts
every imported Win32 and DirectX call. Winsock IPX sockets are routed through a per-tab virtual
IPX node and the WebSocket relay.

- [Architecture](docs/architecture.md) · [Bundles](docs/bundles.md) · [Development](docs/development.md) · [Automation harness](docs/harness.md)

## License & acknowledgements

Licensed under [Apache-2.0](LICENSE). Based on [BottleShip](https://github.com/jenissimo/bottleship)
and a fork of [v86](https://github.com/copy/v86) (BSD-2); other bundled components and their
notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Custom maps are fetched from
[scmscx.com](https://scmscx.com/) and belong to their authors; none are stored in this repo.

**No commercial game files are distributed.** Bring your own legally-owned copy.
