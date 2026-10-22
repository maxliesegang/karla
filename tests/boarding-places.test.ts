import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import {
  findSharedBoardingPlace,
  getBoardingPlaceLabel,
  getStopBoardingPlaces,
  updateStopBoardingObservations,
} from "../src/lib/boarding-places.ts";
import { groupStopEventsByBoardingPlace } from "../src/lib/stop-event-order.ts";
import { createStopEvent } from "./support/fixtures.ts";

/**
 * The two stops this exists for, with real coordinates from GTFS `stops.txt` (clustering reads
 * them).
 */
const EUROPAPLATZ_BAYS: Record<string, { latitude: number; longitude: number }> = {
  "3": { latitude: 49.00967384, longitude: 8.39499888 },
  "4": { latitude: 49.00940868, longitude: 8.39492701 },
  "5": { latitude: 49.0100804, longitude: 8.39366937 },
  "6": { latitude: 49.01002148, longitude: 8.39448684 },
  A: { latitude: 49.01006862, longitude: 8.39311241 },
  "1(U)": { latitude: 49.01006862, longitude: 8.39371429 },
  "2(U)": { latitude: 49.00999791, longitude: 8.39463955 },
};

const isUnderground = (code: string) => code.endsWith("(U)");

const call = (code: string, overrides: Partial<Call> = {}): Call => ({
  stopName: isUnderground(code) ? "Europaplatz (U)" : "Europaplatz",
  placeName: "Karlsruhe",
  localStopId: "europaplatz",
  providerStopPointId: isUnderground(code) ? "7001004" : "7000037",
  bayText: `Gleis ${code}`,
  bay: code,
  ...EUROPAPLATZ_BAYS[code],
  ...overrides,
});

let stopEventCount = 0;
function stopEvent(code: string, calls?: readonly Call[]): StopEvent {
  stopEventCount += 1;
  return {
    id: `d${stopEventCount}`,
    lineId: "4",
    ptMode: "tram",
    destinationText: "Oberreut",
    minutesUntilDeparture: 5,
    bay: code,
    bayKind: code === "A" ? "stand" : "track",
    boardingLocalStopId: "europaplatz",
    boardingProviderStopPointId: isUnderground(code) ? "7001004" : "7000037",
    boardingProviderStopPointName: isUnderground(code) ? "Europaplatz (U)" : "Europaplatz",
    status: "scheduled",
    timetabledDepartureTime: "2026-09-04T08:58:00+02:00",
    ...(calls ? { calls } : {}),
  };
}

/** The places, read as the app reads them. */
const placesOf = (stopEvents: readonly StopEvent[]) =>
  getStopBoardingPlaces(updateStopBoardingObservations(null, "europaplatz", stopEvents));

/** Onward calls of a tram stopping at both street platforms in turn, as trip 1374 does. */
const streetDoubleCall = [call("3"), call("5"), { stopName: "Mühlburger Tor", localStopId: "mt" }];

test("a stop nothing has been observed to part is one place", () => {
  // Platforms are parted only by evidence, never by a distance threshold.
  const places = placesOf([
    stopEvent("3", [call("3"), { stopName: "Mühlburger Tor", localStopId: "mt" }]),
    stopEvent("4"),
  ]);

  assert.equal(places.length, 1);
  assert.deepEqual(places[0].bays, ["3", "4"]);
});

test("a trip calling at two platforms in turn parts them, whatever the codes suggest", () => {
  // Europaplatz's street platforms are two places 110 m apart, shown only by line 4 leaving `Gleis
  // 3` at 08:58 and `Gleis 5` at 08:59; eastbound, `Gleis 6` then `Gleis 4`.
  const places = placesOf([
    stopEvent("3", streetDoubleCall),
    stopEvent("4"),
    stopEvent("5"),
    stopEvent("6", [call("6"), call("4"), { stopName: "Durlacher Tor", localStopId: "dt" }]),
  ]);

  assert.deepEqual(
    places.map(({ bays }) => bays),
    [
      ["3", "4"],
      ["5", "6"],
    ],
  );
});

test("a level is never merged into the one above it, however close the two stand", () => {
  // `Gleis 5` is three metres from the tunnel's `Gleis 1(U)`, above it; only the stop point tells
  // levels apart.
  const places = placesOf([
    stopEvent("5", streetDoubleCall),
    stopEvent("3"),
    stopEvent("1(U)"),
    stopEvent("2(U)"),
  ]);

  const tunnel = places.find((place) => place.providerStopPointId === "7001004");
  assert.deepEqual(tunnel?.bays, ["1(U)", "2(U)"]);
  // The label comes from the stop point's bracketed aside.
  assert.equal(tunnel && getBoardingPlaceLabel(tunnel), "U");
});

