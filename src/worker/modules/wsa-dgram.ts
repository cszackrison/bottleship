/**
 * SOCK_DGRAM socket semantics shared by AF_IPX and AF_INET/UDP, backed by the worker's virtual LAN.
 * Subclasses supply the sockaddr codec and protocol-level options. Blocking recvfrom/select park
 * the calling guest thread (async thunk) until a datagram arrives, the timeout elapses, or the
 * socket is closed (WSAEINTR, as when closesocket races a blocked call).
 */

import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { LanDatagram, LanEndpoint, LanNetwork, lanNetwork } from "../net/lan-network";
import { BROADCAST_NODE, NODE_LEN, isBroadcastNode } from "../net/netplay-wire";

export const SOCK_DGRAM = 2;
export const SOL_SOCKET = 0xffff;
export const SO_BROADCAST = 0x20;
export const SO_RCVBUF = 0x1002;
export const SO_SNDBUF = 0x1001;
export const SO_TYPE = 0x1008;
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
export const WSAEADDRNOTAVAIL = 10049;
export const WSAENOTCONN = 10057;

const SOCKET_ERROR = -1;

/** Result of a synchronous op: return value + the WSA error to publish (0 on success). */
export interface WsaResult { ret: number; err: number }
export const ok = (ret: number): WsaResult => ({ ret, err: 0 });
export const fail = (err: number): WsaResult => ({ ret: SOCKET_ERROR, err });

/** A LAN address; `node` null = a destination off the virtual LAN (sends are silently dropped). */
export interface DgramAddr { node: Uint8Array | null; port: number }

export function view(mem: Uint8Array): DataView { return new DataView(mem.buffer, mem.byteOffset, mem.byteLength); }
export function inBounds(mem: Uint8Array, ptr: number, len: number): boolean { return ptr !== 0 && ptr + len <= mem.length; }
function liveMem(fallback: Uint8Array): Uint8Array { return Mem.getView() ?? fallback; }

export abstract class DgramSocket implements LanEndpoint {
    port = 0;
    broadcast = false;
    nonBlocking = false;
    closed = false;
    rcvbuf = DEFAULT_RCVBUF;
    peer: DgramAddr | null = null;
    dropped = 0;
    private queue: LanDatagram[] = [];
    private queuedBytes = 0;
    private waiters: Array<() => void> = [];

    protected abstract readonly proto: number;
    protected abstract readonly family: number;
    protected abstract readonly addrSize: number;
    protected abstract readonly maxPayload: number;
    /** Decode a sockaddr already checked for bounds and family. */
    protected abstract readAddr(mem: Uint8Array, ptr: number): DgramAddr;
    protected abstract writeAddr(mem: Uint8Array, ptr: number, addr: DgramAddr): void;
    protected abstract writeLocalAddr(mem: Uint8Array, ptr: number): void;
    /** bind(): false when the sockaddr names an address this host doesn't own. */
    protected bindAddrOk(_mem: Uint8Array, _ptr: number): boolean { return true; }
    protected protoSetsockopt(_mem: Uint8Array, _opt: number, _val: number, _optlen: number): WsaResult { return fail(WSAENOPROTOOPT); }
    protected protoGetsockopt(_mem: Uint8Array, _opt: number, _val: number, _optlenPtr: number): WsaResult { return fail(WSAENOPROTOOPT); }
    abstract readonly protoLevel: number;

    constructor(protected readonly net: LanNetwork = lanNetwork) {}

    deliver(dg: LanDatagram): void {
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
        if (this.port) this.net.unbind(this.port, this, this.proto);
        this.queue = [];
        this.queuedBytes = 0;
        this.wake();
    }

