/**
 * `?room=<name>` joins that netplay room. The relay (tools/netplay-relay.ts) defaults to port 3002 on
 * the page's host; `&relay=<ws url>` or the VITE_NETPLAY_RELAY build variable points elsewhere.
 */
export function netplayRelayUrl(params: URLSearchParams): string | null {
    const room = params.get("room")?.trim();
    if (!room) return null;
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const base = params.get("relay") ?? import.meta.env.VITE_NETPLAY_RELAY ?? `${scheme}://${window.location.hostname}:3002/netplay`;
    return `${base.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;
}
