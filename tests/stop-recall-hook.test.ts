import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import type { StopPlace } from "../src/data/transit-types.ts";
import { useStopRecall } from "../src/hooks/stop-recall.ts";
import { appSettings, DEFAULT_APP_SETTINGS } from "../src/lib/app-settings.ts";
import { findRecentStops, rememberStopVisit } from "../src/lib/recent-stops.ts";
import { chosenStopPlaceParts, chooseStopPlacePart } from "../src/lib/stop-place-parts.ts";
import { savedStops } from "../src/lib/saved-stops.ts";

const { act } = await import("react");

test("turning history off clears visits, preserves choices and favorites, and allows new choices", async () => {
  window.localStorage.clear();
  appSettings.write(DEFAULT_APP_SETTINGS);
  chosenStopPlaceParts.write({});
  chooseStopPlacePart("europaplatz", "unten");
  const favorites = [{ stopId: "europaplatz", stopName: "Europaplatz" }];
  savedStops.write(favorites);
  rememberStopVisit("europaplatz", "Europaplatz");
  const recall = await renderHook<StopPlace | undefined, ReturnType<typeof useStopRecall>>(
    useStopRecall,
    undefined,
  );
  try {
    assert.equal(recall.current.recentStops[0]?.stopId, "europaplatz");

    await act(() => appSettings.write({ ...DEFAULT_APP_SETTINGS, isRememberingStops: false }));
    assert.deepEqual(recall.current.recentStops, []);
    assert.deepEqual(findRecentStops(), []);
    assert.deepEqual(chosenStopPlaceParts.read(), { europaplatz: "unten" });
    assert.deepEqual(savedStops.read(), favorites);

    const stop: StopPlace = { id: "marktplatz", name: "Marktplatz" };
    await recall.rerender(stop);
    assert.deepEqual(findRecentStops(), []);
    chooseStopPlacePart("marktplatz", "pyramide");
    assert.deepEqual(chosenStopPlaceParts.read(), {
      europaplatz: "unten",
      marktplatz: "pyramide",
    });
    await recall.rerender(undefined);
    assert.deepEqual(chosenStopPlaceParts.read(), {
      europaplatz: "unten",
      marktplatz: "pyramide",
    });

    await recall.rerender(stop);
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
    appSettings.write(DEFAULT_APP_SETTINGS);
    chosenStopPlaceParts.write({});
    savedStops.write([]);
    window.localStorage.clear();
  }
});
