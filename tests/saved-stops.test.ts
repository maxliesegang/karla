import assert from "node:assert/strict";
import test from "node:test";
import {
  getSavedStopsFromStored,
  withoutSavedStop,
  withSavedStop,
  withSavedStopMoved,
} from "../src/lib/saved-stops.ts";

test("a saved stop goes to the end, and saving it again only refreshes its name", () => {
  const saved = withSavedStop(withSavedStop([], "europaplatz", "Europaplatz"), "kronenplatz", "K");
  assert.deepEqual(withSavedStop(saved, "europaplatz", "Europaplatz/Postgalerie"), [
    { stopId: "europaplatz", stopName: "Europaplatz/Postgalerie" },
    { stopId: "kronenplatz", stopName: "K" },
  ]);
});

test("removing a stop keeps the others in order", () => {
  const saved = [
    { stopId: "a", stopName: "A" },
    { stopId: "b", stopName: "B" },
    { stopId: "c", stopName: "C" },
  ];
  assert.deepEqual(
    withoutSavedStop(saved, "b").map((stop) => stop.stopId),
    ["a", "c"],
  );
});

test("a stop moves one place at a time, and stays put at either end", () => {
  const saved = [
    { stopId: "a", stopName: "A" },
    { stopId: "b", stopName: "B" },
    { stopId: "c", stopName: "C" },
  ];
  const ids = (stops: readonly { stopId: string }[]) => stops.map((stop) => stop.stopId);
  assert.deepEqual(ids(withSavedStopMoved(saved, "c", -1)), ["a", "c", "b"]);
  assert.deepEqual(ids(withSavedStopMoved(saved, "a", 1)), ["b", "a", "c"]);
  assert.deepEqual(ids(withSavedStopMoved(saved, "a", -1)), ["a", "b", "c"]);
  assert.deepEqual(ids(withSavedStopMoved(saved, "c", 1)), ["a", "b", "c"]);
  assert.deepEqual(ids(withSavedStopMoved(saved, "x", 1)), ["a", "b", "c"]);
});

test("an unreadable stored value gives no stops, and unreadable entries drop", () => {
  assert.deepEqual(getSavedStopsFromStored(null), []);
  assert.deepEqual(getSavedStopsFromStored({ stopId: "a" }), []);
  assert.deepEqual(getSavedStopsFromStored([{ stopId: "a", stopName: "A" }, { stopId: "b" }, 3]), [
    { stopId: "a", stopName: "A" },
  ]);
});
