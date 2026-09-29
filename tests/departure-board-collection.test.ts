import assert from "node:assert/strict";
import test from "node:test";
import type { DepartureBoard } from "../src/data/transit-types.ts";
import { getDepartureBoardCoverage, isFailedBoard } from "../src/lib/departure-board-collection.ts";

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

test("a board kept in place of a failed refresh counts against coverage", () => {
  const stopIds = ["a", "b"];
  const kept = { ...createBoard("a", 1_000, "live"), refreshFailedAt: 2_000 } as DepartureBoard;
  const boards = [kept, createBoard("b", 2_000, "live")];

  assert.equal(isFailedBoard(kept), true);
  assert.deepEqual(getDepartureBoardCoverage(stopIds, boards), {
    status: "partial",
    expectedBoardCount: 2,
    liveBoardCount: 1,
  });
});

test("a board nothing could be read for is unavailable coverage", () => {
  const failed = createBoard("a", 1_000, "unavailable");

  assert.equal(isFailedBoard(failed), true);
  assert.equal(getDepartureBoardCoverage(["a"], [failed]).status, "unavailable");
});
