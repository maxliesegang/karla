import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { ObservedNetworkStore } from "../src/data/observed-network-store.ts";
import { getObservedTransitLines } from "../src/lib/observed-network.ts";
import { createDeparture } from "./support/fixtures.ts";

const call = (stopName: string, localStopId: string, placeName?: string): TripCall => ({
  stopName,
  localStopId,
  ...(placeName ? { placeName } : {}),
});

const trip = (
  overrides: Partial<Departure> &
    Pick<Departure, "id" | "tripId" | "destination"> & {
      tripCalls: readonly TripCall[];
    },
): Departure =>
  createDeparture({
    lineId: "2",
    transportMode: "tram",
    minutesUntilDeparture: 4,
    platformCode: "1",
    boardingLocalStopId: "europaplatz",
    status: "realtime",
    scheduledDepartureTime: "2026-09-05T12:04:00+02:00",
    ...overrides,
  });

/** The network as the app learns it: every live board passes through the store. */
const buildObservedNetwork = (boards: readonly DepartureBoard[]) => {
  const store = new ObservedNetworkStore();
  for (const liveBoard of boards) store.rememberBoard(liveBoard, 0);
  return store.getSnapshot();
};

const board = (departures: readonly Departure[]): DepartureBoard[] => [
  {
    stopId: "europaplatz",
    receivedAt: 1,
    departures,
    dataStatus: "live",
    feedUpdatedAt: "2026-09-05T12:00:00+02:00",
  },
];

test("the observed line states its extent off the farthest run, not off the signs", () => {
  // The rows at the posts sign their short workings; the one whole run the posts have seen runs
  // further than any of them says.
  const observedNetwork = buildObservedNetwork(
    board([
      trip({
        id: "short",
        tripId: "short",
        destination: "Rheinhafen über Kühler Krug",
        tripCalls: [
          call("Kühler Krug", "kuehler-krug", "Karlsruhe"),
          call("Rheinhafen", "rheinhafen", "Karlsruhe"),
        ],
      }),
      trip({
        id: "full",
        tripId: "full",
        destination: "Rheinhafen",
        tripCalls: [
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
  assert.deepEqual(observedLine.farthestRunTermini, ["Knielingen Nord", "Rheinhafen"]);
});

test("the observed line carries no extent where the farthest run turns on itself", () => {
  const observedNetwork = buildObservedNetwork(
    board([
      trip({
        id: "loop",
        tripId: "loop",
        destination: "Stupferich",
        tripCalls: [
          call("Turmberg", "turmberg", "Karlsruhe"),
          call("Rathaus", "stupferich-rathaus", "Stupferich"),
          call("Turmberg", "turmberg", "Karlsruhe"),
        ],
      }),
    ]),
  );

  assert.equal(observedNetwork.lines[0].farthestRunTermini, undefined);
});

test("the transit line keeps its mode and its extent through the family", () => {
  const transitLines = getObservedTransitLines(
    buildObservedNetwork(
      board([
        trip({
          id: "full",
          tripId: "full",
          lineId: "S2",
          transportMode: "lightRail",
          destination: "Rheinstetten",
          tripCalls: [
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
  assert.equal(line.transportMode, "lightRail");
  assert.deepEqual(line.farthestRunTermini, [
    "Rheinstetten Richard-Hecht-Schule",
    "Spöck Bach-West",
  ]);
});
