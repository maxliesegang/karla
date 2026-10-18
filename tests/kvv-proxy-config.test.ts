import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TRIAS_PROXY_URL,
  DEV_TRIAS_PROXY_PATH,
  resolveTriasProxyUrl,
} from "../src/data/kvv-proxy-config.ts";

test("development reads TRIAS through the same-origin Vite proxy", () => {
  assert.equal(resolveTriasProxyUrl({ DEV: true }), DEV_TRIAS_PROXY_PATH);
});

test("production uses the deployed proxy unless explicitly configured", () => {
  assert.equal(resolveTriasProxyUrl({ DEV: false }), DEFAULT_TRIAS_PROXY_URL);
  for (const DEV of [true, false]) {
    assert.equal(resolveTriasProxyUrl({ DEV, VITE_TRIAS_PROXY_URL: "/api/" }), "/api/");
    assert.equal(resolveTriasProxyUrl({ DEV, VITE_TRIAS_PROXY_URL: "" }), "");
  }
});
