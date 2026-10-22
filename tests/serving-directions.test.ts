import assert from "node:assert/strict";
import test from "node:test";
import type { KvvStopEventBoard, KvvFeed } from "../src/data/kvv-feed.ts";
import { SERVING_DIRECTION_TTL_MS, ServingDirections } from "../src/data/serving-directions.ts";
import { KvvTransitSource } from "../src/data/transit-source.ts";
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
      boardingLocalStopId: "europaplatz",
      calls: [
        { stopName: "Mühlburger Tor", localStopId: "muehlburger-tor" },
        { stopName: "Europaplatz", localStopId: "europaplatz" },
        { stopName: "Karlstor", localStopId: "karlstor" },
      ],
    }),
    createStopEvent({
      id: "cancelled",
      lineRef: LINE_2,
      boardingLocalStopId: "europaplatz",
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

/** A feed whose boards state no serving lines, as TRIAS's do, unless told otherwise. */
function createFeed(boards: Record<string, Partial<KvvStopEventBoard>>) {
  return {
    fetchStopEventBoard: async (stopPointId: string): Promise<KvvStopEventBoard> => ({
      stopPointId,
      stopName: "",
      serverTime: "2026-10-20T08:00:00.000Z",
      servingLines: [],
      stopEvents: [],
      ...boards[stopPointId],
    }),
  } as unknown as KvvFeed;
}

test("a stop's board names the directions observed runs serve it by, beside what the feed states", async () => {
  const source = new KvvTransitSource(
    createFeed({
      // Europaplatz's board, with each run's calls.
      "7000037": {
        stopEvents: [
          {
            stopPointId: "7000037",
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
              { stopName: "Europaplatz", providerId: "7000037" },
              { stopName: "Karlstor", providerId: "7000061" },
            ],
          },
        ],
      },
      // Karlstor's feed states another line itself.
      "7000061": {
        servingLines: [{ lineId: "2", lineRef: LINE_2, ptMode: "tram" }],
      },
    }),
  );

  await source.getStopEventBoard("europaplatz", { includeCalls: true });
  const karlstor = await source.getStopEventBoard("karlstor");
  const filtered = await source.getStopEventBoard("karlstor", { lineRefs: [LINE_2] });

  assert.deepEqual(
    karlstor.servingLines?.map(({ lineId, lineRef }) => [lineId, lineRef]),
    [
      ["2", LINE_2],
      ["S5", S5],
    ],
  );
  assert.equal(filtered.servingLines, undefined);
});
