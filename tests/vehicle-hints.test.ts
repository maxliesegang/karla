import assert from "node:assert/strict";
import test from "node:test";
import { readOperatingNote, readVehicleAccess } from "../src/data/feed-conventions.ts";

const hints = (...remarks: string[]) => remarks;

test("reads boarding from the feed's own hints, negation first", () => {
  assert.equal(readVehicleAccess(hints("Stufenloses Fahrzeug, WLAN, WC")), "stepFree");
  assert.equal(readVehicleAccess(hints("Niederflurwagen")), "stepFree");
  assert.equal(readVehicleAccess(hints("Behindertengerechtes Fahrzeug")), "stepFree");
  // The negative contains the word the positive is matched by, so it has to be read first.
  assert.equal(readVehicleAccess(hints("Nicht barrierefreies Fahrzeug, WLAN")), "notStepFree");
});

test("a journey the feed says nothing about is unstated, never a vehicle with steps", () => {
  assert.equal(readVehicleAccess(hints("Bordrestaurant")), undefined);
  assert.equal(readVehicleAccess([]), undefined);
  assert.equal(readVehicleAccess(hints()), undefined);
});

test("keeps the hints about how the journey is running and drops the equipment list", () => {
  assert.equal(
    readOperatingNote(
      hints("Verspätung eines vorausfahrenden Zuges", "Stufenloses Fahrzeug, WLAN"),
    ),
    "Verspätung eines vorausfahrenden Zuges",
  );
  assert.equal(
    readOperatingNote(hints("Fahrradmitnahme begrenzt möglich", "Bistro Cafe")),
    undefined,
  );
  assert.equal(
    readOperatingNote(hints("Umleitung wegen Bauarbeiten", "Umleitung wegen Bauarbeiten")),
    "Umleitung wegen Bauarbeiten",
  );
});
