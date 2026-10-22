import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TRIAS_PROXY_URL,
  DEV_TRIAS_PROXY_PATH,
  readKvvFeedConfig,
} from "../src/data/kvv-feed-config.ts";

test("development reads TRIAS through the same-origin Vite proxy", () => {
  assert.deepEqual(readKvvFeedConfig({ DEV: true }), {
    feed: "trias",
    proxyUrl: DEV_TRIAS_PROXY_PATH,
  });
});

test("production uses the deployed proxy unless another is configured", () => {
  assert.deepEqual(readKvvFeedConfig({ DEV: false }), {
    feed: "trias",
    proxyUrl: DEFAULT_TRIAS_PROXY_URL,
  });
  for (const DEV of [true, false]) {
    assert.deepEqual(readKvvFeedConfig({ DEV, VITE_TRIAS_PROXY_URL: "/api/" }), {
      feed: "trias",
      proxyUrl: "/api/",
    });
    assert.deepEqual(
      readKvvFeedConfig({ DEV, VITE_TRIAS_PROXY_URL: "" }),
      readKvvFeedConfig({ DEV }),
    );
  }
});

test("only a true VITE_USE_EFA switches the whole app to EFA", () => {
  for (const value of ["true", "TRUE", "1", " true "]) {
    assert.deepEqual(readKvvFeedConfig({ VITE_USE_EFA: value }), { feed: "efa" });
  }
  for (const value of ["", "false", "0", "no"]) {
    assert.equal(readKvvFeedConfig({ VITE_USE_EFA: value }).feed, "trias");
  }
});
