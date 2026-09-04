import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import {
  findSharedBoardingPlace,
  getBoardingPlaceLabel,
  getStopBoardingPlaces,
  updateStopBoardingObservations,
} from "../src/lib/boarding-places.ts";
import { groupDeparturesByBoardingPlace } from "../src/lib/departure-order.ts";

/**
 * The two stops this exists for, as the feed really answers them — coordinates and all, because the
 * clustering reads them. Positions are the operator's own, from GTFS `stops.txt`.
 */
const EUROPAPLATZ_PLATFORMS: Record<string, { latitude: number; longitude: number }> = {
  "3": { latitude: 49.00967384, longitude: 8.39499888 },
  "4": { latitude: 49.00940868, longitude: 8.39492701 },
  "5": { latitude: 49.0100804, longitude: 8.39366937 },
  "6": { latitude: 49.01002148, longitude: 8.39448684 },
  A: { latitude: 49.01006862, longitude: 8.39311241 },
  "1(U)": { latitude: 49.01006862, longitude: 8.39371429 },
  "2(U)": { latitude: 49.00999791, longitude: 8.39463955 },
};

const isUnderground = (platformCode: string) => platformCode.endsWith("(U)");

const call = (platformCode: string, overrides: Partial<TripCall> = {}): TripCall => ({
  stopName: isUnderground(platformCode) ? "Europaplatz (U)" : "Europaplatz",
  placeName: "Karlsruhe",
  localStopId: "europaplatz",
  providerStopPointId: isUnderground(platformCode) ? "7001004" : "7000037",
  platformLabel: `Gleis ${platformCode}`,
  platformCode,
  ...EUROPAPLATZ_PLATFORMS[platformCode],
  ...overrides,
});

let departureCount = 0;
function departure(platformCode: string, tripCalls?: readonly TripCall[]): Departure {
  departureCount += 1;
  return {
    id: `d${departureCount}`,
    lineId: "4",
    transportMode: "tram",
    destination: "Oberreut",
    minutesUntilDeparture: 5,
    platformCode,
    platformKind: platformCode === "A" ? "stand" : "track",
    boardingLocalStopId: "europaplatz",
    boardingProviderStopPointId: isUnderground(platformCode) ? "7001004" : "7000037",
    boardingProviderStopPointName: isUnderground(platformCode) ? "Europaplatz (U)" : "Europaplatz",
    status: "scheduled",
    scheduledDepartureTime: "2026-09-04T08:58:00+02:00",
    ...(tripCalls ? { tripCalls } : {}),
  };
}

/** The places, read the way the app reads them: everything the visit has seen, then gathered. */
const placesOf = (departures: readonly Departure[]) =>
  getStopBoardingPlaces(updateStopBoardingObservations(null, "europaplatz", departures));

/** The onward calls of a tram that stops at both street platforms in turn, as trip 1374 does. */
const streetDoubleCall = [call("3"), call("5"), { stopName: "Mühlburger Tor", localStopId: "mt" }];

test("a stop nothing has been observed to part is one place", () => {
  // The reading every ordinary stop wants, and the conservative one everywhere else: platforms are
  // parted by evidence, never by a distance somebody picked.
  const places = placesOf([
    departure("3", [call("3"), { stopName: "Mühlburger Tor", localStopId: "mt" }]),
    departure("4"),
  ]);

  assert.equal(places.length, 1);
  assert.deepEqual(places[0].platformCodes, ["3", "4"]);
});

test("a trip calling at two platforms in turn parts them, whatever the codes suggest", () => {
  // Europaplatz's four street platforms are two places 110 m apart, and nothing published says so
  // except line 4 leaving `Gleis 3` at 08:58 and `Gleis 5` at 08:59. The eastbound working states
  // the other half of the same fact, `Gleis 6` before `Gleis 4`.
  const places = placesOf([
    departure("3", streetDoubleCall),
    departure("4"),
    departure("5"),
    departure("6", [call("6"), call("4"), { stopName: "Durlacher Tor", localStopId: "dt" }]),
  ]);

  assert.deepEqual(
    places.map(({ platformCodes }) => platformCodes),
    [
      ["3", "4"],
      ["5", "6"],
    ],
  );
});

test("a level is never merged into the one above it, however close the two stand", () => {
  // `Gleis 5` is three metres from the tunnel's `Gleis 1(U)` and ten metres above it. Neither the
  // feed nor GTFS states a height, so the stop point is what carries the level — and it is why
  // distance may decide which merge happens first but never whether one may.
  const places = placesOf([
    departure("5", streetDoubleCall),
    departure("3"),
    departure("1(U)"),
    departure("2(U)"),
  ]);

  const tunnel = places.find((place) => place.providerStopPointId === "7001004");
  assert.deepEqual(tunnel?.platformCodes, ["1(U)", "2(U)"]);
  // And it takes the operator's own name for itself out of the stop point's bracketed aside.
  assert.equal(tunnel && getBoardingPlaceLabel(tunnel), "U");
});

