import assert from "node:assert/strict";
import test from "node:test";

const { describeCurrentStopMove, holdAddressedTrip } = await import(
  "../src/components/line-diagram/layout.ts"
);

const place = (index: number, chainKey = "S1:A>B>C>D") => ({ index, chainKey });

test("a step along the line is one note that moved, whichever way it steps", () => {
  // Toward the destination or back along it, the note glides up into its new place either way —
  // the only question is whether it has a previous place in this diagram to move from at all.
  assert.equal(describeCurrentStopMove(place(3), place(2)), "travelled");
  assert.equal(describeCurrentStopMove(place(1), place(2)), "travelled");
});

test("a diagram standing still has nothing to say", () => {
  assert.equal(describeCurrentStopMove(place(2), place(2)), undefined);
});

test("another stop chain is not a move within anything", () => {
  // Another line, the other direction, a variant calling elsewhere: the rows are not the same rows,
  // so the note is simply where it is rather than having travelled there.
  assert.equal(describeCurrentStopMove(place(3), place(1, "S2:X>Y>Z")), undefined);
});

test("a note that was not on the diagram has not moved onto it", () => {
  // The ride marks no stop of its own, and a stop off the drawn trip resolves to no row at all.
  assert.equal(describeCurrentStopMove(place(-1), place(2)), undefined);
  assert.equal(describeCurrentStopMove(place(2), place(-1)), undefined);
});

const TRIP = "de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s26";
const OTHER_TRIP = "de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s27";
const READING = { destination: "Wörth Badepark" };
const FRESHER = { destination: "Wörth Badepark" };

test("the diagram keeps drawing the addressed trip while the next stop's boards are read", () => {
  // Walking along the line re-keys every board behind the trip, so for a few hundred milliseconds
  // the feed can say nothing about a trip the rider has not stopped reading.
  const held = holdAddressedTrip(null, TRIP, READING).held;
  const loading = holdAddressedTrip(held, TRIP, undefined);
  assert.equal(loading.drawn, READING);
  assert.equal(loading.held, held);
});

test("a fresher reading of the same trip replaces the one being held", () => {
  const held = holdAddressedTrip(null, TRIP, READING).held;
  const answered = holdAddressedTrip(held, TRIP, FRESHER);
  assert.equal(answered.drawn, FRESHER);
  assert.deepEqual(answered.held, { tripId: TRIP, departure: FRESHER });
});

test("the hold is dropped with the trip the address stops naming", () => {
  // Unpinning the trip leaves the whole line in view, and nothing of the trip may survive it.
  const held = holdAddressedTrip(null, TRIP, READING).held;
  const unpinned = holdAddressedTrip(held, undefined, undefined);
  assert.equal(unpinned.drawn, undefined);
  assert.equal(unpinned.held, null);
});

test("a hold is never picked up by a different trip", () => {
  const held = holdAddressedTrip(null, TRIP, READING).held;
  const other = holdAddressedTrip(held, OTHER_TRIP, undefined);
  assert.equal(other.drawn, undefined);
  assert.equal(other.held, null);
});

const { chooseLineDiagramTrip, getCurrentStopIndex } = await import("../src/lib/line-diagram.ts");

/** A trip of line 2, stated by the stops it calls at in travel order. */
const trip = (id: string, destination: string, stopIds: readonly string[]) => ({
  id,
  tripId: id,
  lineId: "2",
  transportMode: "tram" as const,
  destination,
  minutesUntilDeparture: 0,
  platformName: "1",
  boardingStopId: stopIds[0],
  status: "scheduled" as const,
  tripCalls: stopIds.map((localStopId) => ({ stopName: localStopId.toUpperCase(), localStopId })),
});

const OUTBOUND = trip("outbound", "Wörth", ["a", "b", "c", "d"]);
const INBOUND = trip("inbound", "Durlach", ["d", "c", "b", "a"]);
const SHORT_OUTBOUND = trip("outbound-short", "Wörth", ["b", "c"]);

const chooseAt = (
  stopId: string,
  held: typeof OUTBOUND | undefined,
  candidates = [OUTBOUND, INBOUND],
) =>
  chooseLineDiagramTrip({
    lineId: "2",
    riderStopIds: [stopId],
    pinnedDeparture: undefined,
    heldDeparture: held,
    preferredDestination: undefined,
    stopTripDepartures: candidates,
    boardDepartures: candidates,
  });

