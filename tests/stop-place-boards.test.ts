import assert from "node:assert/strict";
import test from "node:test";
import {
  joinStopEventBoards,
  type Feed,
  type FeedStopEvent,
  type FeedStopEventBoard,
} from "../src/data/feed.ts";
import { TriasTransitSource } from "../src/data/transit-source.ts";

const SERVER_TIME = "2026-10-27T08:00:00.000Z";

const stopEvent = (stopPointId: string, minute: number): FeedStopEvent => ({
  stopPointId,
  stopPointName: stopPointId,
  journeyRef: `${stopPointId}@${minute}`,
  lineId: "2",
  lineRef: "kvv:21002:E:H:s26",
  ptMode: "tram",
  destinationText: "Wolfartsweier",
  minutesUntilDeparture: minute,
  bay: "1",
  status: "scheduled",
  timetabledDepartureTime: new Date(Date.parse(SERVER_TIME) + minute * 60_000).toISOString(),
});

const board = (stopPointId: string, minutes: readonly number[]): FeedStopEventBoard => ({
  stopPointId,
  stopName: stopPointId,
  serverTime: SERVER_TIME,
  stopEvents: minutes.map((minute) => stopEvent(stopPointId, minute)),
});

const minutesOf = ({ stopEvents }: FeedStopEventBoard) =>
  stopEvents.map(
    ({ stopPointId, minutesUntilDeparture }) => `${stopPointId}+${minutesUntilDeparture}`,
  );

test("a joined board ends where a full board's rows ran out", () => {
  // The street answered its three rows within five minutes; the tunnel's later rows would stand
  // alone past them, as if the street had nothing due.
  const joined = joinStopEventBoards([board("street", [1, 3, 5]), board("tunnel", [2, 9, 20])], 3);

  assert.deepEqual(minutesOf(joined), ["street+1", "street+3", "street+5", "tunnel+2"]);
});

test("a joined board of boards that all ran short keeps every row", () => {
  const joined = joinStopEventBoards([board("street", [1, 5]), board("tunnel", [2, 20])], 3);

  assert.deepEqual(minutesOf(joined), ["street+1", "street+5", "tunnel+2", "tunnel+20"]);
});

test("a stop place's board reads each of its stop points and names the first", async () => {
  const asked: string[] = [];
  const feed = {
    fetchStopEventBoard: async (stopPointId: string) => {
      asked.push(stopPointId);
      return board(stopPointId, stopPointId === "de:08212:1003" ? [2] : [4]);
    },
  } as unknown as Feed;

  const marktplatz = await new TriasTransitSource(feed).getStopEventBoard("marktplatz");

  assert.deepEqual(asked, ["de:08212:1003", "de:08212:1011"]);
  assert.deepEqual(
    marktplatz.stopEvents.map(({ boardingStopPointId }) => boardingStopPointId),
    ["de:08212:1003", "de:08212:1011"],
  );
});
