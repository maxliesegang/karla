import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TransitNetwork, TripCall } from "../src/data/transit-types.ts";
import { buildLineDiagramStops, getLineDiagramVehicles } from "../src/lib/line-diagram.ts";
import { getDrawableLineBundleOffers, getLineBundleTrunk } from "../src/lib/line-bundles.ts";
import { createCall } from "./support/calls.ts";
import { createRunMotions } from "../src/lib/vehicle-positioning.ts";
import { createDeparture } from "./support/fixtures.ts";

/** One drawing's motion record, shared across this file. */
const motions = createRunMotions();

/**
 * The trunk-to-leg handover: every vehicle stands on exactly one list, the trunk while the lines
 * run together, its own leg past the parting stop.
 */

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);

const network: TransitNetwork = {
  stops: ["hochstetten", "neureut", "busenbach", "etzenrot", "langensteinbach"].map((id) => ({
    id,
    name: id.toUpperCase(),
  })),
  lines: [],
};

const trip = (id: string, lineId: string, calls: readonly TripCall[]): Departure =>
  createDeparture({
    id,
    tripId: id,
    lineId,
    transportMode: "lightRail",
    destination: calls[calls.length - 1].stopName,
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "hochstetten",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: calls,
  });

// Together to Busenbach, apart past it.
const s1Calls = [
  call("hochstetten", 0),
  call("neureut", 6),
  call("busenbach", 12),
  call("etzenrot", 18),
];
const s11Calls = [
  call("hochstetten", 2),
  call("neureut", 8),
  call("busenbach", 14),
  call("langensteinbach", 20),
];

const trunk = getLineBundleTrunk(
  [
    { lineId: "S1", calls: s1Calls, destination: "ETZENROT" },
    { lineId: "S11", calls: s11Calls, destination: "LANGENSTEINBACH" },
  ],
  ["hochstetten"],
);

/** Rows in reverse travel order, as the panel builds them. */
const stopsOf = (calls: readonly TripCall[]) =>
  buildLineDiagramStops(network, [...calls].reverse());

const placedOn = (calls: readonly TripCall[], vehicles: readonly Departure[], feedNow: number) =>
  getLineDiagramVehicles(stopsOf(calls), vehicles, [], undefined, feedNow, { motions });

test("a vehicle still on the shared stretch stands on the trunk and on no leg", () => {
  assert.ok(trunk);
  const [aheadS1, aheadS11] = trunk.branches;
  const s1 = trip("s1-run", "S1", s1Calls);
  // Nine minutes in: between Neureut and Busenbach, on the trunk.
  const feedNow = start + 9 * 60_000;

  assert.equal(placedOn(trunk.calls, [s1], feedNow).length, 1);
  assert.equal(placedOn(aheadS1.calls, [s1], feedNow).length, 0);
  assert.equal(placedOn(aheadS11.calls, [s1], feedNow).length, 0);
});

test("a vehicle past the junction stands on its own leg and leaves the trunk", () => {
  assert.ok(trunk);
  const [aheadS1, aheadS11] = trunk.branches;
  const s1 = trip("s1-run", "S1", s1Calls);
  // Fifteen minutes in: past Busenbach, on the S1 leg.
  const feedNow = start + 15 * 60_000;

  assert.equal(placedOn(trunk.calls, [s1], feedNow).length, 0);
  assert.equal(placedOn(aheadS1.calls, [s1], feedNow).length, 1);
  assert.equal(placedOn(aheadS11.calls, [s1], feedNow).length, 0);
});

test("each leg is drawn from the junction, so its first link has both its ends", () => {
  assert.ok(trunk);
  const [aheadS1] = trunk.branches;
  // A leg's rows top to bottom: its terminus down to the junction.
  assert.deepEqual(
    stopsOf(aheadS1.calls).map(({ stopId }) => stopId),
    ["etzenrot", "busenbach"],
  );
  // The junction is the trunk's last call, drawn only there.
  assert.equal(aheadS1.calls[0].localStopId, trunk.calls[trunk.calls.length - 1].localStopId);
});

/**
 * Offers must match the diagram: shown only where the drawn trip runs the observed corridor. Not
 * gated on a sibling trip being loaded, since none is until the sibling is added.
 */
const sharedAhead = [call("neureut", 6), call("busenbach", 12), call("etzenrot", 18)];
const offerOf = (lineId: string, sharedRoutes = [sharedAhead]) => ({ lineId, sharedRoutes });

const drawableOffers = (drawnCalls: readonly TripCall[], offers = [offerOf("S11")]) =>
  getDrawableLineBundleOffers({
    offers,
    drawnCalls,
    riderStopIds: ["hochstetten"],
  });

const drawableLineIds = (...args: Parameters<typeof drawableOffers>) =>
  drawableOffers(...args).map(({ lineId }) => lineId);

test("offers a sibling on the corridor's evidence alone, with none of its trips in hand", () => {
  assert.deepEqual(drawableLineIds(s1Calls), ["S11"]);
});

test("drops an offer whose corridor lies the other way out of the stop", () => {
  const backwards = [call("hochstetten", 0), call("langensteinbach", 6), call("busenbach", 12)];
  assert.deepEqual(drawableLineIds(backwards), []);
});

test("drops an offer the drawn trip leaves before the shared stretch is one", () => {
  const shortWorking = [call("hochstetten", 0), call("neureut", 6), call("langensteinbach", 12)];
  assert.deepEqual(drawableLineIds(shortWorking), []);
});

/**
 * A corridor runs both ways out of a stop: at Ettlingen Neuwiesenreben S1 and S11 share a long
 * stretch north and a short one south, and a southbound trip must still get its offer.
 */
const sharedBehind = [call("neureut", 6), call("hochstetten", 12), call("langensteinbach", 18)];

test("offers the sibling on the stretch the drawn trip runs along, not the stop's longest", () => {
  const bothWays = offerOf("S11", [sharedBehind, sharedAhead]);
  const southbound = [call("hochstetten", 0), ...sharedAhead];

  assert.deepEqual(
    drawableOffers(southbound, [bothWays]).map(({ lineId, sharedUntilStopName }) => [
      lineId,
      sharedUntilStopName,
    ]),
    [["S11", "ETZENROT"]],
  );
});

test("promises only as far as the drawn trip confirms the corridor", () => {
  // Observed together to Langensteinbach, but this trip turns off at Etzenrot.
  const runsOn = offerOf("S11", [[...sharedAhead, call("langensteinbach", 24)]]);
  const drawn = [call("hochstetten", 0), ...sharedAhead];

  assert.deepEqual(
    drawableOffers(drawn, [runsOn]).map(({ sharedUntilStopName }) => sharedUntilStopName),
    ["ETZENROT"],
  );
});

/**
 * The drawn trip is read out of the rider's stop both ways, so an offer can cover the stretch
 * behind.
 */
test("offers the sibling over the shared stretch the drawn trip came along", () => {
  const underway = [
    ...[...sharedAhead].reverse(),
    call("hochstetten", 12),
    call("grenzstraße", 18),
  ];

  assert.deepEqual(
    drawableOffers(underway).map(({ sharedUntilStopName }) => sharedUntilStopName),
    ["ETZENROT"],
  );
});

test("promises only as far as the drawn trip came along the corridor", () => {
  // This trip started at Busenbach: behind the stop it confirms one call short of the corridor.
  const startedShort = [
    call("busenbach", 0),
    call("neureut", 6),
    call("hochstetten", 12),
    call("grenzstraße", 18),
  ];

  assert.deepEqual(drawableOffers(startedShort), []);
});
