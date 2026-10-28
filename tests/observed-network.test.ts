import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, StopEventBoard, Call } from "../src/data/transit-types.ts";
import { ObservedNetworkStore } from "../src/data/observed-network-store.ts";
import { getObservedTransitLines } from "../src/lib/observed-network.ts";
import { createStopEvent } from "./support/fixtures.ts";

const call = (stopName: string, stopPlaceId: string, placeName?: string): Call => ({
  stopName,
  stopPlaceId,
  ...(placeName ? { placeName } : {}),
});

const journey = (
  overrides: Partial<StopEvent> &
    Pick<StopEvent, "id" | "journeyRef" | "destinationText"> & {
      calls: readonly Call[];
    },
): StopEvent =>
  createStopEvent({
    lineId: "2",
    ptMode: "tram",
    minutesUntilDeparture: 4,
    bay: "1",
    boardingStopPlaceId: "europaplatz",
    status: "realtime",
    timetabledDepartureTime: "2026-09-05T12:04:00+02:00",
    ...overrides,
  });

/** The network as the app learns it: every live board passes through the store. */
const buildObservedNetwork = (boards: readonly StopEventBoard[]) => {
  const store = new ObservedNetworkStore();
  for (const liveBoard of boards) store.rememberBoard(liveBoard, 0);
  return store.getSnapshot();
};

const board = (stopEvents: readonly StopEvent[]): StopEventBoard[] => [
  {
    stopId: "europaplatz",
    receivedAt: 1,
    stopEvents,
    dataStatus: "live",
    feedUpdatedAt: "2026-09-05T12:00:00+02:00",
  },
];

test("the observed line states its extent off the farthest journey, not off the signs", () => {
  // The rows at the posts sign their short workings; the one whole journey the posts have seen runs
  // further than any of them says.
  const observedNetwork = buildObservedNetwork(
    board([
      journey({
        id: "short",
        journeyRef: "short",
        destinationText: "Rheinhafen über Kühler Krug",
        calls: [
          call("Kühler Krug", "kuehler-krug", "Karlsruhe"),
          call("Rheinhafen", "rheinhafen", "Karlsruhe"),
        ],
      }),
      journey({
        id: "full",
        journeyRef: "full",
        destinationText: "Rheinhafen",
        calls: [
          call("Nord", "knielingen-nord", "Knielingen"),
          call("Feierabendweg", "feierabendweg", "Karlsruhe"),
          call("Rheinhafen", "rheinhafen", "Karlsruhe"),
        ],
      }),
    ]),
  );

  const [observedLine] = observedNetwork.lines;
  assert.equal(observedLine.id, "2");
  // Most frequent first, as the signs are read.
  assert.deepEqual(observedLine.destinations, ["Rheinhafen über Kühler Krug", "Rheinhafen"]);
  assert.deepEqual(observedLine.farthestDatedJourneyTermini, ["Knielingen Nord", "Rheinhafen"]);
});

test("the observed line carries no extent where the farthest journey turns on itself", () => {
  const observedNetwork = buildObservedNetwork(
    board([
      journey({
        id: "loop",
        journeyRef: "loop",
        destinationText: "Stupferich",
        calls: [
          call("Turmberg", "durlach-turmberg", "Karlsruhe"),
          call("Rathaus", "stupferich-rathaus", "Stupferich"),
          call("Turmberg", "durlach-turmberg", "Karlsruhe"),
        ],
      }),
    ]),
  );

  assert.equal(observedNetwork.lines[0].farthestDatedJourneyTermini, undefined);
});

test("the transit line keeps its mode and its extent through the family", () => {
  const transitLines = getObservedTransitLines(
    buildObservedNetwork(
      board([
        journey({
          id: "full",
          journeyRef: "full",
          lineId: "S2",
          ptMode: "lightRail",
          destinationText: "Rheinstetten",
          calls: [
            call("Richard-Hecht-Schule", "richard-hecht-schule", "Rheinstetten"),
            call("Mühlburger Tor", "muehlburger-tor", "Karlsruhe"),
            call("Hauptbahnhof", "hauptbahnhof", "Karlsruhe"),
            call("Bach-West", "bach-west", "Spöck"),
          ],
        }),
      ]),
    ),
  );

  const [line] = transitLines;
  assert.equal(line.ptMode, "lightRail");
  assert.deepEqual(line.farthestDatedJourneyTermini, [
    "Rheinstetten Richard-Hecht-Schule",
    "Spöck Bach-West",
  ]);
});
