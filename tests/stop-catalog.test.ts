import assert from "node:assert/strict";
import test from "node:test";
import { findCatalogStop, kvvStopCatalog } from "../src/data/generated/kvv-stop-catalog.ts";
import { kvvStopMappingByLocalStopId } from "../src/data/kvv-stop-mappings.ts";
import { transitNetwork } from "../src/data/transit-network.ts";
import type { TransitStop } from "../src/data/transit-types.ts";
import { getDistanceMeters } from "../src/lib/geo.ts";

/**
 * What these hold is the join between what someone decided and what the operator publishes.
 *
 * The catalog is refreshed by hand (`npm run refresh:stops`) against a timetable period that ends,
 * so the failure worth catching is a stop the app addresses that the operator has since renumbered
 * or retired. That used to surface as a broken board in a rider's hand; here it is a failing test.
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

/**
 * A stop point belongs to one place, so no two local stops may claim it: a trip calling there
 * resolves to a single local stop, and two claims on it would make which one depend on the order
 * the mapping happens to be written in.
 */
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
 * The other half of the collapse the test below guards.
 *
 * Where two stop points were folded into one local stop, both must still resolve to it. Missing,
 * the folded-away platform is not an unmapped stop the app has never met — it is the level half
 * this place's trips actually run on, and every trip through it leaves the page it is read from
 * bound for a stop nothing else knows.
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
 * The one that guards the collapse.
 *
 * A place with a tunnel and a street platform is one local stop, because EFA answers both levels
 * from either stop id — two entries for it would be two pages showing the same departures, and the
 * app would ask the provider twice for the same board. Such a pair is recognisable in the built
 * network: the same name once the operator's stop-point qualifier is off it, a stone's throw apart.
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
  // Generous around Karlsruhe: what this catches is a swapped latitude and longitude, or a
  // coordinate read out of the feed's own projected grid rather than in degrees.
  for (const { name, latitude, longitude } of kvvStopCatalog) {
    assert.ok(latitude > 48.8 && latitude < 49.2, `${name} sits at latitude ${latitude}`);
    assert.ok(longitude > 8.2 && longitude < 8.6, `${name} sits at longitude ${longitude}`);
  }
});

test("the catalog states each stop once", () => {
  const providerStopIds = new Set(kvvStopCatalog.map(({ providerStopId }) => providerStopId));
  assert.equal(providerStopIds.size, kvvStopCatalog.length);
});
