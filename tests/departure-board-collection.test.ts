import assert from "node:assert/strict";
import test from "node:test";
import type { DepartureBoard } from "../src/data/transit-types.ts";
import {
  buildRetainedDepartureBoards,
  getDepartureBoardCoverage,
  RETAINED_DEPARTURE_BOARD_LIMIT_MS,
} from "../src/lib/departure-board-collection.ts";

const createBoard = (
  stopId: string,
  receivedAt: number,
  dataStatus: DepartureBoard["dataStatus"],
): DepartureBoard =>
  dataStatus === "live"
    ? {
        stopId,
        dataStatus,
        feedUpdatedAt: new Date(receivedAt).toISOString(),
        receivedAt,
        departures: [],
      }
    : { stopId, dataStatus, receivedAt, departures: [], errorMessage: "nicht erreichbar" };

test("retains a failed observation post independently while reporting partial coverage", () => {
  const stopIds = ["a", "b"];
  const first = buildRetainedDepartureBoards(
    stopIds,
    [createBoard("a", 1_000, "live"), createBoard("b", 1_000, "live")],
    new Map(),
  );
  const refreshed = [createBoard("a", 2_000, "unavailable"), createBoard("b", 2_000, "live")];
  const retained = buildRetainedDepartureBoards(stopIds, refreshed, first.liveBoardByStopId);

  assert.equal(retained.departureBoards[0].dataStatus, "live");
  assert.equal(retained.departureBoards[0].receivedAt, 1_000);
  assert.deepEqual(getDepartureBoardCoverage(stopIds, refreshed), {
    status: "partial",
    expectedBoardCount: 2,
    liveBoardCount: 1,
  });
});

test("makes an expired retained board unavailable", () => {
  const stopIds = ["a"];
  const first = buildRetainedDepartureBoards(stopIds, [createBoard("a", 1_000, "live")], new Map());
  const failed = createBoard("a", 1_000 + RETAINED_DEPARTURE_BOARD_LIMIT_MS + 1, "unavailable");
  const expired = buildRetainedDepartureBoards(stopIds, [failed], first.liveBoardByStopId);

  assert.equal(expired.departureBoards[0].dataStatus, "unavailable");
  assert.equal(getDepartureBoardCoverage(stopIds, [failed]).status, "unavailable");
});