    bind(mem: Uint8Array, addr: number, addrlen: number): WsaResult {
        if (this.port) return fail(WSAEINVAL);
        const err = this.checkAddr(mem, addr, addrlen);
        if (err) return fail(err);
        if (!this.bindAddrOk(mem, addr)) return fail(WSAEADDRNOTAVAIL);
        const { port } = this.readAddr(mem, addr);
        if (port === 0) return this.bindEphemeral() ? ok(0) : fail(WSAEADDRINUSE);
        if (!this.net.bind(port, this, this.proto)) return fail(WSAEADDRINUSE);
        this.port = port;
        return ok(0);
    }

    connect(mem: Uint8Array, addr: number, addrlen: number): WsaResult {
        const err = this.checkAddr(mem, addr, addrlen);
        if (err) return fail(err);
        const peer = this.readAddr(mem, addr);
        if (peer.node && isBroadcastNode(peer.node) && !this.broadcast) return fail(WSAEACCES);
        if (!this.port && !this.bindEphemeral()) return fail(WSAEADDRINUSE);
        this.peer = { node: peer.node?.slice() ?? null, port: peer.port };
        return ok(0);
    }

    sendto(mem: Uint8Array, buf: number, len: number, to: number, tolen: number): WsaResult {
        let dst: DgramAddr;
        if (to) {
            const err = this.checkAddr(mem, to, tolen);
            if (err) return fail(err);
            dst = this.readAddr(mem, to);
        } else if (this.peer) {
            dst = this.peer;
        } else {
            return fail(WSAEDESTADDRREQ);
        }
        if (len > this.maxPayload) return fail(WSAEMSGSIZE);
        if (len > 0 && !inBounds(mem, buf, len)) return fail(WSAEFAULT);
        const bcast = dst.node !== null && isBroadcastNode(dst.node);
        if (bcast && !this.broadcast) return fail(WSAEACCES);
        if (!this.port && !this.bindEphemeral()) return fail(WSAEADDRINUSE);
        if (dst.node) this.net.send(this.port, bcast ? BROADCAST_NODE : dst.node.slice(), dst.port, mem.slice(buf, buf + len), this.proto);
        return ok(len);
    }

    /**
     * recvfrom: immediate when a datagram is queued; WSAEWOULDBLOCK when non-blocking; otherwise a
     * Promise that parks the caller. `onError` publishes the WSA error for the ISSUING thread.
     */
    recvfrom(mem: Uint8Array, buf: number, len: number, from: number, fromlenPtr: number, onError: (code: number) => void): number | Promise<number> {
        if (!this.port) { onError(WSAEINVAL); return SOCKET_ERROR; }
        if (from && !fromlenPtr) { onError(WSAEFAULT); return SOCKET_ERROR; }
        if (fromlenPtr && (!inBounds(mem, fromlenPtr, 4) || (from && view(mem).getInt32(fromlenPtr, true) < this.addrSize))) { onError(WSAEFAULT); return SOCKET_ERROR; }
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
        if (!this.nameBufOk(mem, name, namelenPtr)) return fail(WSAEFAULT);
        this.writeLocalAddr(mem, name);
        view(mem).setInt32(namelenPtr, this.addrSize, true);
        return ok(0);
    }

    getpeername(mem: Uint8Array, name: number, namelenPtr: number): WsaResult {
        if (!this.peer) return fail(WSAENOTCONN);
        if (!this.nameBufOk(mem, name, namelenPtr)) return fail(WSAEFAULT);
        this.writeAddr(mem, name, this.peer);
        view(mem).setInt32(namelenPtr, this.addrSize, true);
        return ok(0);
    }

    setsockopt(mem: Uint8Array, level: number, opt: number, val: number, optlen: number): WsaResult {
        if (level === this.protoLevel) return this.protoSetsockopt(mem, opt, val, optlen);
        if (level !== SOL_SOCKET) return fail(WSAENOPROTOOPT);
        const v = readOptInt(mem, val, optlen);
        if (v === null) return fail(WSAEFAULT);
        if (opt === SO_BROADCAST) this.broadcast = v !== 0;
        else if (opt === SO_RCVBUF) this.rcvbuf = Math.max(0, v);
        return ok(0);
    }

