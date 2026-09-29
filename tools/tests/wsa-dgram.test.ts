import { describe, expect, test } from "bun:test";
import { IpxNetwork, NetTransport } from "../../src/worker/net/ipx-network";
import { BROADCAST_NODE, NODE_LEN, decodeDatagram } from "../../src/worker/net/netplay-wire";
import { AF_IPX, IpxSocket, SOCKADDR_IPX_SIZE, SOL_SOCKET, SO_BROADCAST, WSAEACCES, WSAEADDRINUSE, WSAEINTR, WSAEMSGSIZE, WSAEWOULDBLOCK, NSPROTO_IPX, IPX_ADDRESS } from "../../src/worker/modules/wsa-ipx";
import { WsaSocketTable } from "../../src/worker/modules/wsa-stub-shared";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

/** Two machines on one LAN segment, joined by a relay-equivalent in-memory switch. */
function lan(): [IpxNetwork, IpxNetwork] {
    const a = new IpxNetwork(new Uint8Array([2, 0, 0, 0, 0, 1]));
    const b = new IpxNetwork(new Uint8Array([2, 0, 0, 0, 0, 2]));
    const link = (from: IpxNetwork, to: IpxNetwork): NetTransport => ({
        send(frame) {
            const dg = decodeDatagram(frame)!;
            const dst = dg.node;
            const out = frame.slice();
            out.set(from.node, 2);
            if (dst.every((x) => x === 0xff) || dst.every((x, i) => x === to.node[i])) to.receiveFrame(out);
        },
        close() {},
    });
    a.attach(link(a, b));
    b.attach(link(b, a));
    return [a, b];
}

const mem = () => new Uint8Array(0x10000);
function sockaddr(m: Uint8Array, at: number, node: Uint8Array, port: number): number {
    const v = new DataView(m.buffer);
    v.setUint16(at, AF_IPX, true);
    m.set(node, at + 6);
    v.setUint16(at + 12, port, false);
    return at;
}
const ANY = new Uint8Array(NODE_LEN);

describe("IPX datagram sockets", () => {
    test("broadcast needs SO_BROADCAST, then reaches the peer with the sender's address", async () => {
        const [na, nb] = lan();
        const m = mem();
        const tx = new IpxSocket(na), rx = new IpxSocket(nb);
        expect(rx.bind(m, sockaddr(m, 0x100, ANY, 0x17df), SOCKADDR_IPX_SIZE).err).toBe(0);
        m.set([1, 2, 3, 4], 0x400);
        const to = sockaddr(m, 0x200, BROADCAST_NODE, 0x17df);
        expect(tx.sendto(m, 0x400, 4, to, SOCKADDR_IPX_SIZE).err).toBe(WSAEACCES);
        new DataView(m.buffer).setInt32(0x300, 1, true);
        expect(tx.setsockopt(m, SOL_SOCKET, SO_BROADCAST, 0x300, 4).err).toBe(0);
        expect(tx.sendto(m, 0x400, 4, to, SOCKADDR_IPX_SIZE)).toEqual({ ret: 4, err: 0 });

        new DataView(m.buffer).setInt32(0x600, SOCKADDR_IPX_SIZE, true);
        let err = -1;
        const n = rx.recvfrom(m, 0x800, 64, 0x500, 0x600, (e) => (err = e));
        expect(n).toBe(4);
        expect(err).toBe(0);
        expect([...m.subarray(0x800, 0x804)]).toEqual([1, 2, 3, 4]);
        expect([...m.subarray(0x506, 0x50c)]).toEqual([...na.node]);
        expect(new DataView(m.buffer).getUint16(0x50c, false)).toBe(tx.port);
    });

    test("blocking recvfrom parks until a datagram arrives; close wakes it with WSAEINTR", async () => {
        const [na, nb] = lan();
        const m = mem();
        Mem.bind(() => m);
        const tx = new IpxSocket(na), rx = new IpxSocket(nb);
        rx.bind(m, sockaddr(m, 0x100, ANY, 0x17e0), SOCKADDR_IPX_SIZE);
        const pending = rx.recvfrom(m, 0x800, 64, 0, 0, () => {});
        expect(pending).toBeInstanceOf(Promise);
        m.set([9, 9], 0x400);
        tx.sendto(m, 0x400, 2, sockaddr(m, 0x200, nb.node, 0x17e0), SOCKADDR_IPX_SIZE);
        expect(await pending).toBe(2);

        let err = 0;
        const blocked = rx.recvfrom(m, 0x800, 64, 0, 0, (e) => (err = e));
        rx.close();
        expect(await blocked).toBe(-1);
        expect(err).toBe(WSAEINTR);
    });

    test("non-blocking, truncation, port conflicts, IPX_ADDRESS", () => {
        const [na] = lan();
        const m = mem();
        const a = new IpxSocket(na), b = new IpxSocket(na);
        a.bind(m, sockaddr(m, 0x100, ANY, 0x5000), SOCKADDR_IPX_SIZE);
        expect(b.bind(m, sockaddr(m, 0x100, ANY, 0x5000), SOCKADDR_IPX_SIZE).err).toBe(WSAEADDRINUSE);

        a.nonBlocking = true;
        let err = 0;
        expect(a.recvfrom(m, 0x800, 8, 0, 0, (e) => (err = e))).toBe(-1);
        expect(err).toBe(WSAEWOULDBLOCK);

        b.sendto(m, 0x400, 10, sockaddr(m, 0x200, na.node, 0x5000), SOCKADDR_IPX_SIZE);
        expect(a.recvfrom(m, 0x800, 4, 0, 0, (e) => (err = e))).toBe(-1);
        expect(err).toBe(WSAEMSGSIZE);

        const v = new DataView(m.buffer);
        v.setInt32(0x900, 0, true);
        v.setInt32(0x9f0, 24, true);
        expect(a.getsockopt(m, NSPROTO_IPX, IPX_ADDRESS, 0x900, 0x9f0).err).toBe(0);
        expect([...m.subarray(0x908, 0x90e)]).toEqual([...na.node]);
    });

    test("socket table routes AF_IPX to real sockets and keeps AF_INET offline", () => {
        const t = new WsaSocketTable();
        const ipx = t.create(AF_IPX, 2, NSPROTO_IPX);
        expect(ipx.err).toBe(0);
        expect(t.ipx(ipx.s)).toBeInstanceOf(IpxSocket);
        expect(t.create(AF_IPX, 5, NSPROTO_IPX).err).not.toBe(0);
        const tcp = t.create(2, 1, 6);
        expect(t.ipx(tcp.s)).toBeUndefined();
        expect(t.closesocket(ipx.s)).toBe(0);
    });
});
