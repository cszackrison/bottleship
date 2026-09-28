/**
 * Virtual IPX network adapter. One per worker (= one "machine" on the LAN): owns this node's
 * address and the socket-number → endpoint bindings, and routes datagrams through a transport
 * (the netplay relay). With no transport attached the machine is alone on its LAN — sends go
 * nowhere, exactly like a PC with no other hosts.
 *
 * Broadcasts are not looped back to the sending node.
 */

import { BROADCAST_NODE, NODE_LEN, PROTO_IPX, decodeDatagram, encodeDatagram, isBroadcastNode } from "./netplay-wire";

export interface IpxDatagram { srcNode: Uint8Array; srcPort: number; data: Uint8Array }
export interface IpxEndpoint { deliver(dg: IpxDatagram): void }
export interface NetTransport { send(frame: Uint8Array<ArrayBuffer>): void; close(): void }

export const IPX_NETNUM = new Uint8Array([0, 0, 0, 1]);
/** Max IPX payload: 576-byte IPX packet minus the 30-byte header. */
export const IPX_MAX_PAYLOAD = 546;
const EPHEMERAL_LO = 0x4000, EPHEMERAL_HI = 0x7fff;

function randomNode(): Uint8Array {
    const n = new Uint8Array(NODE_LEN);
    crypto.getRandomValues(n);
    n[0] = (n[0] & 0xfc) | 0x02;
    return n;
}

export class IpxNetwork {
    readonly node: Uint8Array;
    private ports = new Map<number, IpxEndpoint>();
    private nextEphemeral = EPHEMERAL_LO;
    private transport: NetTransport | null = null;
    stats = { sent: 0, received: 0, dropped: 0 };

    constructor(node?: Uint8Array) { this.node = node ?? randomNode(); }

    attach(transport: NetTransport | null): void {
        this.transport?.close();
        this.transport = transport;
    }

    get connected(): boolean { return this.transport !== null; }

    isBound(port: number): boolean { return this.ports.has(port & 0xffff); }

    bind(port: number, ep: IpxEndpoint): boolean {
        port &= 0xffff;
        if (this.ports.has(port)) return false;
        this.ports.set(port, ep);
        return true;
    }

    bindEphemeral(ep: IpxEndpoint): number {
        for (let i = 0; i <= EPHEMERAL_HI - EPHEMERAL_LO; i++) {
            const p = this.nextEphemeral;
            this.nextEphemeral = p >= EPHEMERAL_HI ? EPHEMERAL_LO : p + 1;
            if (this.bind(p, ep)) return p;
        }
        return 0;
    }

    unbind(port: number, ep: IpxEndpoint): void {
        if (this.ports.get(port & 0xffff) === ep) this.ports.delete(port & 0xffff);
    }

    send(srcPort: number, dstNode: Uint8Array, dstPort: number, data: Uint8Array): void {
        this.stats.sent++;
        if (!isBroadcastNode(dstNode) && this.isSelf(dstNode)) {
            this.deliverLocal(this.node, srcPort, dstPort, data.slice());
            return;
        }
        this.transport?.send(encodeDatagram(PROTO_IPX, isBroadcastNode(dstNode) ? BROADCAST_NODE : dstNode, dstPort, srcPort, data));
    }

    /** Frame from the transport; the node field is the sender. */
    receiveFrame(frame: Uint8Array): void {
        const dg = decodeDatagram(frame);
        if (!dg || dg.proto !== PROTO_IPX || this.isSelf(dg.node)) return;
        this.deliverLocal(dg.node.slice(), dg.srcPort, dg.dstPort, dg.payload.slice());
    }

    reset(): void {
        this.ports.clear();
        this.nextEphemeral = EPHEMERAL_LO;
    }

    private deliverLocal(srcNode: Uint8Array, srcPort: number, dstPort: number, data: Uint8Array): void {
        const ep = this.ports.get(dstPort);
        if (!ep) { this.stats.dropped++; return; }
        this.stats.received++;
        ep.deliver({ srcNode, srcPort, data });
    }

    private isSelf(node: Uint8Array): boolean {
        for (let i = 0; i < NODE_LEN; i++) if (node[i] !== this.node[i]) return false;
        return true;
    }
}

export const ipxNetwork = new IpxNetwork();
