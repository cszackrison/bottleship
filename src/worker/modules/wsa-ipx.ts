/**
 * AF_IPX / SOCK_DGRAM sockets (NWLink IPX over Winsock) backed by the worker's virtual IPX network.
 * Blocking recvfrom/select park the calling guest thread (async thunk) until a datagram arrives,
 * the timeout elapses, or the socket is closed (WSAEINTR, as when closesocket races a blocked call).
 */

import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { IPX_MAX_PAYLOAD, IPX_NETNUM, IpxDatagram, IpxEndpoint, IpxNetwork, ipxNetwork } from "../net/ipx-network";
import { BROADCAST_NODE, NODE_LEN, isBroadcastNode } from "../net/netplay-wire";

export const AF_IPX = 6;
export const SOCK_DGRAM = 2;
export const NSPROTO_IPX = 1000;
export const SOCKADDR_IPX_SIZE = 14;
export const SOL_SOCKET = 0xffff;
export const SO_BROADCAST = 0x20;
export const SO_RCVBUF = 0x1002;
export const SO_SNDBUF = 0x1001;
export const SO_TYPE = 0x1008;
export const IPX_PTYPE = 0x4000;
export const IPX_ADDRESS = 0x4007;
export const IPX_MAX_ADAPTER_NUM = 0x400d;
const IPX_ADDRESS_DATA_SIZE = 24;
const DEFAULT_RCVBUF = 8192;

export const WSAEINTR = 10004;
export const WSAEACCES = 10013;
export const WSAEFAULT = 10014;
export const WSAEINVAL = 10022;
export const WSAEWOULDBLOCK = 10035;
export const WSAEDESTADDRREQ = 10039;
export const WSAEMSGSIZE = 10040;
export const WSAENOPROTOOPT = 10042;
export const WSAEPROTONOSUPPORT = 10043;
export const WSAESOCKTNOSUPPORT = 10044;
export const WSAEAFNOSUPPORT = 10047;
export const WSAEADDRINUSE = 10048;
export const WSAENOTCONN = 10057;

const SOCKET_ERROR = -1;

/** Result of a synchronous op: return value + the WSA error to publish (0 on success). */
export interface WsaResult { ret: number; err: number }
const ok = (ret: number): WsaResult => ({ ret, err: 0 });
const fail = (err: number): WsaResult => ({ ret: SOCKET_ERROR, err });

function view(mem: Uint8Array): DataView { return new DataView(mem.buffer, mem.byteOffset, mem.byteLength); }
function inBounds(mem: Uint8Array, ptr: number, len: number): boolean { return ptr !== 0 && ptr + len <= mem.length; }
function liveMem(fallback: Uint8Array): Uint8Array { return Mem.getView() ?? fallback; }

export function writeSockaddrIpx(mem: Uint8Array, ptr: number, node: Uint8Array, port: number): void {
    const v = view(mem);
    v.setUint16(ptr, AF_IPX, true);
    mem.set(IPX_NETNUM, ptr + 2);
    mem.set(node.subarray(0, NODE_LEN), ptr + 6);
    v.setUint16(ptr + 12, port & 0xffff, false);
}

export class IpxSocket implements IpxEndpoint {
    port = 0;
    broadcast = false;
    nonBlocking = false;
    closed = false;
    rcvbuf = DEFAULT_RCVBUF;
    ptype = 0;
    peer: { node: Uint8Array; port: number } | null = null;
    dropped = 0;
    private queue: IpxDatagram[] = [];
    private queuedBytes = 0;
    private waiters: Array<() => void> = [];

    constructor(private readonly net: IpxNetwork = ipxNetwork) {}

    deliver(dg: IpxDatagram): void {
        if (this.closed) return;
        if (this.peer && !this.fromPeer(dg)) return;
        if (this.queuedBytes + dg.data.length > this.rcvbuf) { this.dropped++; return; }
        this.queue.push(dg);
        this.queuedBytes += dg.data.length;
        this.wake();
    }

    get readable(): boolean { return this.queue.length > 0 || this.closed; }
    get pendingBytes(): number { return this.queuedBytes; }

    /** Resolves on the next delivery or close. */
    waitReadable(): Promise<void> { return new Promise((resolve) => this.waiters.push(resolve)); }

