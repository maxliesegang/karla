import assert from "node:assert/strict";
import test from "node:test";

const { describeCurrentStopMove, getVehicleLeftOffset, getMeasuredNodeCenterOffset } = await import(
  "../src/components/line-diagram/layout.ts"
);

test("writes vehicle lanes without CSS multiplication older iOS Safari rejects", () => {
  assert.equal(getVehicleLeftOffset(52, 0, "↑"), "calc(52px + var(--line-diagram-vehicle-offset))");
  assert.equal(
    getVehicleLeftOffset(52, 2, "↑"),
    "calc(52px + var(--line-diagram-vehicle-offset) + var(--line-diagram-vehicle-lane-step) + var(--line-diagram-vehicle-lane-step))",
  );
  assert.equal(
    getVehicleLeftOffset(52, 2, "↓"),
    "calc(52px + var(--line-diagram-vehicle-offset) - var(--line-diagram-vehicle-lane-step) - var(--line-diagram-vehicle-lane-step))",
  );
});

test("measures a vehicle against the centre of its stop node", () => {
  // A node is anchored by its own centre — placed at a point on its track and then pulled back over
  // that point by a transform, which never reaches layout. So the offset measured is already the
  // centre, and the same point is read whatever size the node happens to be drawn at: an ordinary
  // stop, a terminus, or the rider's own stop, which draws the largest node of the three. Counting
  // half a node again would carry every mark below the stop it is standing at, farthest at the one
  // stop where that is most visible.
  assert.equal(getMeasuredNodeCenterOffset(100, 4, 24), 128);
  assert.equal(getMeasuredNodeCenterOffset(100, 0, 24), 124);
});

test("a fork's junction node is read where the rails actually meet", () => {
  // A junction's node sits at one end of its track rather than in the middle, by that same centre
  // anchor, which is why the node is measured at all instead of the middle of the row.
  assert.equal(getMeasuredNodeCenterOffset(200, 0, 0), 200);
  assert.equal(getMeasuredNodeCenterOffset(200, 0, 34), 234);
});

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

const { chooseLineDiagramRun, getCurrentStopIndex, isCurrentLineDiagramStop } = await import(
  "../src/lib/line-diagram.ts"
);

/** A trip of line 2, stated by the stops it calls at in travel order. */
const trip = (id: string, destination: string, stopIds: readonly string[]) => ({
  id,
  tripId: id,
  lineId: "2",
  transportMode: "tram" as const,
  destination,
  minutesUntilDeparture: 0,
  platformCode: "1",
  boardingLocalStopId: stopIds[0],
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
  chooseLineDiagramRun({
    lineId: "2",
    riderStopIds: [stopId],
    pinnedDeparture: undefined,
    retainedDeparture: held,
    preferredDestination: undefined,
    stopRunDepartures: candidates,
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
  const chosen = chooseLineDiagramRun({
    lineId: "2",
    riderStopIds: ["b"],
    pinnedDeparture: undefined,
    retainedDeparture: trip("gone", "Wörth", ["x", "y"]),
    preferredDestination: undefined,
    stopRunDepartures: [INBOUND, SHORT_OUTBOUND, OUTBOUND],
    boardDepartures: [],
  });
  assert.equal(chosen?.destination, "Wörth");
  // Among the trips heading that way, the one that runs farthest: drawn from a short working the
  // line stops short of its own ends.
  assert.equal(chosen, OUTBOUND);
});

test("the trip the address names draws the line, held or not", () => {
  const chosen = chooseLineDiagramRun({
    lineId: "2",
    riderStopIds: ["c"],
    pinnedDeparture: INBOUND,
    retainedDeparture: OUTBOUND,
    preferredDestination: "Wörth",
    stopRunDepartures: [OUTBOUND],
    boardDepartures: [OUTBOUND],
  });
  assert.equal(chosen, INBOUND);
});

test("a line opened with nothing held is pointed where the rider was last heading", () => {
  const chosen = chooseLineDiagramRun({
    lineId: "2",
    riderStopIds: ["b"],
    pinnedDeparture: undefined,
    retainedDeparture: undefined,
    preferredDestination: "Durlach",
    stopRunDepartures: [OUTBOUND, INBOUND],
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
  const chosen = chooseLineDiagramRun({
    lineId: "2",
    riderStopIds: ["b"],
    pinnedDeparture: undefined,
    retainedDeparture: undefined,
    preferredDestination: undefined,
    stopRunDepartures: [],
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

test("every occurrence of one unified stop shares the current state", () => {
  const rows = [{ stopId: "d" }, { stopId: "c" }, { stopId: "c" }, { stopId: "b" }];
  const currentStopIndex = getCurrentStopIndex(rows, "c", undefined);

  assert.deepEqual(
    rows.map((_, index) => isCurrentLineDiagramStop(rows, currentStopIndex, index)),
    [false, true, true, false],
  );
});
