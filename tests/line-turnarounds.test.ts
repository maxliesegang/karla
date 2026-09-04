import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { findTurnarounds } from "../src/lib/line-turnarounds.ts";
import {
  buildLineDiagramStops,
  getLineDiagramVehicles,
  getVehicleRowCoordinate,
} from "../src/lib/line-diagram.ts";
import type { TransitLine, TransitNetwork } from "../src/data/transit-types.ts";
import { createCall, run } from "./support/calls.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);

function departure(id: string, lineId: string, calls: readonly TripCall[]): Departure {
  const runCalls = run(calls);
  return {
    id,
    tripId: id,
    tripInstanceId: `${id}@today`,
    lineId,
    transportMode: "tram",
    destination: calls[calls.length - 1].stopName,
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: calls[0].localStopId ?? "a",
    status: "realtime",
    scheduledDepartureTime: calls[0].scheduledDepartureTime ?? new Date(start).toISOString(),
    tripCalls: runCalls,
  };
}

test("pairs an arrival with the departure that turns out of it, once", () => {
  const arriving = departure("in", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  // Two candidates out of C: one four minutes after the arrival, one twenty-five minutes after.
  const turning = departure("out-soon", "2", [call("c", 12), call("b", 16), call("a", 20)]);
  const later = departure("out-later", "2", [call("c", 33), call("b", 37), call("a", 41)]);

  const { turningDepartureKeyByArrivalKey, standFromByDepartureKey } = findTurnarounds([
    arriving,
    turning,
    later,
  ]);

  assert.deepEqual([...turningDepartureKeyByArrivalKey], [["in@today", "out-soon@today"]]);
  assert.deepEqual(
    [...standFromByDepartureKey],
    [["out-soon@today", start + 8 * 60_000]],
    "the stand begins when the arrival is due in, and only the nearest departure claims it",
  );
});

test("draws an arrival and a same-instant departure as the two vehicles they are", () => {
  // A departure timed at the arrival's own instant is the crossing the timetable put at a busy
  // terminus: one run setting out as another sets down. Sequences are timed to the second, and
  // nothing turns a tram around in no time at all — pairing them would invent a stand for a trip
  // that never turned, swallowing the arriving mark the moment the departing one is drawn and
  // handing the departing one a stand it can be dragged back to after it has gone.
  const network: TransitNetwork = {
    stops: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() })),
    lines: [],
  };
  const line: TransitLine = {
    id: "2",
    name: "2",
    color: "#f00",
    textColor: "#fff",
    destinations: ["A", "C"],
    zentrumStopIds: [],
  };
  const diagramStops = buildLineDiagramStops(
    network,
    line,
    [call("a", 0), call("b", 4), call("c", 8)],
    null,
  );
  const arriving = departure("in-immediate", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  const turning = departure("out-immediate", "2", [call("c", 8), call("b", 12), call("a", 16)]);
  const turnaroundIndex = findTurnarounds([arriving, turning]);

  assert.equal(turnaroundIndex.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(turnaroundIndex.standFromByDepartureKey.size, 0);

  const vehicles = getLineDiagramVehicles(
    diagramStops,
    [arriving, turning],
    [],
    undefined,
    start + 8 * 60_000,
    { turnaroundIndex },
  );

  assert.deepEqual(vehicles.map(({ departure }) => departure.id).sort(), [
    "in-immediate",
    "out-immediate",
  ]);
});

