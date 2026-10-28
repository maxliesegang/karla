import assert from "node:assert/strict";
import test from "node:test";
import { findCatalogStop, stopCatalog } from "../src/networks/kvv/generated/stop-catalog.ts";
import { stopPlaces } from "../src/networks/kvv/generated/stop-places.ts";
import { transitNetwork } from "../src/data/transit-network.ts";
import type { StopPlace } from "../src/data/transit-types.ts";
import { getDistanceMeters } from "../src/lib/geo.ts";
import { DYNAMIC_STOP_ID_PATTERN, hashStopPointId } from "../src/data/stop-registry.ts";
import { ZENTRUM_OBSERVATION_POST_STOP_IDS, zentrumStopIds } from "../src/data/zentrum-stops.ts";
import {
  ZENTRUM_SCHEMATIC_NODES,
  getZentrumSchematicStopId,
} from "../src/lib/zentrum-schematic-plan.ts";
import { kvvNetwork } from "../src/networks/kvv/kvv-network.ts";
import { REGION_PLANS } from "../src/networks/kvv/generated/region-plan.ts";

/**
 * The stop places against the catalog they are derived from, refreshed by hand per timetable
 * period: a renumbered or retired stop fails here, not on a rider's screen.
 */

test("every stop the app addresses can be located from the catalog", () => {
  assert.equal(transitNetwork.stops.length, Object.keys(stopPlaces).length);
  for (const stop of transitNetwork.stops) {
    assert.ok(
      stop.latitude !== undefined && stop.longitude !== undefined,
      `${stop.id} has no position in the catalog`,
    );
  }
});

test("every stop place's stop point is still one the operator publishes", () => {
  for (const [stopPlaceId, { stopPoints }] of Object.entries(stopPlaces)) {
    for (const stopPointId of stopPoints) {
      assert.ok(
        findCatalogStop(stopPointId),
        `${stopPlaceId} joins ${stopPointId}, which the catalog does not carry`,
      );
    }
  }
});

/** No stop point is claimed by two local stops, or resolution would depend on their order. */
test("no stop point is claimed by two local stops", () => {
  const claimedBy = new Map<string, string>();
  for (const [stopPlaceId, { stopPoints }] of Object.entries(stopPlaces)) {
    for (const stopPointId of stopPoints) {
      const claimant = claimedBy.get(stopPointId);
      assert.equal(
        claimant,
        undefined,
        `${stopPointId} is claimed by both ${claimant} and ${stopPlaceId}`,
      );
      claimedBy.set(stopPointId, stopPlaceId);
    }
  }
});

/** A place's stop points stand together, or one page would cover two places. */
test("a place's stop points stand near the one that names it", () => {
  for (const [stopPlaceId, { stopPoints }] of Object.entries(stopPlaces)) {
    const [first, ...others] = stopPoints.map((stopPointId) => findCatalogStop(stopPointId));
    for (const [index, other] of others.entries()) {
      assert.ok(first && other);
      const distance = Math.round(getDistanceMeters(first.latitude, first.longitude, other));
      assert.ok(
        distance <= 400,
        `${stopPlaceId} joins ${stopPoints[index + 1]}, which stands ${distance} m from ${stopPoints[0]}`,
      );
    }
  }
});

/**
 * A tunnel and street platform are one local stop; two entries would be two pages of one place.
 * Recognised by the same base name, close together.
 */
test("no two local stops are the same place under two names", () => {
  const located = transitNetwork.stops.filter(
    (stop): stop is StopPlace & { latitude: number; longitude: number } =>
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
  for (const { name, latitude, longitude } of stopCatalog) {
    assert.ok(latitude > 48.8 && latitude < 49.2, `${name} sits at latitude ${latitude}`);
    assert.ok(longitude > 8.2 && longitude < 8.6, `${name} sits at longitude ${longitude}`);
  }
});

test("the catalog states each stop once", () => {
  const globalIds = new Set(stopCatalog.map(({ globalId }) => globalId));
  assert.equal(globalIds.size, stopCatalog.length);
});

/**
 * Stop ids written by hand or solved offline are addresses into the derived places; a refresh that
 * renames a place fails here. Beyond the catalog a plan names dynamic stops, which must not be one
 * of its stops, or the stop would resolve to its place instead.
 */
test("every stop the app names by hand is still one of its places", () => {
  const catalogDigests = new Set(stopCatalog.map(({ globalId }) => hashStopPointId(globalId)));
  const named: [string, readonly string[]][] = [
    ["defaultStopId", [kvvNetwork.defaultStopId]],
    ["suggestedStopIds", kvvNetwork.suggestedStopIds],
    ["reachObservationPostStopIds", kvvNetwork.reachObservationPostStopIds],
    ["zentrumStopIds", zentrumStopIds],
    ["ZENTRUM_OBSERVATION_POST_STOP_IDS", ZENTRUM_OBSERVATION_POST_STOP_IDS],
    [
      "ZENTRUM_SCHEMATIC_NODES",
      ZENTRUM_SCHEMATIC_NODES.map(({ id }) => getZentrumSchematicStopId(id)),
    ],
    ...Object.entries(REGION_PLANS).map(([scale, { axis, nodes }]): [string, readonly string[]] => [
      `REGION_PLANS.${scale}`,
      [...axis, ...nodes.flatMap(({ stopIds }) => stopIds)],
    ]),
  ];
  for (const [list, stopIds] of named) {
    for (const stopId of stopIds) {
      if (Object.hasOwn(stopPlaces, stopId)) continue;
      const digest = DYNAMIC_STOP_ID_PATTERN.exec(stopId)?.[2];
      assert.ok(
        digest && !catalogDigests.has(digest),
        `${list} names ${stopId}, which is no stop place`,
      );
    }
  }
});