    /** Callback on the next delivery or close; returns an unsubscribe for waits that end otherwise (select timeout). */
    onReadable(cb: () => void): () => void {
        this.waiters.push(cb);
        return () => { const i = this.waiters.indexOf(cb); if (i >= 0) this.waiters.splice(i, 1); };
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.port) this.net.unbind(this.port, this);
        this.queue = [];
        this.queuedBytes = 0;
        this.wake();
    }

    bind(mem: Uint8Array, addr: number, addrlen: number): WsaResult {
        if (this.port) return fail(WSAEINVAL);
        if (addrlen < SOCKADDR_IPX_SIZE || !inBounds(mem, addr, SOCKADDR_IPX_SIZE)) return fail(WSAEFAULT);
        const v = view(mem);
        if (v.getUint16(addr, true) !== AF_IPX) return fail(WSAEAFNOSUPPORT);
        const port = v.getUint16(addr + 12, false);
        if (port === 0) return this.bindEphemeral() ? ok(0) : fail(WSAEADDRINUSE);
        if (!this.net.bind(port, this)) return fail(WSAEADDRINUSE);
        this.port = port;
        return ok(0);
    }

    connect(mem: Uint8Array, addr: number, addrlen: number): WsaResult {
        if (addrlen < SOCKADDR_IPX_SIZE || !inBounds(mem, addr, SOCKADDR_IPX_SIZE)) return fail(WSAEFAULT);
        const v = view(mem);
        if (v.getUint16(addr, true) !== AF_IPX) return fail(WSAEAFNOSUPPORT);
        const node = mem.slice(addr + 6, addr + 12);
        if (isBroadcastNode(node) && !this.broadcast) return fail(WSAEACCES);
        if (!this.port && !this.bindEphemeral()) return fail(WSAEADDRINUSE);
        this.peer = { node, port: v.getUint16(addr + 12, false) };
        return ok(0);
    }

    sendto(mem: Uint8Array, buf: number, len: number, to: number, tolen: number): WsaResult {
        let node: Uint8Array, port: number;
        if (to) {
            if (tolen < SOCKADDR_IPX_SIZE || !inBounds(mem, to, SOCKADDR_IPX_SIZE)) return fail(WSAEFAULT);
            const v = view(mem);
            if (v.getUint16(to, true) !== AF_IPX) return fail(WSAEAFNOSUPPORT);
            node = mem.subarray(to + 6, to + 12);
            port = v.getUint16(to + 12, false);
        } else if (this.peer) {
            ({ node, port } = this.peer);
        } else {
            return fail(WSAEDESTADDRREQ);
        }
        if (len > IPX_MAX_PAYLOAD) return fail(WSAEMSGSIZE);
        if (len > 0 && !inBounds(mem, buf, len)) return fail(WSAEFAULT);
        if (isBroadcastNode(node) && !this.broadcast) return fail(WSAEACCES);
        if (!this.port && !this.bindEphemeral()) return fail(WSAEADDRINUSE);
        this.net.send(this.port, isBroadcastNode(node) ? BROADCAST_NODE : node.slice(), port, mem.slice(buf, buf + len));
        return ok(len);
    }

    /**
     * recvfrom: immediate when a datagram is queued; WSAEWOULDBLOCK when non-blocking; otherwise a
     * Promise that parks the caller. `onError` publishes the WSA error for the ISSUING thread.
     */
    recvfrom(mem: Uint8Array, buf: number, len: number, from: number, fromlenPtr: number, onError: (code: number) => void): number | Promise<number> {
        if (!this.port) { onError(WSAEINVAL); return SOCKET_ERROR; }
        if (from && !fromlenPtr) { onError(WSAEFAULT); return SOCKET_ERROR; }
        if (fromlenPtr && (!inBounds(mem, fromlenPtr, 4) || (from && view(mem).getInt32(fromlenPtr, true) < SOCKADDR_IPX_SIZE))) { onError(WSAEFAULT); return SOCKET_ERROR; }
        if (this.queue.length) return this.take(mem, buf, len, from, fromlenPtr, onError);
        if (this.nonBlocking) { onError(WSAEWOULDBLOCK); return SOCKET_ERROR; }
        return (async () => {
            while (!this.queue.length && !this.closed) await this.waitReadable();
            if (this.closed) { onError(WSAEINTR); return SOCKET_ERROR; }
            return this.take(liveMem(mem), buf, len, from, fromlenPtr, onError);
        })();
    }

    getsockname(mem: Uint8Array, name: number, namelenPtr: number): WsaResult {
        if (!this.port) return fail(WSAEINVAL);
        if (!inBounds(mem, namelenPtr, 4) || view(mem).getInt32(namelenPtr, true) < SOCKADDR_IPX_SIZE || !inBounds(mem, name, SOCKADDR_IPX_SIZE)) return fail(WSAEFAULT);
        writeSockaddrIpx(mem, name, this.net.node, this.port);
        view(mem).setInt32(namelenPtr, SOCKADDR_IPX_SIZE, true);
        return ok(0);
    }

    getpeername(mem: Uint8Array, name: number, namelenPtr: number): WsaResult {
        if (!this.peer) return fail(WSAENOTCONN);
        if (!inBounds(mem, namelenPtr, 4) || view(mem).getInt32(namelenPtr, true) < SOCKADDR_IPX_SIZE || !inBounds(mem, name, SOCKADDR_IPX_SIZE)) return fail(WSAEFAULT);
        writeSockaddrIpx(mem, name, this.peer.node, this.peer.port);
        view(mem).setInt32(namelenPtr, SOCKADDR_IPX_SIZE, true);
        return ok(0);
    }

    setsockopt(mem: Uint8Array, level: number, opt: number, val: number, optlen: number): WsaResult {
        const readInt = (): number | null => (optlen >= 4 && inBounds(mem, val, 4) ? view(mem).getInt32(val, true) : optlen >= 1 && inBounds(mem, val, 1) ? mem[val] : null);
        if (level === SOL_SOCKET) {
            const v = readInt();
            if (v === null) return fail(WSAEFAULT);
            if (opt === SO_BROADCAST) this.broadcast = v !== 0;
            else if (opt === SO_RCVBUF) this.rcvbuf = Math.max(0, v);
            return ok(0);
        }
        if (level === NSPROTO_IPX) {
            const v = readInt();
            if (v === null) return fail(WSAEFAULT);
            if (opt === IPX_PTYPE) this.ptype = v & 0xff;
            return ok(0);
        }
        return fail(WSAENOPROTOOPT);
    }

    getsockopt(mem: Uint8Array, level: number, opt: number, val: number, optlenPtr: number): WsaResult {
        if (!inBounds(mem, optlenPtr, 4)) return fail(WSAEFAULT);
        const v = view(mem);
        const have = v.getInt32(optlenPtr, true);
        const putInt = (n: number): WsaResult => {
            if (have < 4 || !inBounds(mem, val, 4)) return fail(WSAEFAULT);
            v.setInt32(val, n, true);
            v.setInt32(optlenPtr, 4, true);
            return ok(0);
        };
        if (level === SOL_SOCKET) {
            if (opt === SO_BROADCAST) return putInt(this.broadcast ? 1 : 0);
            if (opt === SO_RCVBUF) return putInt(this.rcvbuf);
            if (opt === SO_SNDBUF) return putInt(DEFAULT_RCVBUF);
            if (opt === SO_TYPE) return putInt(SOCK_DGRAM);
            return fail(WSAENOPROTOOPT);
        }
        if (level === NSPROTO_IPX) {
            if (opt === IPX_PTYPE) return putInt(this.ptype);
            if (opt === IPX_MAX_ADAPTER_NUM) return putInt(1);
            if (opt === IPX_ADDRESS) {
                if (have < IPX_ADDRESS_DATA_SIZE || !inBounds(mem, val, IPX_ADDRESS_DATA_SIZE)) return fail(WSAEFAULT);
                const adapter = v.getInt32(val, true);
                if (adapter !== 0) return fail(WSAEINVAL);
                mem.set(IPX_NETNUM, val + 4);
                mem.set(this.net.node, val + 8);
                mem[val + 14] = 0;
                mem[val + 15] = 0;
                v.setInt32(val + 16, IPX_MAX_PAYLOAD, true);
                v.setUint32(val + 20, 100_000, true);
                v.setInt32(optlenPtr, IPX_ADDRESS_DATA_SIZE, true);
                return ok(0);
            }
            return fail(WSAENOPROTOOPT);
        }
        return fail(WSAENOPROTOOPT);
    }

    private take(mem: Uint8Array, buf: number, len: number, from: number, fromlenPtr: number, onError: (code: number) => void): number {
        const dg = this.queue.shift()!;
        this.queuedBytes -= dg.data.length;
        const n = Math.min(len, dg.data.length);
        if (n > 0 && !inBounds(mem, buf, n)) { onError(WSAEFAULT); return SOCKET_ERROR; }
        mem.set(dg.data.subarray(0, n), buf);
        if (from && fromlenPtr) {
            if (!inBounds(mem, from, SOCKADDR_IPX_SIZE)) { onError(WSAEFAULT); return SOCKET_ERROR; }
            writeSockaddrIpx(mem, from, dg.srcNode, dg.srcPort);
            view(mem).setInt32(fromlenPtr, SOCKADDR_IPX_SIZE, true);
        }
        if (n < dg.data.length) { onError(WSAEMSGSIZE); return SOCKET_ERROR; }
        onError(0);
        return n;
    }

    private bindEphemeral(): boolean {
        this.port = this.net.bindEphemeral(this);
        return this.port !== 0;
    }

    private fromPeer(dg: IpxDatagram): boolean {
        const p = this.peer!;
        if (dg.srcPort !== p.port) return false;
        for (let i = 0; i < NODE_LEN; i++) if (dg.srcNode[i] !== p.node[i]) return false;
        return true;
    }

    private wake(): void {
        const w = this.waiters;
        this.waiters = [];
        for (const resolve of w) resolve();
    }
}

/** LastError for the thread that issued a (possibly parked) socket call. */
export function threadErrorSink(): (code: number) => void {
    const sched = System.getInstance().scheduler;
    const tid = sched.getCurrentThreadId();
    return (code: number) => sched.setThreadLastError(tid, code);
}
