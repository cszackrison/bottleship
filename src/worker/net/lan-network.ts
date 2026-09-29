/**
 * Virtual LAN adapter. One per worker (= one "machine" on the LAN): owns this node's address and
 * the per-protocol (IPX socket number / UDP port) → endpoint bindings, and routes datagrams through
 * a transport (the netplay relay). With no transport attached the machine is alone on its LAN —
 * sends go nowhere, exactly like a PC with no other hosts.
 *
 * The node doubles as the IPX node number and the IPv4 host: node 02:00:00:a:b:c is 10.a.b.c on
 * 10.0.0.0/8, so UDP unicast routes by the same relay addressing as IPX.
 *
 * Broadcasts are not looped back to the sending node.
 */

import { BROADCAST_NODE, NODE_LEN, PROTO_IPX, PROTO_UDP, decodeDatagram, encodeDatagram, isBroadcastNode } from "./netplay-wire";

export interface LanDatagram { srcNode: Uint8Array; srcPort: number; data: Uint8Array }
export interface LanEndpoint { deliver(dg: LanDatagram): void }
export interface NetTransport { send(frame: Uint8Array<ArrayBuffer>): void; close(): void }

export const IPX_NETNUM = new Uint8Array([0, 0, 0, 1]);
/** Max IPX payload: 576-byte IPX packet minus the 30-byte header. */
export const IPX_MAX_PAYLOAD = 546;
/** Max UDP payload over IPv4: 65535 − 20 (IP) − 8 (UDP). */
export const UDP_MAX_PAYLOAD = 65507;
export const LAN_NET_OCTET = 10;
const PROTOS = [PROTO_IPX, PROTO_UDP];
const EPHEMERAL = [[0x4000, 0x7fff], [49152, 65535]];

/** IPv4 bytes (network order) of a LAN node. */
export function nodeToIpv4(node: Uint8Array): Uint8Array {
    return new Uint8Array([LAN_NET_OCTET, node[3], node[4], node[5]]);
}

export function ipv4ToNode(ip: Uint8Array): Uint8Array {
    return new Uint8Array([0x02, 0, 0, ip[1], ip[2], ip[3]]);
}

function randomNode(): Uint8Array {
    const n = new Uint8Array(NODE_LEN);
    n[0] = 0x02;
    do crypto.getRandomValues(n.subarray(3)); while ((n[3] | n[4] | n[5]) === 0 || (n[3] & n[4] & n[5]) === 0xff);
    return n;
}

export class LanNetwork {
    readonly node: Uint8Array;
    private ports = PROTOS.map(() => new Map<number, LanEndpoint>());
    private nextEphemeral = EPHEMERAL.map(([lo]) => lo);
    private transport: NetTransport | null = null;
    stats = { sent: 0, received: 0, dropped: 0 };

    constructor(node?: Uint8Array) { this.node = node ?? randomNode(); }

    get ipv4(): Uint8Array { return nodeToIpv4(this.node); }

    attach(transport: NetTransport | null): void {
        this.transport?.close();
        this.transport = transport;
    }

    get connected(): boolean { return this.transport !== null; }

    isBound(port: number, proto = PROTO_IPX): boolean { return this.ports[proto].has(port & 0xffff); }

    bind(port: number, ep: LanEndpoint, proto = PROTO_IPX): boolean {
        port &= 0xffff;
        if (this.ports[proto].has(port)) return false;
        this.ports[proto].set(port, ep);
        return true;
    }

    bindEphemeral(ep: LanEndpoint, proto = PROTO_IPX): number {
        const [lo, hi] = EPHEMERAL[proto];
        for (let i = 0; i <= hi - lo; i++) {
            const p = this.nextEphemeral[proto];
            this.nextEphemeral[proto] = p >= hi ? lo : p + 1;
            if (this.bind(p, ep, proto)) return p;
        }
        return 0;
    }

    unbind(port: number, ep: LanEndpoint, proto = PROTO_IPX): void {
        if (this.ports[proto].get(port & 0xffff) === ep) this.ports[proto].delete(port & 0xffff);
    }

    send(srcPort: number, dstNode: Uint8Array, dstPort: number, data: Uint8Array, proto = PROTO_IPX): void {
        this.stats.sent++;
        if (!isBroadcastNode(dstNode) && this.isSelf(dstNode)) {
            this.deliverLocal(proto, this.node, srcPort, dstPort, data.slice());
            return;
        }
        this.transport?.send(encodeDatagram(proto, isBroadcastNode(dstNode) ? BROADCAST_NODE : dstNode, dstPort, srcPort, data));
    }

    /** Frame from the transport; the node field is the sender. */
    receiveFrame(frame: Uint8Array): void {
        const dg = decodeDatagram(frame);
        if (!dg || !PROTOS.includes(dg.proto) || this.isSelf(dg.node)) return;
        this.deliverLocal(dg.proto, dg.node.slice(), dg.srcPort, dg.dstPort, dg.payload.slice());
    }

    reset(): void {
        for (const m of this.ports) m.clear();
        this.nextEphemeral = EPHEMERAL.map(([lo]) => lo);
    }

    isSelf(node: Uint8Array): boolean {
        for (let i = 0; i < NODE_LEN; i++) if (node[i] !== this.node[i]) return false;
        return true;
    }

    private deliverLocal(proto: number, srcNode: Uint8Array, srcPort: number, dstPort: number, data: Uint8Array): void {
        const ep = this.ports[proto].get(dstPort);
        if (!ep) { this.stats.dropped++; return; }
        this.stats.received++;
        ep.deliver({ srcNode, srcPort, data });
    }
}

export const lanNetwork = new LanNetwork();
