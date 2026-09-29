/**
 * AF_IPX / SOCK_DGRAM sockets (NWLink IPX over Winsock) on the worker's virtual LAN.
 */

import { IPX_MAX_PAYLOAD, IPX_NETNUM } from "../net/lan-network";
import { NODE_LEN, PROTO_IPX } from "../net/netplay-wire";
import { DgramAddr, DgramSocket, WSAEFAULT, WSAEINVAL, WSAENOPROTOOPT, WsaResult, fail, inBounds, ok, putOptInt, readOptInt, view } from "./wsa-dgram";

export * from "./wsa-dgram";

export const AF_IPX = 6;
export const NSPROTO_IPX = 1000;
export const SOCKADDR_IPX_SIZE = 14;
export const IPX_PTYPE = 0x4000;
export const IPX_ADDRESS = 0x4007;
export const IPX_MAX_ADAPTER_NUM = 0x400d;
const IPX_ADDRESS_DATA_SIZE = 24;

export function writeSockaddrIpx(mem: Uint8Array, ptr: number, node: Uint8Array, port: number): void {
    const v = view(mem);
    v.setUint16(ptr, AF_IPX, true);
    mem.set(IPX_NETNUM, ptr + 2);
    mem.set(node.subarray(0, NODE_LEN), ptr + 6);
    v.setUint16(ptr + 12, port & 0xffff, false);
}

export class IpxSocket extends DgramSocket {
    ptype = 0;
    protected readonly proto = PROTO_IPX;
    protected readonly family = AF_IPX;
    protected readonly addrSize = SOCKADDR_IPX_SIZE;
    protected readonly maxPayload = IPX_MAX_PAYLOAD;
    readonly protoLevel = NSPROTO_IPX;

    protected readAddr(mem: Uint8Array, ptr: number): DgramAddr {
        return { node: mem.subarray(ptr + 6, ptr + 12), port: view(mem).getUint16(ptr + 12, false) };
    }

    protected writeAddr(mem: Uint8Array, ptr: number, addr: DgramAddr): void {
        writeSockaddrIpx(mem, ptr, addr.node ?? new Uint8Array(NODE_LEN), addr.port);
    }

    protected writeLocalAddr(mem: Uint8Array, ptr: number): void {
        writeSockaddrIpx(mem, ptr, this.net.node, this.port);
    }

    protected protoSetsockopt(mem: Uint8Array, opt: number, val: number, optlen: number): WsaResult {
        const v = readOptInt(mem, val, optlen);
        if (v === null) return fail(WSAEFAULT);
        if (opt === IPX_PTYPE) this.ptype = v & 0xff;
        return ok(0);
    }

    protected protoGetsockopt(mem: Uint8Array, opt: number, val: number, optlenPtr: number): WsaResult {
        if (opt === IPX_PTYPE) return putOptInt(mem, val, optlenPtr, this.ptype);
        if (opt === IPX_MAX_ADAPTER_NUM) return putOptInt(mem, val, optlenPtr, 1);
        if (opt !== IPX_ADDRESS) return fail(WSAENOPROTOOPT);
        const v = view(mem);
        if (v.getInt32(optlenPtr, true) < IPX_ADDRESS_DATA_SIZE || !inBounds(mem, val, IPX_ADDRESS_DATA_SIZE)) return fail(WSAEFAULT);
        if (v.getInt32(val, true) !== 0) return fail(WSAEINVAL);
        mem.set(IPX_NETNUM, val + 4);
        mem.set(this.net.node, val + 8);
        mem[val + 14] = 0;
        mem[val + 15] = 0;
        v.setInt32(val + 16, IPX_MAX_PAYLOAD, true);
        v.setUint32(val + 20, 100_000, true);
        v.setInt32(optlenPtr, IPX_ADDRESS_DATA_SIZE, true);
        return ok(0);
    }
}
