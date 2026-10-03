import assert from "node:assert/strict";
import test from "node:test";
import { createDeparture } from "./support/fixtures.ts";

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
  // The node is centred by a transform, which does not affect layout, so the measured offset is the
  // centre, whatever the node's size.
  assert.equal(getMeasuredNodeCenterOffset(100, 4, 24), 128);
  assert.equal(getMeasuredNodeCenterOffset(100, 0, 24), 124);
});

test("a fork's junction node is read where the rails actually meet", () => {
  // A junction's node sits at one end of its track, which is why the node is measured.
  assert.equal(getMeasuredNodeCenterOffset(200, 0, 0), 200);
  assert.equal(getMeasuredNodeCenterOffset(200, 0, 34), 234);
});

const place = (index: number, chainKey = "S1:A>B>C>D") => ({ index, chainKey });

test("a step along the line is one note that moved, whichever way it steps", () => {
  // Either way along the line, the note glides; the question is only whether it has a previous
  // place.
  assert.equal(describeCurrentStopMove(place(3), place(2)), "travelled");
  assert.equal(describeCurrentStopMove(place(1), place(2)), "travelled");
});

test("a diagram standing still has nothing to say", () => {
  assert.equal(describeCurrentStopMove(place(2), place(2)), undefined);
});

test("another stop chain is not a move within anything", () => {
  // A different chain is not a move.
  assert.equal(describeCurrentStopMove(place(3), place(1, "S2:X>Y>Z")), undefined);
});

test("a note that was not on the diagram has not moved onto it", () => {
  // A ride marks no stop; a stop off the drawn trip has no row.
  assert.equal(describeCurrentStopMove(place(-1), place(2)), undefined);
  assert.equal(describeCurrentStopMove(place(2), place(-1)), undefined);
});

const { chooseLineDiagramRun, getCurrentStopIndex, isCurrentLineDiagramStop } = await import(
  "../src/lib/line-diagram.ts"
);

/** A line 2 trip, by its stops in travel order. */
const trip = (id: string, destination: string, stopIds: readonly string[]) =>
  createDeparture({
    id,
    tripId: id,
    destination,
    boardingLocalStopId: stopIds[0],
    status: "scheduled",
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
  // Holding the trip keeps the chain, so stepping along the line does not flip the diagram.
  assert.equal(chooseAt("c", OUTBOUND), OUTBOUND);
});

test("a stop the held trip does not call at is drawn afresh, pointing the same way", () => {
  // Nothing to hold, but the last direction still stands.
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
  // The farthest-running trip that way, not a short working.
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

/** A drawn line's rows. */
const ROWS = ["d", "c", "b", "a"].map((stopId) => ({ stopId }));

test("the rider's own row is the one the address names, answered or not", () => {
  // The tapped row holds while the new stop's boards load.
  assert.equal(getCurrentStopIndex(ROWS, "b", undefined), 2);
  assert.equal(getCurrentStopIndex(ROWS, "b", "b"), 2);
});

test("a board answering for another stop point does not move the note off the tapped row", () => {
  // A later reading naming another point of the complex is not a step.
  assert.equal(getCurrentStopIndex(ROWS, "b", "b-platform-2"), 2);
});

test("the boarding stop point answers where the address names a stop the chain does not", () => {
  // A complex page listing a departure from another of its points.
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
