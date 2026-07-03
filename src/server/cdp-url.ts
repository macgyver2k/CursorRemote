import { lookup } from "dns/promises";

export interface ResolvedCdpEndpoint {
  baseUrl: string;
  host: string;
  port: string;
  originalUrl: string;
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")
  );
}

export async function resolveCdpEndpoint(
  cdpUrl: string,
): Promise<ResolvedCdpEndpoint> {
  const parsed = new URL(cdpUrl);
  let host = parsed.hostname;

  if (!isLocalHost(host) && !isIpv4(host) && !host.includes(":")) {
    const result = await lookup(host, { family: 4 });
    host = result.address;
  } else if (host === "localhost") {
    host = "127.0.0.1";
  }

  const port = parsed.port || "80";
  const baseUrl = `${parsed.protocol}//${host}:${port}`;

  return { baseUrl, host, port, originalUrl: cdpUrl };
}

export function rewriteCdpWebSocketUrl(
  wsUrl: string | undefined,
  endpoint: ResolvedCdpEndpoint,
): string | undefined {
  if (!wsUrl) return wsUrl;

  try {
    const ws = new URL(wsUrl);
    const originalHost = new URL(endpoint.originalUrl).hostname;
    const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

    if (loopback.has(ws.hostname) || ws.hostname === originalHost) {
      ws.hostname = endpoint.host;
      if (!ws.port && endpoint.port !== "80" && endpoint.port !== "443") {
        ws.port = endpoint.port;
      }
      return ws.toString();
    }

    return wsUrl;
  } catch {
    return wsUrl;
  }
}
