import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent } from "../src/data/transit-types.ts";
import { getMergeDepartureInstants } from "../src/lib/merge-stop-events.ts";
import { createStopEvent } from "./support/fixtures.ts";

const start = Date.parse("2026-10-08T12:00:00Z");
const minute = 60_000;

/** A journey calling at each stop a minute apart, on the platforms given (`stop@platform`). */
const createDatedJourney = (stops: readonly string[], startMinute = 0): StopEvent =>
  createStopEvent({
    calls: stops.map((stop, index) => {
      const [stopPlaceId, bay] = stop.split("@");
      const at = new Date(start + (startMinute + index) * minute).toISOString();
      return {
        stopPlaceId,
        stopName: stopPlaceId,
        bay,
        timetabledArrivalTime: at,
        timetabledDepartureTime: at,
      };
    }),
  });

test("ways joining before a shared track are decided leaving the stop behind", () => {
  // Both Marktplatz tunnels reach Kronenplatz on one track, then go on to Durlacher Tor.
  const instants = getMergeDepartureInstants([
    [
      "kaiserstrasse",
      createDatedJourney(["europaplatz", "marktplatz-k", "kronenplatz@2", "durlacher-tor"]),
    ],
    [
      "pyramide",
      createDatedJourney(["ettlinger-tor", "marktplatz-p", "kronenplatz@2", "durlacher-tor"], 5),
    ],
  ]);
  assert.deepEqual(instants.get("kaiserstrasse"), [start + minute]);
  assert.deepEqual(instants.get("pyramide"), [start + 6 * minute]);
});

test("ways joining after separate tracks are decided leaving the stop itself", () => {
  // From Ettlinger Tor on Gleis 2 and from Werderstraße on Gleis 4, both on to Durlacher Tor.
  const instants = getMergeDepartureInstants([
    ["west", createDatedJourney(["ettlinger-tor", "rueppurrer-tor@2", "durlacher-tor"])],
    ["south", createDatedJourney(["werderstrasse", "rueppurrer-tor@4", "durlacher-tor"])],
  ]);
  assert.deepEqual(instants.get("west"), [start + minute]);
  assert.deepEqual(instants.get("south"), [start + minute]);
});

test("lettered sections of one platform are one track", () => {
  const instants = getMergeDepartureInstants([
    ["a", createDatedJourney(["yorckstrasse", "muehlburger-tor@2a", "europaplatz"])],
    ["b", createDatedJourney(["schillerstrasse", "muehlburger-tor@2b", "europaplatz"])],
  ]);
  assert.deepEqual(instants.get("a"), [start]);
});

test("opposite directions, one line and turnarounds are not merges", () => {
  const instants = getMergeDepartureInstants([
    ["east", createDatedJourney(["europaplatz", "marktplatz", "kronenplatz"])],
    ["west", createDatedJourney(["kronenplatz", "marktplatz", "europaplatz"])],
    ["again", createDatedJourney(["europaplatz", "marktplatz", "kronenplatz"], 10)],
    ["turn", createDatedJourney(["europaplatz", "marktplatz", "marktplatz", "kronenplatz"])],
  ]);
  assert.equal(instants.size, 0);
});
