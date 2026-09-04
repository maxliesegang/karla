import assert from "node:assert/strict";
import test from "node:test";
import type {
  Departure,
  TransitLine,
  TransitNetwork,
  TripCall,
} from "../src/data/transit-types.ts";
import { buildLineDiagramStops, getLineDiagramVehicles } from "../src/lib/line-diagram.ts";
import { getDrawableLineBundleOffers, getLineBundleTrunk } from "../src/lib/line-bundles.ts";
import { createCall } from "./support/calls.ts";

/**
 * The handover between the trunk and its legs.
 *
 * A forked diagram is three coordinate systems, and every vehicle has to stand in exactly one of
 * them: on the trunk while the bundled lines still run together, and on its own leg past the stop
 * they part at. A mark on two lists is one vehicle drawn twice; a mark on none has vanished at the
 * junction.
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

const lineOf = (id: string): TransitLine => ({
  id,
  name: id,
  color: "#000",
  textColor: "#fff",
  destinations: [],
  zentrumStopIds: [],
});

const trip = (id: string, lineId: string, calls: readonly TripCall[]): Departure => ({
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

/** Rows are drawn in reverse travel order, exactly as the panel builds them. */
const stopsOf = (calls: readonly TripCall[], line: TransitLine) =>
  buildLineDiagramStops(network, line, [...calls].reverse(), null);

const placedOn = (
  calls: readonly TripCall[],
  line: TransitLine,
  vehicles: readonly Departure[],
  feedNow: number,
) => getLineDiagramVehicles(stopsOf(calls, line), vehicles, [], undefined, feedNow);

test("a vehicle still on the shared stretch stands on the trunk and on no leg", () => {
  assert.ok(trunk);
  const [aheadS1, aheadS11] = trunk.branches;
  const s1 = trip("s1-run", "S1", s1Calls);
  // Nine minutes in: between Neureut and Busenbach, which is trunk for both lines.
  const feedNow = start + 9 * 60_000;

  assert.equal(placedOn(trunk.calls, lineOf("S1"), [s1], feedNow).length, 1);
  assert.equal(placedOn(aheadS1.calls, lineOf("S1"), [s1], feedNow).length, 0);
  assert.equal(placedOn(aheadS11.calls, lineOf("S11"), [s1], feedNow).length, 0);
});

test("a vehicle past the junction stands on its own leg and leaves the trunk", () => {
  assert.ok(trunk);
  const [aheadS1, aheadS11] = trunk.branches;
  const s1 = trip("s1-run", "S1", s1Calls);
  // Fifteen minutes in: past Busenbach, out on the S1 branch alone.
  const feedNow = start + 15 * 60_000;

  assert.equal(placedOn(trunk.calls, lineOf("S1"), [s1], feedNow).length, 0);
  assert.equal(placedOn(aheadS1.calls, lineOf("S1"), [s1], feedNow).length, 1);
  assert.equal(placedOn(aheadS11.calls, lineOf("S11"), [s1], feedNow).length, 0);
});

test("each leg is drawn from the junction, so its first link has both its ends", () => {
  assert.ok(trunk);
  const [aheadS1] = trunk.branches;
  // The rows a leg draws, top to bottom: its own terminus down to the junction it runs into.
  assert.deepEqual(
    stopsOf(aheadS1.calls, lineOf("S1")).map(({ stopId }) => stopId),
    ["etzenrot", "busenbach"],
  );
  // And that junction is the trunk's own last call, drawn once there and never again on a leg.
  assert.equal(aheadS1.calls[0].localStopId, trunk.calls[trunk.calls.length - 1].localStopId);
});

/**
 * The offer and the diagram have to agree.
 *
 * A corridor observed at some hour is what makes a sibling worth offering; whether the trip on
 * screen actually runs it — ahead of the rider's stop or behind it — is what makes taking the
 * offer mean anything. Where neither holds, the control is not shown at all.
 *
 * What is deliberately *not* asked is whether a trip of the sibling is in hand. The stop's board is
 * asked for the lines the address names, so none ever is until the sibling has been added — an
 * offer that waited for one would never be made, and the feature would be unreachable.
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
 * A stop is served both ways, and so is a corridor.
 *
 * Ettlingen Neuwiesenreben is the case in the network: S1 and S11 run together north to Hochstetten
 * and south to Busenbach, and the northbound stretch is the longer of the two by a wide margin.
 * Read as one stretch per sibling it is the only one kept, and the southbound trip — the one heading
 * for the stop the lines actually part at — is offered nothing.
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
  // The lines are observed together as far as Langensteinbach, but this trip turns off at Etzenrot,
  // and the offer beside it may not name a stop the diagram will not reach.
  const runsOn = offerOf("S11", [[...sharedAhead, call("langensteinbach", 24)]]);
  const drawn = [call("hochstetten", 0), ...sharedAhead];

  assert.deepEqual(
    drawableOffers(drawn, [runsOn]).map(({ sharedUntilStopName }) => sharedUntilStopName),
    ["ETZENROT"],
  );
});

/**
 * The drawn trip is read out of the rider's stop both ways.
 *
 * A trip the diagram holds on to departs, and the rider's stop sits in the middle of its chain
 * from then on: the corridor it came along is drawn behind the stop, as much on screen as the one
 * ahead. A sibling observed running it is offered over that stretch by the same rule either side
 * of the stop — `getLineBundleTrunk` already forks at the near end as well as the far one.
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
  // The lines are observed together as far as Etzenrot, but this trip set out at Busenbach: behind
  // the rider's stop it confirms Neureut and Busenbach alone, one call short of a promise.
  const startedShort = [
    call("busenbach", 0),
    call("neureut", 6),
    call("hochstetten", 12),
    call("grenzstraße", 18),
  ];

  assert.deepEqual(drawableOffers(startedShort), []);
});