test("a turn timed at the arrival's own instant is not handed on to the next departure", () => {
  // Line 1's 2026 diversion turns at Wolfartsweier Nord with a tram in and a tram out at the same
  // second, ten minutes apart all day. The instant turn is not a stand anybody can watch, so nothing
  // is drawn for it — but the arrival must not then be paired with the *following* departure, which
  // is how that turning point came to show a mark standing there for the whole ten minutes, and for
  // the ten after that, without a vehicle ever waiting at it.
  const arriving = departure("in-instant", "1", [call("a", 0), call("b", 4), call("c", 8)]);
  const straightBackOut = departure("out-instant", "1", [
    call("c", 8),
    call("b", 12),
    call("a", 16),
  ]);
  const following = departure("out-following", "1", [call("c", 18), call("b", 22), call("a", 26)]);

  const { turningDepartureKeyByArrivalKey, standFromByDepartureKey } = findTurnarounds([
    arriving,
    straightBackOut,
    following,
  ]);

  assert.equal(turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(
    standFromByDepartureKey.size,
    0,
    "the departure ten minutes later gets no stand from an arrival that had already left",
  );
});

test("never pairs across a line, a stop, or a departure that has already gone", () => {
  const arriving = departure("in", "2", [call("a", 0), call("c", 8)]);
  const otherLine = departure("other-line", "5", [call("c", 11), call("a", 19)]);
  const otherStop = departure("other-stop", "2", [call("b", 11), call("a", 19)]);
  // A departure before the arrival is due in is the working ahead of it, not the one it becomes.
  const before = departure("before", "2", [call("c", 6), call("a", 14)]);

  const index = findTurnarounds([arriving, otherLine, otherStop, before]);

  assert.equal(index.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(index.standFromByDepartureKey.size, 0);
});

test("never pairs across a whole headway of the line's own service", () => {
  // Three departures ten minutes apart: the line runs a ten-minute service out of C, so a stand of
  // twelve minutes is the *next* vehicle's turn and this arrival's own has not been read at all.
  // Pairing it anyway is how a terminus drifts a working further along with every arrival.
  const arriving = departure("in", "3", [call("a", -8), call("b", -4), call("c", 0)]);
  const starts = [12, 22, 32].map((minute) =>
    departure(`out-${minute}`, "3", [
      call("c", minute),
      call("b", minute + 4),
      call("a", minute + 8),
    ]),
  );

  const index = findTurnarounds([arriving, ...starts]);

  assert.equal(index.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(index.standFromByDepartureKey.size, 0);
});

test("pairs a turn longer than the tightest takt where the line's own headway allows it", () => {
  // Line 1 stands eleven minutes at Neureut-Heide on a twenty-minute evening service. A window
  // fixed at the tightest takt in the network could never see that turn; the line's own headway
  // says a vehicle standing eleven minutes is still standing well short of the one behind it.
  const arriving = departure("in-heide", "1", [call("a", -20), call("b", -10), call("c", 0)]);
  const starts = [11, 31, 51].map((minute) =>
    departure(`out-${minute}`, "1", [
      call("c", minute),
      call("b", minute + 10),
      call("a", minute + 20),
    ]),
  );

  const { turningDepartureKeyByArrivalKey, standFromByDepartureKey } = findTurnarounds([
    arriving,
    ...starts,
  ]);

  assert.deepEqual([...turningDepartureKeyByArrivalKey], [["in-heide@today", "out-11@today"]]);
  assert.equal(standFromByDepartureKey.get("out-11@today"), start);
});

test("never stands a vehicle for most of a sparse evening headway", () => {
  // A terminus running every twenty-five minutes would otherwise let a pairing claim a stand of
  // nearly that long, which is a great deal to infer from two trips that share only a place. The
  // stand is capped well above the longest turn measured on the network and well below the gap.
  const starts = [0, 25, 50].map((minute) =>
    departure(`out-${minute}`, "4", [
      call("c", minute),
      call("b", minute + 6),
      call("a", minute + 12),
    ]),
  );
  const tooLongBefore = departure("in-21", "4", [call("a", -33), call("b", -27), call("c", -21)]);
  const withinCap = departure("in-19", "4", [call("a", -31), call("b", -25), call("c", -19)]);

  assert.equal(
    findTurnarounds([tooLongBefore, ...starts]).standFromByDepartureKey.size,
    0,
    "twenty-one minutes standing is past what this will claim",
  );
  assert.deepEqual(
    [...findTurnarounds([withinCap, ...starts]).turningDepartureKeyByArrivalKey],
    [["in-19@today", "out-0@today"]],
  );
});

test("pairs the arrivals in the order they come in rather than by the shortest stand", () => {
  // Two trams in, two out, on a ten-minute service. Read shortest-stand-first the second arrival
  // takes the first departure and the two pairings cross, leaving the tram that has been standing
  // longest to be handed a departure it cannot reach. A vehicle cannot turn out ahead of one that
  // pulled in before it.
  const first = departure("in-first", "3", [call("a", -8), call("b", -4), call("c", 0)]);
  const second = departure("in-second", "3", [call("a", -2), call("b", 2), call("c", 6)]);
  const soon = departure("out-soon", "3", [call("c", 8), call("b", 12), call("a", 16)]);
  const later = departure("out-later", "3", [call("c", 18), call("b", 22), call("a", 26)]);

  const { turningDepartureKeyByArrivalKey } = findTurnarounds([first, second, soon, later]);

  assert.deepEqual(
    [...turningDepartureKeyByArrivalKey],
    [["in-first@today", "out-soon@today"]],
    "the tram that arrived first takes the departure in front of it, and the second waits",
  );
});

test("pairs on the published times, so a late run does not re-pair the terminus around it", () => {
  // The arrival is due in at 8 and running five minutes down, which puts the vehicle on the
  // platform a minute *after* the departure it turns out as is timed away. Which working a vehicle
  // turns into is a fact about the plan, so the pairing holds and only the stand it draws moves.
  const arriving = departure("in-late", "2", [call("a", 0), call("b", 4), call("c", 8, 5)]);
  const turning = departure("out-late", "2", [call("c", 12), call("b", 16), call("a", 20)]);

  const { turningDepartureKeyByArrivalKey, standFromByDepartureKey } = findTurnarounds([
    arriving,
    turning,
  ]);

  assert.deepEqual([...turningDepartureKeyByArrivalKey], [["in-late@today", "out-late@today"]]);
  assert.equal(
    standFromByDepartureKey.get("out-late@today"),
    start + 13 * 60_000,
    "the stand begins when the vehicle is really expected in, not when the plan said",
  );
});

test("draws a turnaround as one standing mark rather than an arrival beside a departure", () => {
  const network: TransitNetwork = {
    stops: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() })),
    lines: [],
  };
  const line: TransitLine = {
    id: "2",
    name: "2",
    color: "#f00",
    textColor: "#fff",
    destinations: ["A", "C"],
    zentrumStopIds: [],
  };
  const diagramStops = buildLineDiagramStops(
    network,
    line,
    [call("a", 0), call("b", 4), call("c", 8)],
    null,
  );
  const arriving = departure("in", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  const turning = departure("out", "2", [call("c", 14), call("b", 18), call("a", 22)]);

  // Nine minutes in: the arrival is due at C and the departure has six minutes to wait.
  const vehicles = getLineDiagramVehicles(
    diagramStops,
    [arriving, turning],
    [],
    undefined,
    start + 9 * 60_000,
  );

  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].departure.id, "out");
  assert.equal(vehicles[0].phase, "beforeStart");
  assert.equal(vehicles[0].directionArrow, "↑");
  const terminusIndex = diagramStops.findIndex(({ stopId }) => stopId === "c");
  assert.equal(
    getVehicleRowCoordinate(vehicles[0]),
    terminusIndex,
    "the turnaround mark is placed on the terminus, not on an intermediate link",
  );
  assert.equal(vehicles[0].rowIndex, terminusIndex, "the terminus row owns the standing mark");
});

