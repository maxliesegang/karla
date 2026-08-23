import assert from "node:assert/strict";
import test from "node:test";
import type { TransitStop } from "../src/data/transit-types.ts";
import { getNearbyStops } from "../src/lib/nearby-stops.ts";

const createStop = (id: string, latitude?: number, longitude?: number): TransitStop => ({
  id,
  name: id,
  latitude,
  longitude,
});

test("orders locatable stops by distance and excludes remote or unlocated stops", () => {
  const stops = [
    createStop("far", 49.02, 8.4),
    createStop("unlocated"),
    createStop("near", 49.0002, 8.4),
    createStop("nearest", 49.0001, 8.4),
  ];

  assert.deepEqual(
    getNearbyStops(stops, 49, 8.4, 1_000).map(({ stop }) => stop.id),
    ["nearest", "near"],
  );
});

test("caps the result count after distance ordering", () => {
  const stops = [
    createStop("third", 49.0003, 8.4),
    createStop("first", 49.0001, 8.4),
    createStop("second", 49.0002, 8.4),
  ];

  assert.deepEqual(
    getNearbyStops(stops, 49, 8.4, 1_000, 2).map(({ stop }) => stop.id),
    ["first", "second"],
  );
});

test("offers six nearby stops by default", () => {
  const stops = Array.from({ length: 7 }, (_, index) =>
    createStop(String(index), 49 + (index + 1) / 100_000, 8.4),
  );

  assert.equal(getNearbyStops(stops, 49, 8.4, 1_000).length, 6);
});
