import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import type { NearbyStopsController, NearbyStopsState } from "../src/hooks/nearby-stops.ts";
import { useNearestZentrumStopOpening } from "../src/hooks/zentrum-nearest-stop.ts";
import {
  zentrumExperiments,
  getZentrumExperimentsFromStored,
} from "../src/lib/zentrum-experiments.ts";

const { act } = await import("react");

const drawn = new Map([
  ["marktplatz", ["1", "S1"]],
  ["kronenplatz", ["1"]],
]);

const nearby = (stopId: string) => ({
  stop: { id: stopId, name: stopId },
  distanceMeters: 120,
});

type Props = { state: NearbyStopsState; isAddressChosen: boolean };

async function renderOpening(initial: Props) {
  const asked: string[] = [];
  const opened: string[] = [];
  const locate = () => asked.push("locate");
  const onOpenStop = (stopId: string) => opened.push(stopId);
  const hook = await renderHook<Props, string | undefined>(
    ({ state, isAddressChosen }) =>
      useNearestZentrumStopOpening(
        { ...state, locate } as NearbyStopsController,
        drawn,
        isAddressChosen,
        onOpenStop,
      ),
    initial,
  );
  return { hook, asked, opened };
}

const wantNearest = (isWanted: boolean) =>
  act(() =>
    zentrumExperiments.write({
      ...getZentrumExperimentsFromStored(null),
      openAt: isWanted ? "nearest" : "plan",
    }),
  );

test("opens the nearest drawn stop once, skipping a nearer one the plan does not draw", async () => {
  window.localStorage.clear();
  await wantNearest(true);
  const { hook, asked, opened } = await renderOpening({
    state: { status: "idle", stops: [] },
    isAddressChosen: false,
  });
  try {
    assert.deepEqual(asked, ["locate"]);
    await hook.rerender({ state: { status: "locating", stops: [] }, isAddressChosen: false });
    assert.equal(hook.current, "Standort wird bestimmt …");

    const ready: NearbyStopsState = {
      status: "ready",
      stops: [nearby("waldstadt"), nearby("kronenplatz"), nearby("marktplatz")],
    };
    await hook.rerender({ state: ready, isAddressChosen: false });
    assert.deepEqual(opened, ["kronenplatz"]);

    // Closing the opened stop leaves the plan whole for the rest of the visit.
    await hook.rerender({ state: ready, isAddressChosen: true });
    await hook.rerender({ state: ready, isAddressChosen: false });
    assert.deepEqual(opened, ["kronenplatz"]);
    assert.deepEqual(asked, ["locate"]);
  } finally {
    await hook.unmount();
  }
});

test("never overrides an address, and asks nothing unless chosen", async () => {
  window.localStorage.clear();
  await wantNearest(false);
  const { hook, asked } = await renderOpening({
    state: { status: "idle", stops: [] },
    isAddressChosen: false,
  });
  try {
    assert.deepEqual(asked, []);
    await hook.rerender({ state: { status: "idle", stops: [] }, isAddressChosen: true });
    await wantNearest(true);
    assert.deepEqual(asked, []);
  } finally {
    await hook.unmount();
  }
});

test("says why no stop opened", async () => {
  window.localStorage.clear();
  await wantNearest(true);
  const { hook, opened } = await renderOpening({
    state: { status: "idle", stops: [] },
    isAddressChosen: false,
  });
  try {
    await hook.rerender({
      state: { status: "ready", stops: [nearby("waldstadt")] },
      isAddressChosen: false,
    });
    assert.equal(hook.current, "Keine Haltestelle des Plans in der Nähe");
    assert.deepEqual(opened, []);
  } finally {
    await hook.unmount();
  }
});
