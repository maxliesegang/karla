import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import type { NearbyStopsController, NearbyStopsState } from "../src/hooks/nearby-stops.ts";
import { useNearestZentrumStopOpening } from "../src/hooks/zentrum-nearest-stop.ts";
import {
  zentrumPlanOptions,
  getZentrumPlanOptionsFromStored,
} from "../src/lib/zentrum-plan-options.ts";

const { act } = await import("react");

const drawn = new Map([
  ["marktplatz", ["1", "S1"]],
  ["kronenplatz", ["1"]],
]);

const nearby = (stopId: string) => ({
  stop: { id: stopId, name: stopId },
  distanceMeters: 120,
});

type Props = { state: NearbyStopsState; hasRouteSelection: boolean };

async function renderOpening(initial: Props) {
  const asked: string[] = [];
  const opened: string[] = [];
  const locate = () => asked.push("locate");
  const onOpenStop = (stopId: string) => opened.push(stopId);
  const hook = await renderHook<Props, string | undefined>(
    ({ state, hasRouteSelection }) =>
      useNearestZentrumStopOpening(
        { ...state, locate } as NearbyStopsController,
        drawn,
        hasRouteSelection,
        onOpenStop,
      ),
    initial,
  );
  return { hook, asked, opened };
}

const setNearestStopOpening = (shouldOpenNearestStop: boolean) =>
  act(() =>
    zentrumPlanOptions.write({
      ...getZentrumPlanOptionsFromStored(null),
      initialView: shouldOpenNearestStop ? "nearest" : "plan",
    }),
  );

test("opens the nearest drawn stop once, skipping a nearer one the plan does not draw", async () => {
  window.localStorage.clear();
  await setNearestStopOpening(true);
  const { hook, asked, opened } = await renderOpening({
    state: { status: "idle", stops: [] },
    hasRouteSelection: false,
  });
  try {
    assert.deepEqual(asked, ["locate"]);
    await hook.rerender({ state: { status: "locating", stops: [] }, hasRouteSelection: false });
    assert.equal(hook.current, "Standort wird bestimmt …");

    const ready: NearbyStopsState = {
      status: "ready",
      stops: [nearby("waldstadt"), nearby("kronenplatz"), nearby("marktplatz")],
    };
    await hook.rerender({ state: ready, hasRouteSelection: false });
    assert.deepEqual(opened, ["kronenplatz"]);

    // Closing the opened stop leaves the plan whole for the rest of the visit.
    await hook.rerender({ state: ready, hasRouteSelection: true });
    await hook.rerender({ state: ready, hasRouteSelection: false });
    assert.deepEqual(opened, ["kronenplatz"]);
    assert.deepEqual(asked, ["locate"]);
  } finally {
    await hook.unmount();
  }
});

test("never overrides an address, and asks nothing unless chosen", async () => {
  window.localStorage.clear();
  await setNearestStopOpening(false);
  const { hook, asked } = await renderOpening({
    state: { status: "idle", stops: [] },
    hasRouteSelection: false,
  });
  try {
    assert.deepEqual(asked, []);
    await hook.rerender({ state: { status: "idle", stops: [] }, hasRouteSelection: true });
    await setNearestStopOpening(true);
    assert.deepEqual(asked, []);
  } finally {
    await hook.unmount();
  }
});

test("says why no stop opened", async () => {
  window.localStorage.clear();
  await setNearestStopOpening(true);
  const { hook, opened } = await renderOpening({
    state: { status: "idle", stops: [] },
    hasRouteSelection: false,
  });
  try {
    await hook.rerender({
      state: { status: "ready", stops: [nearby("waldstadt")] },
      hasRouteSelection: false,
    });
    assert.equal(hook.current, "Keine Haltestelle des Plans in der Nähe");
    assert.deepEqual(opened, []);
  } finally {
    await hook.unmount();
  }
});
