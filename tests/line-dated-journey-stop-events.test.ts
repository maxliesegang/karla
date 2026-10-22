import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import {
  areFollowedDatedJourneysEqual,
  getLineDatedJourneyStopEvents,
  DATED_JOURNEY_FIRST_PLACEMENT_MAX_AGE_MS,
  selectPlaceableDatedJourneys,
  updateFollowedDatedJourneys,
} from "../src/lib/line-dated-journey-stop-events.ts";
import { getDatedJourneyMarkKey } from "../src/lib/journeys.ts";
import { createCall } from "./support/calls.ts";
import { createStopEvent } from "./support/fixtures.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
/** The source's side: followed runs are fetched by id when drawn. */
const known = new Map<string, StopEvent>();
const findDatedJourney = (rowId: string) => known.get(rowId);
const call = createCall(start);

function stopEvent(
  id: string,
  calls: readonly Call[],
  status: StopEvent["status"] = "realtime",
  /** Rows are dated; retention reads their age. */
  readAt: number = start,
): StopEvent {
  const built: StopEvent = createStopEvent({
    readAt: { rowReadAt: readAt, sequenceReadAt: readAt },
    id,
    journeyRef: id,
    datedJourneyId: `${id}@today`,
    lineId: "2",
    ptMode: "tram",
    destinationText: "C",
    minutesUntilDeparture: 0,
    bay: "1",
    boardingLocalStopId: "a",
    status,
    timetabledDepartureTime: new Date(start).toISOString(),
    calls,
  });
  known.set(id, built);
  return built;
}

test("keeps a run after its observation board stops listing it", () => {
  const datedJourney = stopEvent("retained", [call("a", 0), call("b", 5), call("c", 10)]);
  const observations = updateFollowedDatedJourneys(
    [],
    [datedJourney],
    start + 60_000,
    findDatedJourney,
  );

  assert.deepEqual(
    getLineDatedJourneyStopEvents(observations, [], start + 6 * 60_000, findDatedJourney).map(
      ({ id }) => id,
    ),
    ["retained"],
  );
});

test("expires a retained run after its delayed final call and grace period", () => {
  const datedJourney = stopEvent("expired", [call("a", 0), call("b", 10, 3)]);
  const observations = updateFollowedDatedJourneys(
    [],
    [datedJourney],
    start + 60_000,
    findDatedJourney,
  );

  assert.equal(
    getLineDatedJourneyStopEvents(observations, [], start + 16 * 60_000, findDatedJourney).length,
    0,
  );
});

test("a current cancellation removes the retained vehicle", () => {
  const running = stopEvent("cancelled", [call("a", 0), call("b", 10)]);
  const cancelled = stopEvent("cancelled", running.calls ?? [], "cancelled");
  const observed = updateFollowedDatedJourneys([], [running], start + 60_000, findDatedJourney);
  const updated = updateFollowedDatedJourneys(
    observed,
    [cancelled],
    start + 90_000,
    findDatedJourney,
  );

  assert.equal(updated.length, 0);
  assert.equal(
    getLineDatedJourneyStopEvents(observed, [cancelled], start + 90_000, findDatedJourney).length,
    0,
  );
});

