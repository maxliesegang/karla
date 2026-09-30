import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, DepartureBoard, TransitNetwork } from "../src/data/transit-types.ts";
import { parseRoute } from "../src/routing.ts";
import { findSelectedLine } from "../src/selected-line.ts";

const TRIP = "de:kvv:00S02_:.kvv-21-12-E.5.T0.946.s26";
const network = { lines: [] } as unknown as TransitNetwork;

const row = (lineId: string, transportMode: Departure["transportMode"]) =>
  ({ id: `row-${lineId}`, lineId, transportMode }) as Departure;
const liveBoard = (departures: readonly Departure[]) =>
  ({ dataStatus: "live", departures }) as unknown as DepartureBoard;

test("a trip opened from a stop board keeps its line once it has left that stop", () => {
  // The rider's board no longer lists the trip: it departed. It is still running along the line,
  // and the line is what keeps the readings that find it there going.
  const route = parseRoute(`#/stop/marktplatz/trip/${TRIP}`);
  const departures = [row("S2", "lightRail"), row("2", "tram")];

  const line = findSelectedLine(
    route,
    network,
    departures,
    liveBoard(departures),
    undefined,
    undefined,
  );

  assert.equal(line?.id, "S2");
  assert.equal(line?.transportMode, "lightRail");
});

test("the line a departed trip names holds even when no other run of it calls here", () => {
  const route = parseRoute(`#/stop/marktplatz/trip/${TRIP}`);

  const line = findSelectedLine(route, network, [], liveBoard([]), undefined, undefined);

  assert.equal(line?.id, "S2");
});

test("without a trip the bare stop names no line", () => {
  const route = parseRoute("#/stop/marktplatz");

  assert.equal(
    findSelectedLine(route, network, [], liveBoard([]), undefined, undefined),
    undefined,
  );
});
