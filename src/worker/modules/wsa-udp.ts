/**
 * AF_INET / SOCK_DGRAM (UDP) sockets on the worker's virtual LAN. This host is 10.a.b.c on
 * 10.0.0.0/8 (see lan-network); 255.255.255.255 and 10.255.255.255 broadcast to the room, 127/8
 * loops back, and destinations off the LAN are accepted and dropped, as a gateway-less LAN would.
 */

import { UDP_MAX_PAYLOAD, LAN_NET_OCTET, ipv4ToNode, nodeToIpv4 } from "../net/lan-network";
import { BROADCAST_NODE, PROTO_UDP } from "../net/netplay-wire";
import { DgramAddr, DgramSocket, WsaResult, ok, view } from "./wsa-dgram";

export const AF_INET = 2;
export const IPPROTO_IP = 0;
export const IPPROTO_UDP = 17;
export const SOCKADDR_IN_SIZE = 16;

const ANY = new Uint8Array(4);

export function writeSockaddrIn(mem: Uint8Array, ptr: number, ip: Uint8Array, port: number): void {
    const v = view(mem);
    v.setUint16(ptr, AF_INET, true);
    v.setUint16(ptr + 2, port & 0xffff, false);
    mem.set(ip.subarray(0, 4), ptr + 4);
    mem.fill(0, ptr + 8, ptr + SOCKADDR_IN_SIZE);
}

export class UdpSocket extends DgramSocket {
    private boundIp: Uint8Array = ANY;
    protected readonly proto = PROTO_UDP;
    protected readonly family = AF_INET;
    protected readonly addrSize = SOCKADDR_IN_SIZE;
    protected readonly maxPayload = UDP_MAX_PAYLOAD;
    readonly protoLevel = IPPROTO_IP;

    protected readAddr(mem: Uint8Array, ptr: number): DgramAddr {
        const ip = mem.slice(ptr + 4, ptr + 8);
        return { node: this.routeIp(ip), port: view(mem).getUint16(ptr + 2, false) };
    }

    protected writeAddr(mem: Uint8Array, ptr: number, addr: DgramAddr): void {
        writeSockaddrIn(mem, ptr, addr.node ? nodeToIpv4(addr.node) : ANY, addr.port);
    }

    protected writeLocalAddr(mem: Uint8Array, ptr: number): void {
        writeSockaddrIn(mem, ptr, this.boundIp, this.port);
    }

    protected bindAddrOk(mem: Uint8Array, ptr: number): boolean {
        const ip = mem.slice(ptr + 4, ptr + 8);
        const own = nodeToIpv4(this.net.node);
        const ok = ip.every((b) => b === 0) || ip[0] === 127 || ip.every((b, i) => b === own[i]);
        if (ok) this.boundIp = ip;
        return ok;
    }

    protected protoSetsockopt(): WsaResult { return ok(0); }

    private routeIp(ip: Uint8Array): Uint8Array | null {
        if (ip.every((b) => b === 0xff)) return BROADCAST_NODE;
        if (ip[0] === 127) return this.net.node;
        if (ip[0] !== LAN_NET_OCTET) return null;
        if (ip[1] === 0xff && ip[2] === 0xff && ip[3] === 0xff) return BROADCAST_NODE;
        if ((ip[1] | ip[2] | ip[3]) === 0) return null;
        return ipv4ToNode(ip);
    }
}
