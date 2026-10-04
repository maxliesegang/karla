import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import type { TransitStop } from "../src/data/transit-types.ts";
import { useStopRecall } from "../src/hooks/stop-recall.ts";
import { appSettings, DEFAULT_APP_SETTINGS } from "../src/lib/app-settings.ts";
import { findRecentStops, rememberStopVisit } from "../src/lib/recent-stops.ts";

const { act } = await import("react");

test("turning stop memory off clears visits and turning it back on remembers only new visits", async () => {
  window.localStorage.clear();
  appSettings.write(DEFAULT_APP_SETTINGS);
  rememberStopVisit("europaplatz", "Europaplatz");
  const recall = await renderHook<TransitStop | undefined, ReturnType<typeof useStopRecall>>(
    useStopRecall,
    undefined,
  );
  try {
    assert.equal(recall.current.recentStops[0]?.stopId, "europaplatz");

    await act(() => appSettings.write({ ...DEFAULT_APP_SETTINGS, isRememberingStops: false }));
    assert.deepEqual(recall.current.recentStops, []);
    assert.deepEqual(findRecentStops(), []);

    const stop: TransitStop = { id: "marktplatz", name: "Marktplatz" };
    await recall.rerender(stop);
    assert.deepEqual(findRecentStops(), []);

    await act(() => appSettings.write(DEFAULT_APP_SETTINGS));
    await recall.rerender(undefined);
    assert.deepEqual(
      recall.current.recentStops.map(({ stopId }) => stopId),
      ["marktplatz"],
    );
    assert.deepEqual(
      findRecentStops().map(({ stopId }) => stopId),
      ["marktplatz"],
    );
  } finally {
    await recall.unmount();
    window.localStorage.clear();
  }
});
