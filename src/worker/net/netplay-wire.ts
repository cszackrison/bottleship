/**
 * Netplay relay wire format — shared by the worker link and tools/netplay-relay.ts.
 *
 *   Join     client→relay  [JOIN][node:6]
 *   Datagram both ways     [DGRAM][proto][node:6][dstPort:2 BE][srcPort:2 BE][payload…]
 *
 * proto: PROTO_IPX (ports = IPX socket numbers) or PROTO_UDP (ports = UDP ports).
 * In a client→relay datagram `node` is the destination (FF×6 = broadcast); the relay rewrites it
 * to the sender's node before forwarding, so a received datagram always names its source.
 */

export const WIRE_JOIN = 1;
export const WIRE_DGRAM = 2;
export const PROTO_IPX = 0;
export const PROTO_UDP = 1;
export const DGRAM_HEADER = 12;
export const NODE_LEN = 6;
export const BROADCAST_NODE = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export function isBroadcastNode(node: Uint8Array): boolean {
    for (let i = 0; i < NODE_LEN; i++) if (node[i] !== 0xff) return false;
    return true;
}

export function nodeKey(node: Uint8Array): string {
    let s = "";
    for (let i = 0; i < NODE_LEN; i++) s += node[i].toString(16).padStart(2, "0");
    return s;
}

export function encodeJoin(node: Uint8Array): Uint8Array<ArrayBuffer> {
    const f = new Uint8Array(1 + NODE_LEN);
    f[0] = WIRE_JOIN;
    f.set(node.subarray(0, NODE_LEN), 1);
    return f;
}

export function encodeDatagram(proto: number, node: Uint8Array, dstPort: number, srcPort: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    const f = new Uint8Array(DGRAM_HEADER + payload.length);
    f[0] = WIRE_DGRAM;
    f[1] = proto;
    f.set(node.subarray(0, NODE_LEN), 2);
    f[8] = (dstPort >>> 8) & 0xff; f[9] = dstPort & 0xff;
    f[10] = (srcPort >>> 8) & 0xff; f[11] = srcPort & 0xff;
    f.set(payload, DGRAM_HEADER);
    return f;
}

export interface DecodedDatagram { proto: number; node: Uint8Array; dstPort: number; srcPort: number; payload: Uint8Array }

export function decodeDatagram(f: Uint8Array): DecodedDatagram | null {
    if (f.length < DGRAM_HEADER || f[0] !== WIRE_DGRAM) return null;
    return { proto: f[1], node: f.subarray(2, 8), dstPort: (f[8] << 8) | f[9], srcPort: (f[10] << 8) | f[11], payload: f.subarray(DGRAM_HEADER) };
}