test("stands a paired departure at its terminus for the whole of a long turnaround", () => {
  const arriving = departure("in-long", "2", [call("a", 0), call("c", 8)]);
  // Ten minutes standing: further out than a lone trip is ever drawn for.
  const turning = departure("out-long", "2", [call("c", 18), call("a", 26)]);
  const { standFromByDepartureKey } = findTurnarounds([arriving, turning]);

  assert.equal(standFromByDepartureKey.get("out-long@today"), start + 8 * 60_000);
});

test("keeps the arriving mark when the departure it turns into cannot be drawn here", () => {
  const network: TransitNetwork = {
    stops: ["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase() })),
    lines: [],
  };
  const line: TransitLine = {
    id: "2",
    name: "2",
    color: "#f00",
    textColor: "#fff",
    destinations: ["A", "C"],
    zentrumStopIds: [],
  };
  const diagramStops = buildLineDiagramStops(
    network,
    line,
    [call("a", 0), call("b", 4), call("c", 8)],
    null,
  );
  const arriving = departure("in-offdiagram", "2", [
    call("d", -2),
    call("a", 0),
    call("b", 4),
    call("c", 8),
  ]);
  // It turns out of C and goes back the way the arrival came, but over a stop this diagram does not
  // draw, so it carries no mark here. The vehicle that has just pulled into C is still the honest
  // thing to show.
  const turning = departure("out-offdiagram", "2", [call("c", 12), call("d", 16)]);

  const vehicles = getLineDiagramVehicles(
    diagramStops,
    [arriving, turning],
    [],
    undefined,
    start + 9 * 60_000,
  );

  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].departure.id, "in-offdiagram");
  assert.equal(vehicles[0].phase, "afterEnd");
});

