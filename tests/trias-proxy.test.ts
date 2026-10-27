import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TRIAS_PROXY_URL,
  DEV_TRIAS_PROXY_PATH,
  readTriasProxyUrl,
} from "../src/data/trias-proxy.ts";

test("development reads TRIAS through the same-origin Vite proxy", () => {
  assert.equal(readTriasProxyUrl({ DEV: true }), DEV_TRIAS_PROXY_PATH);
});

test("production uses the deployed proxy unless another is configured", () => {
  assert.equal(readTriasProxyUrl({ DEV: false }), DEFAULT_TRIAS_PROXY_URL);
  for (const DEV of [true, false]) {
    assert.equal(readTriasProxyUrl({ DEV, VITE_TRIAS_PROXY_URL: "/api/" }), "/api/");
    assert.equal(readTriasProxyUrl({ DEV, VITE_TRIAS_PROXY_URL: "" }), readTriasProxyUrl({ DEV }));
  }
});
