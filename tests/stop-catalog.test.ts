import assert from "node:assert/strict";
import test from "node:test";
import { findCatalogStop, kvvStopCatalog } from "../src/data/generated/kvv-stop-catalog.ts";
import { kvvStopMappingByLocalStopId } from "../src/data/kvv-stop-mappings.ts";
import { transitNetwork } from "../src/data/transit-network.ts";
import type { TransitStop } from "../src/data/transit-types.ts";
import { getDistanceMeters } from "../src/lib/geo.ts";

/**
 * The join between authored stops and the operator's catalog, refreshed by hand per timetable
 * period: a renumbered or retired stop fails here, not on a rider's screen.
 */

test("every stop the app addresses can be located from the catalog", () => {
  assert.equal(transitNetwork.stops.length, Object.keys(kvvStopMappingByLocalStopId).length);
  for (const stop of transitNetwork.stops) {
    assert.ok(
      stop.latitude !== undefined && stop.longitude !== undefined,
      `${stop.id} has no position in the catalog`,
    );
  }
});

test("every mapped provider stop id is still one the operator publishes", () => {
  for (const [localStopId, mapping] of Object.entries(kvvStopMappingByLocalStopId)) {
    for (const providerStopId of [
      mapping.providerStopId,
      ...(mapping.otherProviderStopIds ?? []),
    ]) {
      assert.ok(
        findCatalogStop(providerStopId),
        `${localStopId} is mapped to ${providerStopId}, which the catalog does not carry`,
      );
    }
  }
});

/** No stop point is claimed by two local stops, or resolution would depend on mapping order. */
test("no provider stop point is claimed by two local stops", () => {
  const claimedBy = new Map<string, string>();
  for (const [localStopId, mapping] of Object.entries(kvvStopMappingByLocalStopId)) {
    for (const providerStopId of [
      mapping.providerStopId,
      ...(mapping.otherProviderStopIds ?? []),
    ]) {
      const claimant = claimedBy.get(providerStopId);
      assert.equal(
        claimant,
        undefined,
        `${providerStopId} is claimed by both ${claimant} and ${localStopId}`,
      );
      claimedBy.set(providerStopId, localStopId);
    }
  }
});

/**
 * A place's other stop points must stand near its main one, or trips on that level leave nowhere.
 */
test("a place's other stop points stand near the one its board is requested for", () => {
  for (const [localStopId, mapping] of Object.entries(kvvStopMappingByLocalStopId)) {
    const board = findCatalogStop(mapping.providerStopId);
    for (const providerStopId of mapping.otherProviderStopIds ?? []) {
      const other = findCatalogStop(providerStopId);
      assert.ok(board && other);
      const distance = Math.round(getDistanceMeters(board.latitude, board.longitude, other));
      assert.ok(
        distance <= 400,
        `${localStopId} folds in ${providerStopId}, which stands ${distance} m from its board`,
      );
    }
  }
});

/**
 * A tunnel and street platform are one local stop (EFA answers both from either id); two entries
 * would be two pages of the same board. Recognised by the same base name, close together.
 */
test("no two local stops are the same place under two names", () => {
  const located = transitNetwork.stops.filter(
    (stop): stop is TransitStop & { latitude: number; longitude: number } =>
      stop.latitude !== undefined && stop.longitude !== undefined,
  );

  for (const [index, a] of located.entries()) {
    for (const b of located.slice(index + 1)) {
      if (a.name !== b.name) continue;
      const distance = Math.round(getDistanceMeters(a.latitude, a.longitude, b));
      assert.ok(
        distance > 200,
        `${a.id} and ${b.id} are both ${a.name} ${distance} m apart: one place, so one local stop`,
      );
    }
  }
});

test("positions are inside the area the app serves", () => {
  // Catches swapped coordinates or projected-grid values.
  for (const { name, latitude, longitude } of kvvStopCatalog) {
    assert.ok(latitude > 48.8 && latitude < 49.2, `${name} sits at latitude ${latitude}`);
    assert.ok(longitude > 8.2 && longitude < 8.6, `${name} sits at longitude ${longitude}`);
  }
});

test("the catalog states each stop once", () => {
  const providerStopIds = new Set(kvvStopCatalog.map(({ providerStopId }) => providerStopId));
  assert.equal(providerStopIds.size, kvvStopCatalog.length);
});