test("a followed run is drawn from the reading the source has now, not the one that named it", () => {
  const original = stopEvent("updated", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedDatedJourneys([], [original], start + 60_000, findDatedJourney);
  // No board lists it, but it has been re-read since.
  known.set("updated", { ...original, calls: [call("a", 0), call("b", 10, 4)] });

  const [drawn] = getLineDatedJourneyStopEvents(followed, [], start + 90_000, findDatedJourney);
  assert.equal(drawn?.calls?.[1]?.delayMinutes, 4);
  // A board listing it again is this refresh's statement.
  const listed = stopEvent("updated", [call("a", 0), call("b", 10, 6)]);
  assert.deepEqual(
    getLineDatedJourneyStopEvents(followed, [listed], start + 90_000, findDatedJourney),
    [listed],
  );
});

test("a followed run is recognised under the identity its reading states now", () => {
  const original = stopEvent("drift", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedDatedJourneys([], [original], start + 60_000, findDatedJourney);
  // Re-read with a refined dated id and listed under another row: matched by its draw-time key, so
  // it is not drawn twice.
  const refined = { ...original, datedJourneyId: "drift@refined" };
  known.set("drift", refined);
  const listed = { ...refined, id: "drift-next" };

  const drawn = getLineDatedJourneyStopEvents(followed, [listed], start + 90_000, findDatedJourney);
  assert.deepEqual(
    drawn.map(({ id }) => id),
    ["drift-next"],
  );
});

test("a listed row the store no longer holds never brings its board's calls", () => {
  const forgotten = stopEvent("forgotten", [call("a", 0), call("b", 10)]);
  const [drawn] = getLineDatedJourneyStopEvents([], [forgotten], start + 60_000, () => undefined);
  assert.equal(drawn.id, "forgotten");
  assert.equal(drawn.calls, undefined);
});

test("one run followed under two row ids is still drawn once", () => {
  const datedJourney = stopEvent("row-a", [call("a", 0), call("b", 10)]);
  known.set("row-b", { ...datedJourney, id: "row-b", boardingLocalStopId: "b" });

  const followed = updateFollowedDatedJourneys(
    [],
    [datedJourney, known.get("row-b") as StopEvent],
    start + 60_000,
    findDatedJourney,
  );
  assert.equal(followed.length, 2, "both rows are followed, by their own ids");
  assert.equal(
    getLineDatedJourneyStopEvents(followed, [], start + 90_000, findDatedJourney).length,
    1,
  );
});

test("a followed run whose reading says cancelled is not drawn", () => {
  const running = stopEvent("run", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedDatedJourneys([], [running], start + 60_000, findDatedJourney);
  known.set("run", { ...running, status: "cancelled" });

  assert.equal(
    getLineDatedJourneyStopEvents(followed, [], start + 90_000, findDatedJourney).length,
    0,
  );
});

test("shows a current placeable observation even when its final call cannot define retention", () => {
  const incomplete = stopEvent("incomplete", [
    call("a", 0),
    call("b", 5),
    { stopName: "C", localStopId: "c" },
  ]);

  assert.equal(
    updateFollowedDatedJourneys([], [incomplete], start + 60_000, findDatedJourney).length,
    0,
  );
  assert.deepEqual(
    getLineDatedJourneyStopEvents([], [incomplete], start + 60_000, findDatedJourney),
    [incomplete],
  );
});

test("bounds retained vehicle observations", () => {
  const datedJourneys = Array.from({ length: 4 }, (_, index) =>
    stopEvent(`capacity-${index}`, [call("a", 0), call("b", 10)]),
  );

  assert.equal(
    updateFollowedDatedJourneys([], datedJourneys, start + 60_000, findDatedJourney, 2).length,
    2,
  );
});

test("stamps each run with the age of the board it came from, not the freshest one in hand", () => {
  // The core observation and line boards arrive minutes apart; each run is placed from its own read
  // time.
  const fresh = stopEvent("fresh", [call("a", 0), call("b", 5), call("c", 10)], "realtime", start);
  const stale = stopEvent(
    "stale",
    [call("a", 1), call("b", 6), call("c", 11)],
    "realtime",
    start - 5 * 60_000,
  );

  const observations = updateFollowedDatedJourneys(
    [],
    [fresh, stale],
    start + 60_000,
    findDatedJourney,
  );

  const observedById = new Map(
    observations.map((observation) => [observation.rowId, observation.observedAt]),
  );
  assert.equal(observedById.get("fresh"), start);
  assert.equal(observedById.get("stale"), start - 5 * 60_000);
});

test("a single instant still stamps every run in a batch read off one board", () => {
  const first = stopEvent("first", [call("a", 0), call("b", 5)]);
  const second = stopEvent("second", [call("a", 2), call("b", 7)]);

  const observations = updateFollowedDatedJourneys(
    [],
    [first, second],
    start + 60_000,
    findDatedJourney,
  );

  assert.deepEqual([...new Set(observations.map(({ observedAt }) => observedAt))], [start]);
});

test("a set followed is equal to itself until a run is named or ends", () => {
  const datedJourney = stopEvent("same", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedDatedJourneys(
    [],
    [datedJourney],
    start + 60_000,
    findDatedJourney,
  );

  assert.ok(areFollowedDatedJourneysEqual(followed, followed));
  assert.ok(!areFollowedDatedJourneysEqual(followed, followed.slice(1)));
  assert.ok(
    !areFollowedDatedJourneysEqual(
      followed,
      followed.map((entry) => ({ ...entry, observedAt: entry.observedAt + 1 })),
    ),
  );
});

test("a run is first drawn only from calls read recently; a drawn run keeps its last reading", () => {
  const calls = [call("a", 0), call("b", 2)];
  const old = stopEvent(
    "placeable-old",
    calls,
    "realtime",
    start - DATED_JOURNEY_FIRST_PLACEMENT_MAX_AGE_MS - 1,
  );
  const fresh = stopEvent("placeable-fresh", calls, "realtime", start - 5_000);
  const undated = { ...stopEvent("placeable-undated", calls), readAt: undefined };

  // A cached board's calls wait for the run's own re-read.
  assert.deepEqual(
    selectPlaceableDatedJourneys([old, fresh, undated], start, new Set()).map(({ id }) => id),
    ["placeable-fresh", "placeable-undated"],
  );
  // Already drawn: a refresh that failed does not take the mark away.
  assert.deepEqual(
    selectPlaceableDatedJourneys([old, fresh], start, new Set([getDatedJourneyMarkKey(old)])).map(
      ({ id }) => id,
    ),
    ["placeable-old", "placeable-fresh"],
  );
});
