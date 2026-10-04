import assert from "node:assert/strict";
import test from "node:test";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  },
});

const { findRecentStops, forgetRecentStops, rememberStopVisit } = await import(
  "../src/lib/recent-stops.ts"
);

test("forgetting clears every remembered stop from the device, the legacy entry included", () => {
  rememberStopVisit("europaplatz", "Europaplatz");
  values.set("karla:recent-stop", JSON.stringify({ stopId: "marktplatz", visitedAt: Date.now() }));
  assert.equal(findRecentStops().length, 1);

  forgetRecentStops();

  assert.deepEqual(findRecentStops(), []);
  assert.equal(values.size, 0);
});
