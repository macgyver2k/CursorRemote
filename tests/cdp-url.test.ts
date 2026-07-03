import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewriteCdpWebSocketUrl } from "../src/server/cdp-url.js";

describe("rewriteCdpWebSocketUrl", () => {
  const endpoint = {
    baseUrl: "http://192.168.65.254:9222",
    host: "192.168.65.254",
    port: "9222",
    originalUrl: "http://host.docker.internal:9222",
  };

  it("rewrites loopback websocket URLs to resolved host IP", () => {
    const rewritten = rewriteCdpWebSocketUrl(
      "ws://127.0.0.1:9222/devtools/page/ABC",
      endpoint,
    );
    assert.equal(rewritten, "ws://192.168.65.254:9222/devtools/page/ABC");
  });

  it("rewrites configured hostname in websocket URLs", () => {
    const rewritten = rewriteCdpWebSocketUrl(
      "ws://host.docker.internal:9222/devtools/page/ABC",
      endpoint,
    );
    assert.equal(rewritten, "ws://192.168.65.254:9222/devtools/page/ABC");
  });

  it("leaves unrelated hosts unchanged", () => {
    const url = "ws://example.com:9222/devtools/page/ABC";
    assert.equal(rewriteCdpWebSocketUrl(url, endpoint), url);
  });
});
