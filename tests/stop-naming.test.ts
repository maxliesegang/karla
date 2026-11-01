import assert from "node:assert/strict";
import { test } from "node:test";
import { getStopPlaceSubtitle } from "../src/lib/stop-naming.ts";

test("a home stop says its town, a district stop the town and district", () => {
  const home = { id: "hauptbahnhof", name: "Hauptbahnhof", municipality: "Karlsruhe" };
  assert.equal(getStopPlaceSubtitle(home), "Karlsruhe");
  assert.equal(
    getStopPlaceSubtitle({ ...home, id: "durlach-bahnhof", name: "Bahnhof", placeName: "Durlach" }),
    "Karlsruhe-Durlach",
  );
});

test("a searched stop outside home says the town search named", () => {
  assert.equal(
    getStopPlaceSubtitle({
      id: "pforzheim-hauptbahnhof--x",
      name: "Hauptbahnhof",
      placeName: "Pforzheim",
    }),
    "Pforzheim",
  );
  assert.equal(
    getStopPlaceSubtitle({ id: "stuttgart-hauptbahnhof--x", name: "Stuttgart Hauptbahnhof" }),
    undefined,
  );
});

test("the town is not repeated where the name already says it", () => {
  assert.equal(
    getStopPlaceSubtitle({
      id: "karlsruhe-westbahnhof",
      name: "Karlsruhe Westbahnhof",
      municipality: "Karlsruhe",
    }),
    undefined,
  );
  assert.equal(
    getStopPlaceSubtitle({
      id: "ettlingen-stadt--x",
      name: "Ettlingen Stadt",
      placeName: "Ettlingen",
    }),
    undefined,
  );
});

test("the former name follows the town", () => {
  assert.equal(
    getStopPlaceSubtitle({
      id: "ettlinger-tor",
      name: "Ettlinger Tor/Staatstheater",
      municipality: "Karlsruhe",
      formerName: "Mendelssohnplatz",
    }),
    "Karlsruhe · Mendelssohnplatz",
  );
});
