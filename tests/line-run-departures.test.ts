import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import {
  areFollowedRunsEqual,
  getLineRunDepartures,
  updateFollowedRuns,
} from "../src/lib/line-run-departures.ts";
import { createCall } from "./support/calls.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
/** The source's part: a followed run is named here and its reading is fetched by id when drawn. */
const known = new Map<string, Departure>();
const findRun = (rowId: string) => known.get(rowId);
const call = createCall(start);

function departure(
  id: string,
  calls: readonly TripCall[],
  status: Departure["status"] = "realtime",
  /** Every row the source publishes is dated; retention reads its age off the row. */
  readAt: number = start,
): Departure {
  const built: Departure = {
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
  };
  known.set(id, built);
  return built;
}

test("keeps a run after its observation board stops listing it", () => {
  const run = departure("retained", [call("a", 0), call("b", 5), call("c", 10)]);
  const observations = updateFollowedRuns([], [run], start + 60_000);

  assert.deepEqual(
    getLineRunDepartures(observations, [], start + 6 * 60_000, findRun).map(({ id }) => id),
    ["retained"],
  );
});

test("expires a retained run after its delayed final call and grace period", () => {
  const run = departure("expired", [call("a", 0), call("b", 10, 3)]);
  const observations = updateFollowedRuns([], [run], start + 60_000);

  assert.equal(getLineRunDepartures(observations, [], start + 16 * 60_000, findRun).length, 0);
});

test("a current cancellation removes the retained vehicle", () => {
  const running = departure("cancelled", [call("a", 0), call("b", 10)]);
  const cancelled = departure("cancelled", running.tripCalls ?? [], "cancelled");
  const observed = updateFollowedRuns([], [running], start + 60_000);
  const updated = updateFollowedRuns(observed, [cancelled], start + 90_000);

  assert.equal(updated.length, 0);
  assert.equal(getLineRunDepartures(observed, [cancelled], start + 90_000, findRun).length, 0);
});

test("a followed run is drawn from the reading the source has now, not the one that named it", () => {
  const original = departure("updated", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedRuns([], [original], start + 60_000);
  // Nothing names it again — no board lists it any more — but something has re-read it since.
  known.set("updated", { ...original, tripCalls: [call("a", 0), call("b", 10, 4)] });

  const [drawn] = getLineRunDepartures(followed, [], start + 90_000, findRun);
  assert.equal(drawn?.tripCalls?.[1]?.delayMinutes, 4);
  // And a board that lists it again is this refresh's statement, so its own row is what is drawn.
  const listed = departure("updated", [call("a", 0), call("b", 10, 6)]);
  assert.deepEqual(getLineRunDepartures(followed, [listed], start + 90_000, findRun), [listed]);
});

test("a listed row is resolved through the source's canonical run reading", () => {
  const observed = departure("canonical-row", [call("a", 0), call("b", 10)]);
  const canonical = { ...observed, destination: "canonical destination" };
  known.set(observed.id, canonical);

  const [drawn] = getLineRunDepartures([], [observed], start + 90_000, findRun);

  assert.equal(drawn, canonical);
  assert.equal(drawn?.destination, "canonical destination");
});

test("a followed run is recognised under the identity its reading states now", () => {
  const original = departure("drift", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedRuns([], [original], start + 60_000);
  // Re-read with the dated identity its sequence refines, and listed again under another stop's
  // row. Suppressed by the name the reading carries at draw time, not by the one it was followed
  // under — or this run would be drawn twice.
  const refined = { ...original, tripInstanceId: "drift@refined" };
  known.set("drift", refined);
  const listed = { ...refined, id: "drift-next" };

  assert.deepEqual(getLineRunDepartures(followed, [listed], start + 90_000, findRun), [listed]);
});

test("one run followed under two row ids is still drawn once", () => {
  const run = departure("row-a", [call("a", 0), call("b", 10)]);
  known.set("row-b", { ...run, id: "row-b", boardingLocalStopId: "b" });

  const followed = updateFollowedRuns([], [run, known.get("row-b") as Departure], start + 60_000);
  assert.equal(followed.length, 2, "both rows are followed, by their own ids");
  assert.equal(getLineRunDepartures(followed, [], start + 90_000, findRun).length, 1);
});

test("a followed run whose reading says cancelled is not drawn", () => {
  const running = departure("run", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedRuns([], [running], start + 60_000);
  known.set("run", { ...running, status: "cancelled" });

  assert.equal(getLineRunDepartures(followed, [], start + 90_000, findRun).length, 0);
});

test("shows a current placeable observation even when its final call cannot define retention", () => {
  const incomplete = departure("incomplete", [
    call("a", 0),
    call("b", 5),
    { stopName: "C", localStopId: "c" },
  ]);

  assert.equal(updateFollowedRuns([], [incomplete], start + 60_000).length, 0);
  assert.deepEqual(getLineRunDepartures([], [incomplete], start + 60_000, findRun), [incomplete]);
});

test("bounds retained vehicle observations", () => {
  const runs = Array.from({ length: 4 }, (_, index) =>
    departure(`capacity-${index}`, [call("a", 0), call("b", 10)]),
  );

  assert.equal(updateFollowedRuns([], runs, start + 60_000, 2).length, 2);
});

test("stamps each run with the age of the board it came from, not the freshest one in hand", () => {
  // The diagram reads the core observation and the line's own boards on different cadences, so the
  // two arrive minutes apart. One instant across both would have a stale run dead-reckoned from a
  // time it was never read at, which is exactly how a mark drifts away from the vehicle.
  const fresh = departure("fresh", [call("a", 0), call("b", 5), call("c", 10)], "realtime", start);
  const stale = departure(
    "stale",
    [call("a", 1), call("b", 6), call("c", 11)],
    "realtime",
    start - 5 * 60_000,
  );

  const observations = updateFollowedRuns([], [fresh, stale], start + 60_000);

  const observedById = new Map(
    observations.map((observation) => [observation.rowId, observation.observedAt]),
  );
  assert.equal(observedById.get("fresh"), start);
  assert.equal(observedById.get("stale"), start - 5 * 60_000);
});

test("a single instant still stamps every run in a batch read off one board", () => {
  const first = departure("first", [call("a", 0), call("b", 5)]);
  const second = departure("second", [call("a", 2), call("b", 7)]);

  const observations = updateFollowedRuns([], [first, second], start + 60_000);

  assert.deepEqual([...new Set(observations.map(({ observedAt }) => observedAt))], [start]);
});

test("a set followed is equal to itself until a run is named, read or ends", () => {
  const run = departure("same", [call("a", 0), call("b", 10)]);
  const followed = updateFollowedRuns([], [run], start + 60_000);

  assert.ok(areFollowedRunsEqual(followed, followed));
  assert.ok(!areFollowedRunsEqual(followed, followed.slice(1)));
  assert.ok(
    !areFollowedRunsEqual(
      followed,
      followed.map((entry) => ({ ...entry, expiresAt: entry.expiresAt + 1 })),
    ),
  );
});
