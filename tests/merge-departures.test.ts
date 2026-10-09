import assert from "node:assert/strict";
import test from "node:test";
import type { Departure } from "../src/data/transit-types.ts";
import { getMergeDepartureInstants } from "../src/lib/merge-departures.ts";
import { createDeparture } from "./support/fixtures.ts";

const start = Date.parse("2026-10-08T12:00:00Z");
const minute = 60_000;

/** A run calling at each stop a minute apart, on the platforms given (`stop@platform`). */
const createRun = (stops: readonly string[], startMinute = 0): Departure =>
  createDeparture({
    tripCalls: stops.map((stop, index) => {
      const [localStopId, platformCode] = stop.split("@");
      const at = new Date(start + (startMinute + index) * minute).toISOString();
      return {
        localStopId,
        stopName: localStopId,
        platformCode,
        scheduledArrivalTime: at,
        scheduledDepartureTime: at,
      };
    }),
  });

test("ways joining before a shared track are decided leaving the stop behind", () => {
  // Both Marktplatz tunnels reach Kronenplatz on one track, then go on to Durlacher Tor.
  const instants = getMergeDepartureInstants([
    ["kaiserstrasse", createRun(["europaplatz", "marktplatz-k", "kronenplatz@2", "durlacher-tor"])],
    ["pyramide", createRun(["ettlinger-tor", "marktplatz-p", "kronenplatz@2", "durlacher-tor"], 5)],
  ]);
  assert.deepEqual(instants.get("kaiserstrasse"), [start + minute]);
  assert.deepEqual(instants.get("pyramide"), [start + 6 * minute]);
});

test("ways joining after separate tracks are decided leaving the stop itself", () => {
  // From Ettlinger Tor on Gleis 2 and from Werderstraße on Gleis 4, both on to Durlacher Tor.
  const instants = getMergeDepartureInstants([
    ["west", createRun(["ettlinger-tor", "rueppurrer-tor@2", "durlacher-tor"])],
    ["south", createRun(["werderstrasse", "rueppurrer-tor@4", "durlacher-tor"])],
  ]);
  assert.deepEqual(instants.get("west"), [start + minute]);
  assert.deepEqual(instants.get("south"), [start + minute]);
});

test("lettered sections of one platform are one track", () => {
  const instants = getMergeDepartureInstants([
    ["a", createRun(["yorckstrasse", "muehlburger-tor@2a", "europaplatz"])],
    ["b", createRun(["schillerstrasse", "muehlburger-tor@2b", "europaplatz"])],
  ]);
  assert.deepEqual(instants.get("a"), [start]);
});

test("opposite directions, one line and turnarounds are not merges", () => {
  const instants = getMergeDepartureInstants([
    ["east", createRun(["europaplatz", "marktplatz", "kronenplatz"])],
    ["west", createRun(["kronenplatz", "marktplatz", "europaplatz"])],
    ["again", createRun(["europaplatz", "marktplatz", "kronenplatz"], 10)],
    ["turn", createRun(["europaplatz", "marktplatz", "marktplatz", "kronenplatz"])],
  ]);
  assert.equal(instants.size, 0);
});
