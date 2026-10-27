import assert from "node:assert/strict";
import test from "node:test";
import { findCatalogStop } from "../src/networks/kvv/generated/stop-catalog.ts";
import { bayPositionByKey } from "../src/networks/kvv/generated/bay-positions.ts";
import { StopRegistry } from "../src/data/stop-registry.ts";

test("an unlocated call stands where the catalog puts its stop; a stated position is kept", () => {
  const registry = new StopRegistry([]);
  const catalogStop = findCatalogStop("de:08212:37");
  assert.ok(catalogStop);

  const [unlocated, located] = registry.toCalls([
    { stopName: "Europaplatz", providerId: "de:08212:37" },
    { stopName: "Europaplatz", providerId: "de:08212:37", latitude: 49.0101, longitude: 8.3949 },
  ]);

  assert.deepEqual(
    [unlocated.latitude, unlocated.longitude],
    [catalogStop.latitude, catalogStop.longitude],
  );
  assert.deepEqual([located.latitude, located.longitude], [49.0101, 8.3949]);
});

test("outside the city, an unlocated call takes the position its stop was registered with", () => {
  const registry = new StopRegistry([]);
  registry.register({
    providerId: "de:08237:1050",
    name: "Hauptbahnhof",
    placeName: "Freudenstadt",
    latitude: 48.4637,
    longitude: 8.4105,
  });
  const [call] = registry.toCalls([
    { stopName: "Freudenstadt Hauptbahnhof", providerId: "de:08237:1050" },
  ]);
  assert.deepEqual([call.latitude, call.longitude], [48.4637, 8.4105]);
});

test("an unlocated call at a known rail platform stands at that platform", () => {
  const [street, tunnel] = new StopRegistry([]).toCalls([
    { stopName: "Europaplatz", providerId: "de:08212:37", bay: "3" },
    { stopName: "Europaplatz (U)", providerId: "de:08212:1004", bay: "1(U)" },
  ]);
  for (const [call, key] of [
    [street, "de:08212:37|3"],
    [tunnel, "de:08212:1004|1(U)"],
  ] as const) {
    const bay = bayPositionByKey.get(key);
    assert.ok(bay);
    assert.deepEqual([call.latitude, call.longitude], [bay.latitude, bay.longitude]);
  }
});