test("a bus bay is its own place, because its sign carries another word", () => {
  const places = placesOf([stopEvent("5", streetDoubleCall), stopEvent("3"), stopEvent("A")]);

  const bay = places.find(({ bays }) => bays.includes("A"));
  assert.deepEqual(bay?.bays, ["A"]);
  assert.equal(bay?.bayKind, "stand");
});

test("a place with no name of its own is known by the platforms standing at it", () => {
  const places = placesOf([stopEvent("3", streetDoubleCall), stopEvent("5")]);

  assert.deepEqual(places.map(getBoardingPlaceLabel), ["3", "5"]);
});

test("the platform reading stands the platforms under the place they belong to", () => {
  const stopEvents = [
    stopEvent("3", streetDoubleCall),
    stopEvent("4"),
    stopEvent("5"),
    stopEvent("1(U)"),
  ];
  const places = placesOf(stopEvents);

  const groups = groupStopEventsByBoardingPlace(stopEvents, places);
  assert.deepEqual(
    groups.map((group) => [
      group.boardingPlace && getBoardingPlaceLabel(group.boardingPlace),
      group.bayGroups.map(({ bay: code }) => code),
    ]),
    // Platform order, as the signposts are.
    [
      ["U", ["1(U)"]],
      ["3 · 4", ["3", "4"]],
      ["5", ["5"]],
    ],
  );
});

test("a stop that is one place reads exactly as it always did", () => {
  const stopEvents = [stopEvent("3"), stopEvent("4")];
  const groups = groupStopEventsByBoardingPlace(stopEvents, placesOf(stopEvents));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].boardingPlace, undefined);
  assert.deepEqual(
    groups[0].bayGroups.map(({ bay: code }) => code),
    ["3", "4"],
  );
});

test("a direction says which place it leaves from only where all of its trips agree", () => {
  const stopEvents = [
    stopEvent("3", streetDoubleCall),
    stopEvent("4"),
    stopEvent("5"),
    stopEvent("1(U)"),
  ];
  const places = placesOf(stopEvents);

  const eastern = findSharedBoardingPlace(places, [stopEvents[0], stopEvents[1]]);
  assert.equal(eastern && getBoardingPlaceLabel(eastern), "3 · 4");
  assert.equal(findSharedBoardingPlace(places, [stopEvents[0], stopEvents[2]]), undefined);
});

test("a vehicle turning round is not two places, from whichever end it is read", () => {
  // Turmberg's buses lay over between `Bstg. A` and `Bstg. D`; the turnaround mark is only visible
  // where neither call is the row's own, so it is collected there and subtracted at the end.
  const bay = (code: string, overrides: Partial<Call> = {}): Call => ({
    stopName: "Turmberg",
    placeName: "Karlsruhe",
    localStopId: "turmberg",
    providerStopPointId: "7000018",
    bay: code,
    bayText: `Bstg. ${code}`,
    timetabledArrivalTime: "2026-09-04T07:29:00+02:00",
    timetabledDepartureTime: "2026-09-04T07:29:00+02:00",
    ...overrides,
  });
  const stand = (code: string, calls: readonly Call[]): StopEvent =>
    createStopEvent({
      ...stopEvent("A"),
      bay: code,
      bayKind: "stand",
      boardingLocalStopId: "turmberg",
      boardingProviderStopPointId: "7000018",
      boardingProviderStopPointName: "Turmberg",
      calls,
    });

  // The reading whose row is the second call: the first states no arrival, a run origin.
  const fromD = [
    bay("A", { timetabledArrivalTime: undefined }),
    bay("D", { isThisCall: true, timetabledArrivalTime: undefined }),
  ];
  // From the other end, where the mark is invisible.
  const fromA = [bay("A", { isThisCall: true, timetabledArrivalTime: undefined }), bay("D")];

  for (const readings of [
    [fromA, fromD],
    [fromD, fromA],
  ]) {
    let observations = null;
    for (const calls of readings) {
      observations = updateStopBoardingObservations(observations, "turmberg", [
        stand(calls[0].bay!, calls),
        stand(calls[1].bay!, calls),
      ]);
    }
    const places = getStopBoardingPlaces(observations!);
    assert.deepEqual(
      places.map(({ bays }) => bays),
      [["A", "D"]],
    );
  }
});
