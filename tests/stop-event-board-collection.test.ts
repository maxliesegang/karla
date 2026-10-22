import assert from "node:assert/strict";
import test from "node:test";
import type { StopEventBoard } from "../src/data/transit-types.ts";
import {
  getBoardsFailureKind,
  getStopEventBoardCoverage,
  isFailedBoard,
} from "../src/lib/stop-event-board-collection.ts";

const createBoard = (
  stopId: string,
  receivedAt: number,
  dataStatus: StopEventBoard["dataStatus"],
): StopEventBoard =>
  dataStatus === "live"
    ? {
        stopId,
        dataStatus,
        feedUpdatedAt: new Date(receivedAt).toISOString(),
        receivedAt,
        stopEvents: [],
      }
    : { stopId, dataStatus, receivedAt, stopEvents: [], errorMessage: "nicht erreichbar" };

test("a board kept in place of a failed refresh counts against coverage", () => {
  const stopIds = ["a", "b"];
  const kept = { ...createBoard("a", 1_000, "live"), refreshFailedAt: 2_000 } as StopEventBoard;
  const boards = [kept, createBoard("b", 2_000, "live")];

  assert.equal(isFailedBoard(kept), true);
  assert.deepEqual(getStopEventBoardCoverage(stopIds, boards), {
    status: "partial",
    expectedBoardCount: 2,
    liveBoardCount: 1,
  });
});

test("a board nothing could be read for is unavailable coverage", () => {
  const failed = createBoard("a", 1_000, "unavailable");

  assert.equal(isFailedBoard(failed), true);
  assert.equal(getStopEventBoardCoverage(["a"], [failed]).status, "unavailable");
});

test("a refresh that failed behind a live board is retried like a lost request", () => {
  const live = createBoard("a", 1_000, "live");
  const retained = { ...live, refreshFailedAt: 31_000 };
  const unavailable = createBoard("b", 1_000, "unavailable");

  assert.equal(getBoardsFailureKind([live]), undefined);
  assert.equal(getBoardsFailureKind([live, retained]), "transient");
  // Nothing usable outranks a board still standing in.
  assert.equal(getBoardsFailureKind([retained, unavailable]), "unavailable");
});
