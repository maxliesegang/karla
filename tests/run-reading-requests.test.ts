import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunReadingKey,
  readRunBatch,
  getRunReadingRequests,
  type RunReadingRequest,
} from "../src/lib/run-reading-requests.ts";

const LINE_MAX_AGE_MS = 60_000;
const BOARD_REFRESH_MS = 30_000;

const lineKey = (selectedRowId?: string) =>
  createRunReadingKey({
    rowIds: ["stop-a-3001", "stop-a-3002", "stop-a-3003"],
    maxAgeMs: LINE_MAX_AGE_MS,
    ...(selectedRowId ? { selectedRowId, selectedMaxAgeMs: BOARD_REFRESH_MS } : {}),
  });

const findTolerance = (requests: RunReadingRequest[], rowId: string) =>
  requests.find((request) => request.rowId === rowId)?.maxAgeMs;

test("a line reads every run on the line's own tolerance where the rider chose none", () => {
  const requests = getRunReadingRequests(lineKey());
  assert.deepEqual(
    requests.map(({ maxAgeMs }) => maxAgeMs),
    [LINE_MAX_AGE_MS, LINE_MAX_AGE_MS, LINE_MAX_AGE_MS],
  );
});

/**
 * The tolerance the rider's own run earns is theirs alone.
 *
 * Collapsed to one number for the whole set — the tightest of them, which is what a set holding a
 * chosen run always resolves to — the line's other runs are re-read on the board's cadence instead
 * of their own, and a stop board with a departure selected spends twice the requests it needs to.
 */
test("the run a rider chose is read faster without dragging the rest of the line with it", () => {
  const requests = getRunReadingRequests(lineKey("stop-a-3002"));
  assert.equal(findTolerance(requests, "stop-a-3002"), BOARD_REFRESH_MS);
  assert.equal(findTolerance(requests, "stop-a-3001"), LINE_MAX_AGE_MS);
  assert.equal(findTolerance(requests, "stop-a-3003"), LINE_MAX_AGE_MS);
});

test("the runs are read in the order the key names them", () => {
  assert.deepEqual(
    getRunReadingRequests(lineKey("stop-a-3002")).map(({ rowId }) => rowId),
    ["stop-a-3001", "stop-a-3002", "stop-a-3003"],
  );
});

/** A view's first read looks past every tolerance the key states, the chosen run's included. */
test("an entry read asks the source for a fresh answer for every run", () => {
  const requests = getRunReadingRequests(lineKey("stop-a-3002"), 0);
  assert.deepEqual(
    requests.map(({ maxAgeMs }) => maxAgeMs),
    [0, 0, 0],
  );
});

test("a row id carrying provider punctuation survives the key", () => {
  const rowIds = ["karlsruhe-marktplatz-(kaiserstr.)-kvv:3-1|4", 'a"b'];
  const requests = getRunReadingRequests(
    createRunReadingKey({ rowIds, maxAgeMs: LINE_MAX_AGE_MS }),
  );
  assert.deepEqual(
    requests.map(({ rowId }) => rowId),
    rowIds,
  );
});

test("a partial run-reading failure remains a failed batch", async () => {
  const result = await readRunBatch(lineKey(), false, async (rowId) =>
    rowId === "stop-a-3002" ? undefined : rowId,
  );

  assert.deepEqual(result.readings, ["stop-a-3001", "stop-a-3003"]);
  assert.deepEqual(result.failedRowIds, ["stop-a-3002"]);
});

test("a rejected run read does not swallow the other answers", async () => {
  const result = await readRunBatch(lineKey(), false, async (rowId) => {
    if (rowId === "stop-a-3002") throw new Error("feed unavailable");
    return rowId;
  });

  assert.deepEqual(result.readings, ["stop-a-3001", "stop-a-3003"]);
  assert.deepEqual(result.failedRowIds, ["stop-a-3002"]);
});
