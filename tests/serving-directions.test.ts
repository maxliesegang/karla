import assert from "node:assert/strict";
import test from "node:test";
import type { FeedStopEventBoard, Feed } from "../src/data/feed.ts";
import { SERVING_DIRECTION_TTL_MS, ServingDirections } from "../src/data/serving-directions.ts";
import { TriasTransitSource } from "../src/data/transit-source.ts";
import { createStopEvent } from "./support/fixtures.ts";

const S5 = "kvv:22305:E:R:s26";
const LINE_2 = "kvv:21002:E:H:s26";

test("a run's direction serves every stop it calls at, until the TTL passes unseen", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const directions = new ServingDirections();
  directions.remember([
    createStopEvent({
      id: "s5",
      lineId: "S5",
      lineRef: S5,
      boardingStopPlaceId: "europaplatz",
      calls: [
        { stopName: "Mühlburger Tor", stopPlaceId: "muehlburger-tor" },
        { stopName: "Europaplatz", stopPlaceId: "europaplatz" },
        { stopName: "Karlstor", stopPlaceId: "karlstor" },
      ],
    }),
    createStopEvent({
      id: "cancelled",
      lineRef: LINE_2,
      boardingStopPlaceId: "europaplatz",
      status: "cancelled",
    }),
  ]);

  for (const stopId of ["muehlburger-tor", "europaplatz", "karlstor"]) {
    assert.deepEqual(
      directions.find(stopId).map(({ lineRef }) => lineRef),
      [S5],
    );
  }
  t.mock.timers.tick(SERVING_DIRECTION_TTL_MS + 1);
  assert.deepEqual(directions.find("karlstor"), []);
});

/** A feed answering each stop point with the board given for it, empty otherwise. */
function createFeed(boards: Record<string, Partial<FeedStopEventBoard>>) {
  return {
    fetchStopEventBoard: async (stopPointId: string): Promise<FeedStopEventBoard> => ({
      stopPointId,
      stopName: "",
      serverTime: "2026-10-20T08:00:00.000Z",
      stopEvents: [],
      ...boards[stopPointId],
    }),
  } as unknown as Feed;
}

test("a stop's board names the directions observed runs serve it by", async () => {
  const source = new TriasTransitSource(
    createFeed({
      // Europaplatz's board, with each run's calls.
      "de:08212:37": {
        stopEvents: [
          {
            stopPointId: "de:08212:37",
            stopPointName: "Europaplatz",
            lineId: "S5",
            lineRef: S5,
            ptMode: "lightRail",
            destinationText: "Pforzheim Hauptbahnhof",
            minutesUntilDeparture: 3,
            bay: "3",
            status: "realtime",
            timetabledDepartureTime: "2026-10-20T08:03:00.000Z",
            calls: [
              { stopName: "Europaplatz", stopPointId: "de:08212:37" },
              { stopName: "Karlstor", stopPointId: "de:08212:61" },
            ],
          },
        ],
      },
    }),
  );

  await source.getStopEventBoard("europaplatz", { includeCalls: true });
  const karlstor = await source.getStopEventBoard("karlstor");
  const filtered = await source.getStopEventBoard("karlstor", { lineRefs: [S5] });

  assert.deepEqual(
    karlstor.servingLines?.map(({ lineId, lineRef }) => [lineId, lineRef]),
    [["S5", S5]],
  );
  assert.equal(filtered.servingLines, undefined);
});
