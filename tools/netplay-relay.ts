#!/usr/bin/env bun
/**
 * netplay-relay — the "LAN switch" for BottleShip netplay. Each browser tab is one node on a
 * virtual IPX network; tabs that join the same room share a broadcast domain. The relay only
 * forwards datagrams (src/worker/net/netplay-wire.ts), stamping the sender's node on each one.
 *
 *   bun tools/netplay-relay.ts [--port 3002]
 *
 * Players connect to ws://<host>:3002/netplay/<room>; the page derives that from its own URL:
 *   http://<host>:5174/?game=dev&load=/apps/starcraft_demo.wgb&room=<room>
 */

import type { ServerWebSocket } from "bun";
import { NODE_LEN, WIRE_DGRAM, WIRE_JOIN, isBroadcastNode, nodeKey } from "../src/worker/net/netplay-wire";

const portArg = process.argv.indexOf("--port");
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.NETPLAY_PORT ?? 3002);
const MAX_PEERS = 16;
const MAX_FRAME = 2048;

interface Peer { room: string; node: Uint8Array | null; key: string }
const rooms = new Map<string, Map<string, ServerWebSocket<Peer>>>();

function roomOf(ws: ServerWebSocket<Peer>): Map<string, ServerWebSocket<Peer>> {
    let r = rooms.get(ws.data.room);
    if (!r) rooms.set(ws.data.room, (r = new Map()));
    return r;
}

function join(ws: ServerWebSocket<Peer>, node: Uint8Array): void {
    const room = roomOf(ws);
    const key = nodeKey(node);
    if (room.has(key)) { ws.close(4001, "node address in use"); return; }
    if (room.size >= MAX_PEERS) { ws.close(4002, "room full"); return; }
    ws.data.node = node.slice();
    ws.data.key = key;
    room.set(key, ws);
    console.log(`[relay] ${ws.data.room}: +${key} (${room.size} peers)`);
}

function forward(ws: ServerWebSocket<Peer>, frame: Uint8Array): void {
    const room = roomOf(ws);
    const dst = frame.slice(2, 2 + NODE_LEN);
    const out = frame.slice();
    out.set(ws.data.node!, 2);
    if (isBroadcastNode(dst)) {
        for (const [key, peer] of room) if (key !== ws.data.key) peer.send(out);
        return;
    }
    room.get(nodeKey(dst))?.send(out);
}

const server = Bun.serve<Peer>({
    port: PORT,
    fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/health") return Response.json({ ok: true, rooms: Object.fromEntries([...rooms].map(([k, v]) => [k, v.size])) });
        const room = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
        if (!room || room === "netplay") return new Response("room required: /netplay/<room>", { status: 400 });
        if (srv.upgrade(req, { data: { room, node: null, key: "" } })) return undefined;
        return new Response("websocket upgrade expected", { status: 426 });
    },
    websocket: {
        message(ws, msg) {
            if (typeof msg === "string" || msg.length > MAX_FRAME || msg.length < 1) return;
            const frame = new Uint8Array(msg);
            if (!ws.data.node) {
                if (frame[0] === WIRE_JOIN && frame.length === 1 + NODE_LEN) join(ws, frame.subarray(1));
                return;
            }
            if (frame[0] === WIRE_DGRAM && frame.length >= 12) forward(ws, frame);
        },
        close(ws) {
            const room = rooms.get(ws.data.room);
            if (!room || !ws.data.node || room.get(ws.data.key) !== ws) return;
            room.delete(ws.data.key);
            console.log(`[relay] ${ws.data.room}: -${ws.data.key} (${room.size} peers)`);
            if (room.size === 0) rooms.delete(ws.data.room);
        },
    },
});

console.log(`[relay] netplay relay listening on :${server.port}`);