test("a bus bay is its own place, because its sign carries another word", () => {
  const places = placesOf([departure("5", streetDoubleCall), departure("3"), departure("A")]);

  const bay = places.find(({ platformCodes }) => platformCodes.includes("A"));
  assert.deepEqual(bay?.platformCodes, ["A"]);
  assert.equal(bay?.platformKind, "stand");
});

test("a place with no name of its own is known by the platforms standing at it", () => {
  const places = placesOf([departure("3", streetDoubleCall), departure("5")]);

  assert.deepEqual(places.map(getBoardingPlaceLabel), ["3", "5"]);
});

test("the platform reading stands the platforms under the place they belong to", () => {
  const departures = [
    departure("3", streetDoubleCall),
    departure("4"),
    departure("5"),
    departure("1(U)"),
  ];
  const places = placesOf(departures);

  const groups = groupDeparturesByBoardingPlace(departures, places);
  assert.deepEqual(
    groups.map((group) => [
      group.boardingPlace && getBoardingPlaceLabel(group.boardingPlace),
      group.platformGroups.map(({ platformCode }) => platformCode),
    ]),
    // Platform order, which is the order the signposts under them are already in.
    [
      ["U", ["1(U)"]],
      ["3 · 4", ["3", "4"]],
      ["5", ["5"]],
    ],
  );
});

test("a stop that is one place reads exactly as it always did", () => {
  const departures = [departure("3"), departure("4")];
  const groups = groupDeparturesByBoardingPlace(departures, placesOf(departures));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].boardingPlace, undefined);
  assert.deepEqual(
    groups[0].platformGroups.map(({ platformCode }) => platformCode),
    ["3", "4"],
  );
});

test("a direction says which place it leaves from only where all of its trips agree", () => {
  const departures = [
    departure("3", streetDoubleCall),
    departure("4"),
    departure("5"),
    departure("1(U)"),
  ];
  const places = placesOf(departures);

  const eastern = findSharedBoardingPlace(places, [departures[0], departures[1]]);
  assert.equal(eastern && getBoardingPlaceLabel(eastern), "3 · 4");
  assert.equal(findSharedBoardingPlace(places, [departures[0], departures[2]]), undefined);
});

test("a vehicle turning round is not two places, from whichever end it is read", () => {
  // Turmberg's buses lay over four minutes between `Bstg. A` and `Bstg. D`, and the feed marks the
  // first call as the origin of a run. Every board row departs from one of the stop's platforms, so
  // one of the two calls is always the row's own — and that call arrives with no arrival time,
  // looking exactly like an origin whether or not it is one. Read from the wrong end, the layover
  // would part a terminus into halves; the mark is therefore collected where it can be trusted and
  // subtracted from the separations at the end.
  const bay = (platformCode: string, overrides: Partial<TripCall> = {}): TripCall => ({
    stopName: "Turmberg",
    placeName: "Karlsruhe",
    localStopId: "turmberg",
    providerStopPointId: "7000018",
    platformCode,
    platformLabel: `Bstg. ${platformCode}`,
    scheduledArrivalTime: "2026-09-04T07:29:00+02:00",
    scheduledDepartureTime: "2026-09-04T07:29:00+02:00",
    ...overrides,
  });
  const stand = (platformCode: string, tripCalls: readonly TripCall[]): Departure => ({
    ...departure("A"),
    platformCode,
    platformKind: "stand",
    boardingLocalStopId: "turmberg",
    boardingProviderStopPointId: "7000018",
    boardingProviderStopPointName: "Turmberg",
    tripCalls,
  });

  // The reading whose own row is the second call: the first states a departure and no arrival,
  // which is the feed saying the run begins there.
  const fromD = [
    bay("A", { scheduledArrivalTime: undefined }),
    bay("D", { isCurrentStop: true, scheduledArrivalTime: undefined }),
  ];
  // And the reading from the other end, where the mark is exactly the one thing not visible.
  const fromA = [bay("A", { isCurrentStop: true, scheduledArrivalTime: undefined }), bay("D")];

  for (const readings of [
    [fromA, fromD],
    [fromD, fromA],
  ]) {
    let observations = null;
    for (const calls of readings) {
      observations = updateStopBoardingObservations(observations, "turmberg", [
        stand(calls[0].platformCode!, calls),
        stand(calls[1].platformCode!, calls),
      ]);
    }
    const places = getStopBoardingPlaces(observations!);
    assert.deepEqual(
      places.map(({ platformCodes }) => platformCodes),
      [["A", "D"]],
    );
  }
});
