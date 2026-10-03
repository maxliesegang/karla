import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import {
  areFollowedRunsEqual,
  getLineRunDepartures,
  updateFollowedRuns,
} from "../src/lib/line-run-departures.ts";
import { createCall } from "./support/calls.ts";
import { createDeparture } from "./support/fixtures.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
/** The source's side: followed runs are fetched by id when drawn. */
const known = new Map<string, Departure>();
const findRun = (rowId: string) => known.get(rowId);
const call = createCall(start);

function departure(
  id: string,
  calls: readonly TripCall[],
  status: Departure["status"] = "realtime",
  /** Rows are dated; retention reads their age. */
  readAt: number = start,
): Departure {
  const built: Departure = createDeparture({
    readAt: { rowReadAt: readAt, sequenceReadAt: readAt },
    id,
    tripId: id,
    tripInstanceId: `${id}@today`,
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status,
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: calls,
  });
  known.set(id, built);
  return built;
}

test("keeps a run after its observation board stops listing it", () => {
  const run = departure("retained", [call("a", 0), call("b", 5), call("c", 10)]);
  const observations = updateFollowedRuns([], [run], start + 60_000, findRun);

  assert.deepEqual(
    getLineRunDepartures(observations, [], start + 6 * 60_000, findRun).map(({ id }) => id),
    ["retained"],
  );
});

test("expires a retained run after its delayed final call and grace period", () => {
  const run = departure("expired", [call("a", 0), call("b", 10, 3)]);
  const observations = updateFollowedRuns([], [run], start + 60_000, findRun);

  assert.equal(getLineRunDepartures(observations, [], start + 16 * 60_000, findRun).length, 0);
});

test("a current cancellation removes the retained vehicle", () => {
  const running = departure("cancelled", [call("a", 0), call("b", 10)]);
  const cancelled = departure("cancelled", running.tripCalls ?? [], "cancelled");
  const observed = updateFollowedRuns([], [running], start + 60_000, findRun);
  const updated = updateFollowedRuns(observed, [cancelled], start + 90_000, findRun);

  assert.equal(updated.length, 0);
  assert.equal(getLineRunDepartures(observed, [cancelled], start + 90_000, findRun).length, 0);
});

test("a followed run is drawn from the reading the source has now, not the one that named it", () => {
  const original = departure("updated", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedRuns([], [original], start + 60_000, findRun);
  // No board lists it, but it has been re-read since.
  known.set("updated", { ...original, tripCalls: [call("a", 0), call("b", 10, 4)] });

  const [drawn] = getLineRunDepartures(followed, [], start + 90_000, findRun);
  assert.equal(drawn?.tripCalls?.[1]?.delayMinutes, 4);
  // A board listing it again is this refresh's statement.
  const listed = departure("updated", [call("a", 0), call("b", 10, 6)]);
  assert.deepEqual(getLineRunDepartures(followed, [listed], start + 90_000, findRun), [listed]);
});

test("a followed run is recognised under the identity its reading states now", () => {
  const original = departure("drift", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedRuns([], [original], start + 60_000, findRun);
  // Re-read with a refined dated id and listed under another row: matched by its draw-time key, so
  // it is not drawn twice.
  const refined = { ...original, tripInstanceId: "drift@refined" };
  known.set("drift", refined);
  const listed = { ...refined, id: "drift-next" };

  assert.deepEqual(getLineRunDepartures(followed, [listed], start + 90_000, findRun), [listed]);
});

test("one run followed under two row ids is still drawn once", () => {
  const run = departure("row-a", [call("a", 0), call("b", 10)]);
  known.set("row-b", { ...run, id: "row-b", boardingLocalStopId: "b" });

  const followed = updateFollowedRuns(
    [],
    [run, known.get("row-b") as Departure],
    start + 60_000,
    findRun,
  );
  assert.equal(followed.length, 2, "both rows are followed, by their own ids");
  assert.equal(getLineRunDepartures(followed, [], start + 90_000, findRun).length, 1);
});

test("a followed run whose reading says cancelled is not drawn", () => {
  const running = departure("run", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedRuns([], [running], start + 60_000, findRun);
  known.set("run", { ...running, status: "cancelled" });

  assert.equal(getLineRunDepartures(followed, [], start + 90_000, findRun).length, 0);
});

test("shows a current placeable observation even when its final call cannot define retention", () => {
  const incomplete = departure("incomplete", [
    call("a", 0),
    call("b", 5),
    { stopName: "C", localStopId: "c" },
  ]);

  assert.equal(updateFollowedRuns([], [incomplete], start + 60_000, findRun).length, 0);
  assert.deepEqual(getLineRunDepartures([], [incomplete], start + 60_000, findRun), [incomplete]);
});

test("bounds retained vehicle observations", () => {
  const runs = Array.from({ length: 4 }, (_, index) =>
    departure(`capacity-${index}`, [call("a", 0), call("b", 10)]),
  );

  assert.equal(updateFollowedRuns([], runs, start + 60_000, findRun, 2).length, 2);
});

test("stamps each run with the age of the board it came from, not the freshest one in hand", () => {
  // The core observation and line boards arrive minutes apart; each run is placed from its own read
  // time.
  const fresh = departure("fresh", [call("a", 0), call("b", 5), call("c", 10)], "realtime", start);
  const stale = departure(
    "stale",
    [call("a", 1), call("b", 6), call("c", 11)],
    "realtime",
    start - 5 * 60_000,
  );

  const observations = updateFollowedRuns([], [fresh, stale], start + 60_000, findRun);

  const observedById = new Map(
    observations.map((observation) => [observation.rowId, observation.observedAt]),
  );
  assert.equal(observedById.get("fresh"), start);
  assert.equal(observedById.get("stale"), start - 5 * 60_000);
});

test("a single instant still stamps every run in a batch read off one board", () => {
  const first = departure("first", [call("a", 0), call("b", 5)]);
  const second = departure("second", [call("a", 2), call("b", 7)]);

  const observations = updateFollowedRuns([], [first, second], start + 60_000, findRun);

  assert.deepEqual([...new Set(observations.map(({ observedAt }) => observedAt))], [start]);
});

test("a set followed is equal to itself until a run is named or ends", () => {
  const run = departure("same", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedRuns([], [run], start + 60_000, findRun);

  assert.ok(areFollowedRunsEqual(followed, followed));
  assert.ok(!areFollowedRunsEqual(followed, followed.slice(1)));
  assert.ok(
    !areFollowedRunsEqual(
      followed,
      followed.map((entry) => ({ ...entry, observedAt: entry.observedAt + 1 })),
    ),
  );
});