    getsockopt(mem: Uint8Array, level: number, opt: number, val: number, optlenPtr: number): WsaResult {
        if (!inBounds(mem, optlenPtr, 4)) return fail(WSAEFAULT);
        if (level === this.protoLevel) return this.protoGetsockopt(mem, opt, val, optlenPtr);
        if (level !== SOL_SOCKET) return fail(WSAENOPROTOOPT);
        if (opt === SO_BROADCAST) return putOptInt(mem, val, optlenPtr, this.broadcast ? 1 : 0);
        if (opt === SO_RCVBUF) return putOptInt(mem, val, optlenPtr, this.rcvbuf);
        if (opt === SO_SNDBUF) return putOptInt(mem, val, optlenPtr, DEFAULT_RCVBUF);
        if (opt === SO_TYPE) return putOptInt(mem, val, optlenPtr, SOCK_DGRAM);
        return fail(WSAENOPROTOOPT);
    }

    private checkAddr(mem: Uint8Array, addr: number, addrlen: number): number {
        if (addrlen < this.addrSize || !inBounds(mem, addr, this.addrSize)) return WSAEFAULT;
        return view(mem).getUint16(addr, true) === this.family ? 0 : WSAEAFNOSUPPORT;
    }

    private nameBufOk(mem: Uint8Array, name: number, namelenPtr: number): boolean {
        return inBounds(mem, namelenPtr, 4) && view(mem).getInt32(namelenPtr, true) >= this.addrSize && inBounds(mem, name, this.addrSize);
    }

    private take(mem: Uint8Array, buf: number, len: number, from: number, fromlenPtr: number, onError: (code: number) => void): number {
        const dg = this.queue.shift()!;
        this.queuedBytes -= dg.data.length;
        const n = Math.min(len, dg.data.length);
        if (n > 0 && !inBounds(mem, buf, n)) { onError(WSAEFAULT); return SOCKET_ERROR; }
        mem.set(dg.data.subarray(0, n), buf);
        if (from && fromlenPtr) {
            if (!inBounds(mem, from, this.addrSize)) { onError(WSAEFAULT); return SOCKET_ERROR; }
            this.writeAddr(mem, from, { node: dg.srcNode, port: dg.srcPort });
            view(mem).setInt32(fromlenPtr, this.addrSize, true);
        }
        if (n < dg.data.length) { onError(WSAEMSGSIZE); return SOCKET_ERROR; }
        onError(0);
        return n;
    }

    private bindEphemeral(): boolean {
        this.port = this.net.bindEphemeral(this, this.proto);
        return this.port !== 0;
    }

    private fromPeer(dg: LanDatagram): boolean {
        const p = this.peer!;
        if (!p.node || dg.srcPort !== p.port) return false;
        for (let i = 0; i < NODE_LEN; i++) if (dg.srcNode[i] !== p.node[i]) return false;
        return true;
    }

    private wake(): void {
        const w = this.waiters;
        this.waiters = [];
        for (const resolve of w) resolve();
    }
}

export function readOptInt(mem: Uint8Array, val: number, optlen: number): number | null {
    return optlen >= 4 && inBounds(mem, val, 4) ? view(mem).getInt32(val, true) : optlen >= 1 && inBounds(mem, val, 1) ? mem[val] : null;
}

export function putOptInt(mem: Uint8Array, val: number, optlenPtr: number, n: number): WsaResult {
    const v = view(mem);
    if (v.getInt32(optlenPtr, true) < 4 || !inBounds(mem, val, 4)) return fail(WSAEFAULT);
    v.setInt32(val, n, true);
    v.setInt32(optlenPtr, 4, true);
    return ok(0);
}

/** LastError for the thread that issued a (possibly parked) socket call. */
export function threadErrorSink(): (code: number) => void {
    const sched = System.getInstance().scheduler;
    const tid = sched.getCurrentThreadId();
    return (code: number) => sched.setThreadLastError(tid, code);
}