test("never pairs at a stop where neither run actually ends", () => {
  // Both readings are timed at both ends of every call, which is what the feed publishes where the
  // vehicle runs on past them: a sequence cut short, or one read without complete stop sequences.
  // C is a stop each of them passes through, and nothing turns at a stop it passes through.
  const passing = (id: string, calls: readonly TripCall[]): Departure => ({
    ...departure(id, "2", calls),
    tripCalls: calls,
  });
  const arriving = passing("in-passing", [call("a", 0), call("b", 4), call("c", 8)]);
  const leaving = passing("out-passing", [call("c", 12), call("b", 16), call("a", 20)]);

  const index = findTurnarounds([arriving, leaving]);

  assert.equal(index.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(index.standFromByDepartureKey.size, 0);
});

test("never pairs a run that ends with one that carries on the same way", () => {
  // A short working ends at C and another run sets out from C four minutes later — but outwards,
  // over ground the arrival never covered. That is the next stage of a journey, drawn as the two
  // vehicles it is, and only a departure going back the way the arrival came is one vehicle turning.
  const arriving = departure("in-short", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  const onwards = departure("out-onwards", "2", [call("c", 12), call("d", 16), call("e", 20)]);

  const index = findTurnarounds([arriving, onwards]);

  assert.equal(index.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(index.standFromByDepartureKey.size, 0);
});

test("pairs a vehicle that turns through a terminus loop rather than backing out of a stub", () => {
  // A balloon loop leaves by a different track than it arrived on and rejoins the line a stop
  // along. The vehicle still turned; only the first stop out of the terminus differs.
  const arriving = departure("in-loop", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  const turning = departure("out-loop", "2", [call("c", 12), call("loop", 13), call("b", 16)]);

  const { turningDepartureKeyByArrivalKey } = findTurnarounds([arriving, turning]);

  assert.deepEqual([...turningDepartureKeyByArrivalKey], [["in-loop@today", "out-loop@today"]]);
});

const terminusNetwork: TransitNetwork = {
  stops: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() })),
  lines: [],
};
const terminusLine: TransitLine = {
  id: "3",
  name: "3",
  color: "#f00",
  textColor: "#fff",
  destinations: ["A", "C"],
  zentrumStopIds: [],
};
const terminusDiagram = () =>
  buildLineDiagramStops(
    terminusNetwork,
    terminusLine,
    [call("a", 0), call("b", 4), call("c", 8)],
    null,
  );

test("draws one mark where an arrival and a waiting departure share a terminus unpaired", () => {
  // Forty seconds between the arrival and the next departure: too quick to be read as one vehicle
  // turning, so neither trip knows about the other and both are drawn at C — the arrival for its
  // grace after pulling in, the departure for the lead before it is due away. That is two marks on
  // one platform, and the arrival is the half somebody watched pull in.
  const arriving = departure("in-unpaired", "3", [call("a", 0), call("b", 4), call("c", 8)]);
  const waiting = departure("out-unpaired", "3", [call("c", 8.7), call("b", 12), call("a", 16)]);

  assert.equal(
    findTurnarounds([arriving, waiting]).standFromByDepartureKey.size,
    0,
    "nothing turns a tram around in forty seconds, so no stand is inferred",
  );

  const vehicles = getLineDiagramVehicles(
    terminusDiagram(),
    [arriving, waiting],
    [],
    undefined,
    start + 8.5 * 60_000,
  );

  assert.deepEqual(
    vehicles.map(({ departure: { id }, phase }) => [id, phase]),
    [["in-unpaired", "afterEnd"]],
    "the waiting mark stands down while a run is still ending at the same stop",
  );
});

test("draws no waiting mark at a terminus the vehicle has not reached yet", () => {
  // The instant turn at Wolfartsweier Nord: a tram due in at the second the next one is due out.
  // Nothing stands on that platform for the nine minutes before it, and the outgoing trip's own
  // calls — a lead measured back from when it leaves — are not evidence that anything does.
  const arriving = departure("in-instant-lead", "3", [call("a", 0), call("b", 4), call("c", 10)]);
  const waiting = departure("out-instant-lead", "3", [
    call("c", 10.5),
    call("b", 14),
    call("a", 18),
  ]);

  const vehicles = getLineDiagramVehicles(
    terminusDiagram(),
    [arriving, waiting],
    [],
    undefined,
    start + 5 * 60_000,
  );

  assert.deepEqual(
    vehicles.map(({ departure: { id } }) => id),
    ["in-instant-lead"],
    "only the tram still running towards the terminus is drawn",
  );
});

test("stands a lone waiting trip at its terminus for the whole of a long turn", () => {
  // Line 3 turns at Forststraße on eleven scheduled minutes. One departure is all this reading has
  // caught there, so the headway a pairing is bounded by cannot be measured and the fallback window
  // is shorter than the turn — as it should be, since nothing here says how soon the next tram
  // follows. Nothing joins these two trips, so the stand is drawn from the outgoing one's own lead,
  // and it covers the middle of the turn the diagram used to leave empty.
  const arriving = departure("in-long-turn", "3", [call("a", 0), call("b", 4), call("c", 8)]);
  const waiting = departure("out-long-turn", "3", [call("c", 21), call("b", 25), call("a", 29)]);

  assert.equal(findTurnarounds([arriving, waiting]).standFromByDepartureKey.size, 0);

  const vehicles = getLineDiagramVehicles(
    terminusDiagram(),
    [arriving, waiting],
    [],
    undefined,
    start + 13 * 60_000,
  );

  const terminusIndex = terminusDiagram().findIndex(({ stopId }) => stopId === "c");
  assert.deepEqual(
    vehicles.map(({ departure: { id }, phase }) => [id, phase]),
    [["out-long-turn", "beforeStart"]],
  );
  assert.equal(getVehicleRowCoordinate(vehicles[0]), terminusIndex);
});
