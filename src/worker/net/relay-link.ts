/**
 * WebSocket transport from this worker's LanNetwork to the netplay relay (tools/netplay-relay.ts).
 * Frames sent before the socket opens are queued (bounded); a dropped connection reconnects with
 * backoff and re-joins under the same node, so in-flight sockets keep their addresses.
 */

import { Logger, LogCategory } from "../core/logger";
import { encodeJoin } from "./netplay-wire";
import { LanNetwork, NetTransport, lanNetwork } from "./lan-network";

const MAX_PENDING = 256;

export class RelayLink implements NetTransport {
    private ws: WebSocket | null = null;
    private pending: Uint8Array<ArrayBuffer>[] = [];
    private closed = false;
    private retryMs = 500;

    constructor(private readonly url: string, private readonly net: LanNetwork) { this.open(); }

    send(frame: Uint8Array<ArrayBuffer>): void {
        if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(frame); return; }
        if (this.pending.length < MAX_PENDING) this.pending.push(frame);
    }

    close(): void {
        this.closed = true;
        this.ws?.close();
        this.ws = null;
    }

    private open(): void {
        if (this.closed) return;
        const ws = new WebSocket(this.url);
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        ws.onopen = () => {
            this.retryMs = 500;
            ws.send(encodeJoin(this.net.node));
            for (const f of this.pending) ws.send(f);
            this.pending = [];
            Logger.info(LogCategory.SYSTEM, `[netplay] joined ${this.url}`);
        };
        ws.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) this.net.receiveFrame(new Uint8Array(ev.data)); };
        ws.onclose = () => {
            if (this.ws !== ws || this.closed) return;
            Logger.warn(LogCategory.SYSTEM, `[netplay] relay disconnected; retrying in ${this.retryMs}ms`);
            setTimeout(() => this.open(), this.retryMs);
            this.retryMs = Math.min(this.retryMs * 2, 10_000);
        };
    }
}

export function configureNetplay(url: string | null): void {
    lanNetwork.attach(url ? new RelayLink(url, lanNetwork) : null);
}
