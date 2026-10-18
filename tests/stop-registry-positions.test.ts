import assert from "node:assert/strict";
import test from "node:test";
import { findCatalogStop } from "../src/data/generated/kvv-stop-catalog.ts";
import { StopRegistry } from "../src/data/stop-registry.ts";

test("an unlocated call stands where the catalog puts its stop; a stated position is kept", () => {
  const registry = new StopRegistry([]);
  const catalogStop = findCatalogStop("7000037");
  assert.ok(catalogStop);

  const [unlocated, located] = registry.toTripCalls([
    { stopName: "Europaplatz", providerId: "7000037" },
    { stopName: "Europaplatz", providerId: "7000037", latitude: 49.0101, longitude: 8.3949 },
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
  const [call] = registry.toTripCalls([
    { stopName: "Freudenstadt Hauptbahnhof", providerId: "de:08237:1050" },
  ]);
  assert.deepEqual([call.latitude, call.longitude], [48.4637, 8.4105]);
});
