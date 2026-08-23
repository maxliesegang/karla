import assert from "node:assert/strict";
import test from "node:test";
import { findOperatingHint, findVehicleAccess } from "../src/data/kvv-efa-parsers.ts";

const hints = (...contents: string[]) => contents.map((content) => ({ content }));

test("reads boarding from the feed's own hints, negation first", () => {
  assert.equal(findVehicleAccess(hints("Stufenloses Fahrzeug, WLAN, WC")), "stepFree");
  assert.equal(findVehicleAccess(hints("Niederflurwagen")), "stepFree");
  assert.equal(findVehicleAccess(hints("Behindertengerechtes Fahrzeug")), "stepFree");
  // The negative contains the word the positive is matched by, so it has to be read first.
  assert.equal(findVehicleAccess(hints("Nicht barrierefreies Fahrzeug, WLAN")), "notStepFree");
});

test("a trip the feed says nothing about is unstated, never a vehicle with steps", () => {
  assert.equal(findVehicleAccess(hints("Bordrestaurant")), undefined);
  assert.equal(findVehicleAccess(undefined), undefined);
  assert.equal(findVehicleAccess(hints()), undefined);
});

test("keeps the hints about how the trip is running and drops the equipment list", () => {
  assert.equal(
    findOperatingHint(
      hints("Verspätung eines vorausfahrenden Zuges", "Stufenloses Fahrzeug, WLAN"),
    ),
    "Verspätung eines vorausfahrenden Zuges",
  );
  assert.equal(
    findOperatingHint(hints("Fahrradmitnahme begrenzt möglich", "Bistro Cafe")),
    undefined,
  );
  assert.equal(
    findOperatingHint(hints("Umleitung wegen Bauarbeiten", "Umleitung wegen Bauarbeiten")),
    "Umleitung wegen Bauarbeiten",
  );
});
