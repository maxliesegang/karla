import assert from "node:assert/strict";
import test from "node:test";
import {
  getSavedStopsFromStored,
  withoutSavedStop,
  withSavedStop,
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

test("an unreadable stored value gives no stops, and unreadable entries drop", () => {
  assert.deepEqual(getSavedStopsFromStored(null), []);
  assert.deepEqual(getSavedStopsFromStored({ stopId: "a" }), []);
  assert.deepEqual(getSavedStopsFromStored([{ stopId: "a", stopName: "A" }, { stopId: "b" }, 3]), [
    { stopId: "a", stopName: "A" },
  ]);
});
