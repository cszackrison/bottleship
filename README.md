# BottleShip — StarCraft

StarCraft in the browser, with LAN-style multiplayer between tabs or machines.

This is a single-game build of [BottleShip](https://github.com/jenissimo/bottleship), which runs
real x86 Windows executables in the browser by reimplementing Win32 / DirectDraw / DirectSound
on top of WebGPU, WebAudio and OPFS. The page boots straight into StarCraft and scales it to fill
the window at the game's aspect ratio.

## Run locally

Requirements: [Bun](https://bun.sh/), and a browser with WebGPU (Chrome / Edge 113+) and
SharedArrayBuffer.

```bash
bun install
bun run dev          # game at http://localhost:5174
bun run dev:netplay  # multiplayer relay on :3002
```

The game bundle is not in git: put `starcraft_demo.wgb` in `public/apps/`
(build one from a game folder with `bun tools/make-wgb.ts <game-dir> public/apps/starcraft_demo.wgb --exe StarCraft.exe`).

## Multiplayer

Open the game in two or more tabs (or on other machines on your network) with the same room:

```
http://<host>:5174/?room=<name>
```

Everyone in a room shares one virtual IPX network, so pick **IPX** under Multiplayer in the game.
The relay defaults to port 3002 on the page's host; override it with `&relay=ws://host:port/netplay`
or the `VITE_NETPLAY_RELAY` build variable. `curl localhost:3002/health` lists rooms and peer counts.

F11 toggles fullscreen.

## How it works

BottleShip doesn't boot Windows. It loads the game's PE executable into a 4 GB guest address
space, runs its x86 code through a fork of [v86](https://github.com/copy/v86), and intercepts
every imported Win32 and DirectX call. Winsock IPX sockets are routed through a per-tab virtual
IPX node and a WebSocket relay (`tools/netplay-relay.ts`).

- [Architecture](docs/architecture.md) · [Bundles](docs/bundles.md) · [Development](docs/development.md) · [Automation harness](docs/harness.md)

## License & acknowledgements

Licensed under [Apache-2.0](LICENSE). Based on [BottleShip](https://github.com/jenissimo/bottleship)
and a fork of [v86](https://github.com/copy/v86) (BSD-2); other bundled components and their
notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

**No commercial game files are distributed.** Bring your own legally-owned copy.
