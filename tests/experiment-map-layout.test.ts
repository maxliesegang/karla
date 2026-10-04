import assert from "node:assert/strict";
import test from "node:test";
import type { DirectTravelTime } from "../src/lib/direct-travel-times.ts";
import { createExperimentMapLayout } from "../src/lib/experiment-map-layout.ts";
import { getGeoLinkId, type MapDrawing } from "../src/lib/geo-map.ts";

const drawing: MapDrawing = {
  stops: new Map(
    ["a", "b", "c"].map((id, index) => [
      id,
      { id, name: id.toUpperCase(), x: 100 + index * 100, y: 100, lineIds: ["S1"] },
    ]),
  ),
  links: [
    { id: getGeoLinkId("a", "b"), fromId: "a", toId: "b", lineIds: ["S1"] },
    { id: getGeoLinkId("b", "c"), fromId: "b", toId: "c", lineIds: ["S1"] },
  ],
};
const options = {
  bounds: { x: 0, y: 0, width: 500, height: 300 },
  scale: 1,
  places: [],
  feedNow: 0,
};

test("through stops are named when zoom leaves room; endpoints stay named", () => {
  const layout = createExperimentMapLayout(drawing);
  const wide = layout.readLabels(options);
  assert.deepEqual([...wide.labels.keys()], ["a", "c", "b"]);
  assert.ok([...wide.labels.values()].every(({ isAtRest }) => isAtRest));
  const small = layout.readLabels({ ...options, scale: 0.4 });
  assert.deepEqual([...small.labels.keys()], ["a", "c"]);
});

test("quiet stops are named when selected or reached, with minutes from the feed clock", () => {
  const layout = createExperimentMapLayout(drawing);
  const quietStopIds = new Set(["b", "c"]);
  assert.deepEqual([...layout.readLabels({ ...options, quietStopIds }).labels.keys()], ["a"]);
  const times = new Map<string, DirectTravelTime>([
    ["c", { lineId: "S1", departsAt: 0, arrivesAt: 180_000, stopIds: ["b", "c"] }],
  ]);
  const selected = layout.readLabels({ ...options, quietStopIds, selectedStopId: "b", times });
  assert.deepEqual([...selected.labels.keys()], ["b", "c"]);
  assert.equal(selected.labels.get("b")?.isAtRest, false);
  assert.equal(selected.labels.get("c")?.minutes, 3);
  const later = layout.readLabels({
    ...options,
    quietStopIds,
    selectedStopId: "b",
    times,
    feedNow: 60_000,
  });
  assert.equal(later.labels.get("c")?.minutes, 2);
});

test("shared rides light each corridor with unique lines in sign order", () => {
  const layout = createExperimentMapLayout(drawing);
  const times = new Map<string, DirectTravelTime>([
    ["b", { lineId: "S11", departsAt: 0, arrivesAt: 60_000, stopIds: ["a", "b"] }],
    ["c", { lineId: "S11", departsAt: 0, arrivesAt: 120_000, stopIds: ["a", "b", "c"] }],
    ["other", { lineId: "S1", departsAt: 0, arrivesAt: 60_000, stopIds: ["b", "a"] }],
  ]);
  const { litLineIdsByLinkId } = layout.readLabels({ ...options, selectedStopId: "a", times });
  assert.deepEqual(litLineIdsByLinkId?.get(getGeoLinkId("a", "b")), ["S1", "S11"]);
  assert.deepEqual(litLineIdsByLinkId?.get(getGeoLinkId("b", "c")), ["S11"]);
});

test("labels clear background place names and remain empty before measurement", () => {
  const layout = createExperimentMapLayout(drawing);
  const placed = layout.readLabels({ ...options, places: [{ name: "Town", x: 125, y: 100 }] });
  assert.equal(placed.placeLabels.length, 1);
  assert.notEqual(placed.labels.get("a")?.side, "right");
  const unmeasured = layout.readLabels({ ...options, scale: undefined });
  assert.equal(unmeasured.labels.size, 0);
  assert.deepEqual(unmeasured.placeLabels, []);
});
