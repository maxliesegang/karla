import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import {
  findNextCompatibleDeparture,
  findStopByName,
  hasCompatibleStopPattern,
} from "../src/lib/stop-services.ts";
import { transitNetwork } from "../src/data/transit-network.ts";

function departure(
  overrides: Partial<Departure> & Pick<Departure, "id" | "destination">,
): Departure {
  return {
    tripId: overrides.id,
    lineId: "2",
    transportMode: "tram",
    minutesUntilDeparture: 4,
    platformName: "1",
    boardingStopId: "europaplatz",
    status: "realtime",
    scheduledDepartureTime: "2026-08-24T12:04:00+02:00",
    ...overrides,
  };
}

const calls = (...stopNames: string[]): TripCall[] =>
  stopNames.map((stopName, index) => ({
    stopName,
    localStopId: stopName.toLowerCase(),
    isCurrentStop: index === 0,
  }));

test("does not read two lines of one family as the same service", () => {
  const s1 = departure({ id: "s1", lineId: "S1", destination: "Hochstetten" });
  const s11 = departure({ id: "s11", lineId: "S11", destination: "Hochstetten" });

  assert.equal(hasCompatibleStopPattern(s1, s11), false);
});

test("keeps two detailed patterns apart even when their destination is the same", () => {
  const direct = departure({
    id: "direct",
    destination: "Durlach",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = departure({
    id: "branch",
    destination: "Durlach",
    tripCalls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  assert.equal(hasCompatibleStopPattern(direct, branch), false);
});

test("finds the following non-cancelled departure over the same observed route", () => {
  const cancelled = departure({ id: "cancelled", destination: "Durlach", status: "cancelled" });
  const otherDirection = departure({ id: "other", destination: "Knielingen Nord" });
  const cancelledAgain = departure({
    id: "cancelled-again",
    destination: "Durlach",
    status: "cancelled",
  });
  const replacement = departure({
    id: "replacement",
    destination: "Durlach",
    minutesUntilDeparture: 14,
  });

  assert.equal(
    findNextCompatibleDeparture([cancelled, otherDirection, cancelledAgain, replacement], cancelled)
      ?.id,
    "replacement",
  );
});

/**
 * The fallback for a call whose provider id resolved to nothing, so the name is all there is.
 *
 * A local stop is the place; the feed names the platform the call was made at. Matching those two
 * strings against each other only works once the operator's qualifier is off the feed's.
 */
test("a call named for one platform of a place resolves to that place", () => {
  const marktplatz = findStopByName(transitNetwork, "Marktplatz (Kaiserstraße U)");
  assert.equal(marktplatz?.id, "marktplatz");
  assert.equal(findStopByName(transitNetwork, "Marktplatz")?.id, "marktplatz");
  // A second name the operator does not publish still resolves, and an unmapped stop still does not.
  assert.equal(findStopByName(transitNetwork, "Mendelssohnplatz")?.id, "rueppurrer-tor");
  assert.equal(findStopByName(transitNetwork, "Lameyplatz"), undefined);
});