test("walking along the line keeps the trip the line is already drawn from", () => {
  // Both directions run past every stop of a line, so choosing again at each one turned the diagram
  // around under a rider who had only stepped along it. The same trip means literally the same stop
  // chain, which is what leaves the diagram standing while the note under the stop name moves.
  assert.equal(chooseAt("c", OUTBOUND), OUTBOUND);
});

test("a stop the held trip does not call at is drawn afresh, pointing the same way", () => {
  // Nothing to hold on to — but the direction it was last read in still stands, so a line reopened
  // further out is not turned around either.
  const chosen = chooseLineDiagramTrip({
    lineId: "2",
    riderStopIds: ["b"],
    pinnedDeparture: undefined,
    heldDeparture: trip("gone", "Wörth", ["x", "y"]),
    preferredDestination: undefined,
    stopTripDepartures: [INBOUND, SHORT_OUTBOUND, OUTBOUND],
    boardDepartures: [],
  });
  assert.equal(chosen?.destination, "Wörth");
  // Among the trips heading that way, the one that runs furthest: drawn from a short working the
  // line stops short of its own ends.
  assert.equal(chosen, OUTBOUND);
});

test("the trip the address names draws the line, held or not", () => {
  const chosen = chooseLineDiagramTrip({
    lineId: "2",
    riderStopIds: ["c"],
    pinnedDeparture: INBOUND,
    heldDeparture: OUTBOUND,
    preferredDestination: "Wörth",
    stopTripDepartures: [OUTBOUND],
    boardDepartures: [OUTBOUND],
  });
  assert.equal(chosen, INBOUND);
});

test("a line opened with nothing held is pointed where the rider was last heading", () => {
  const chosen = chooseLineDiagramTrip({
    lineId: "2",
    riderStopIds: ["b"],
    pinnedDeparture: undefined,
    heldDeparture: undefined,
    preferredDestination: "Durlach",
    stopTripDepartures: [OUTBOUND, INBOUND],
    boardDepartures: [],
  });
  assert.equal(chosen, INBOUND);
});

test("a held trip of another line is not what this line is drawn from", () => {
  const chosen = chooseAt("c", { ...OUTBOUND, lineId: "5" });
  assert.equal(chosen?.lineId, "2");
});

test("without a chain to draw, the plain board still states a direction", () => {
  const boardRow = { ...INBOUND, tripCalls: undefined };
  const chosen = chooseLineDiagramTrip({
    lineId: "2",
    riderStopIds: ["b"],
    pinnedDeparture: undefined,
    heldDeparture: undefined,
    preferredDestination: undefined,
    stopTripDepartures: [],
    boardDepartures: [boardRow],
  });
  assert.equal(chosen, boardRow);
});

/** A drawn line, as the rows the rider reads name their stops. */
const ROWS = ["d", "c", "b", "a"].map((stopId) => ({ stopId }));

test("the rider's own row is the one the address names, answered or not", () => {
  // The row they tapped, held through the moment the new stop's boards are still being read: the
  // note has one place to be for one step along the line, not one and then another.
  assert.equal(getCurrentStopIndex(ROWS, "b", undefined), 2);
  assert.equal(getCurrentStopIndex(ROWS, "b", "b"), 2);
});

test("a board answering for another stop point does not move the note off the tapped row", () => {
  // The reading that arrives a few hundred milliseconds later can name a stop point of the same
  // complex, which is no row of this chain at all. That is not a step the rider took.
  assert.equal(getCurrentStopIndex(ROWS, "b", "b-platform-2"), 2);
});

test("the boarding stop point answers where the address names a stop the chain does not", () => {
  // A stop-complex page listing a departure that physically leaves from one of its other points.
  assert.equal(getCurrentStopIndex(ROWS, "complex", "c"), 1);
});

test("a stop off the drawn trip is no row at all", () => {
  assert.equal(getCurrentStopIndex(ROWS, "x", "y"), -1);
  assert.equal(getCurrentStopIndex(ROWS, "x", undefined), -1);
});
