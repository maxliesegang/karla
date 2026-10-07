import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TripCall } from "../src/data/transit-types.ts";
import { buildZentrumSchematicReading } from "../src/lib/zentrum-schematic.ts";
import {
  type ZentrumSchematicNode,
  getEdgeKey,
  getZentrumSchematicRoutes,
} from "../src/lib/zentrum-schematic-plan.ts";
import { createDeparture } from "./support/fixtures.ts";

test("a platform approach turns square without sharing an unrelated crossing corridor", () => {
  const platform: ZentrumSchematicNode = {
    id: "platform",
    label: "Platform",
    x: 110,
    y: 0,
    platformRun: "upright",
  };
  const south = { id: "south", label: "South", x: 44, y: 110 };
  const west = { id: "west", label: "West", x: 0, y: 44 };
  const east = { id: "east", label: "East", x: 154, y: 44 };
  const routes = getZentrumSchematicRoutes(
    [
      [platform, south],
      [west, east],
    ],
    [platform, south, west, east],
  );
  const approach = routes.get(getEdgeKey(platform.id, south.id))!;
  assert.deepEqual(
    approach.map(({ x, y }) => [x, y]),
    [
      [110, 0],
      [110, 110],
      [44, 110],
    ],
  );
  assert.deepEqual(routes.get(getEdgeKey(west.id, east.id)), [west, east]);
  const blocker = { id: "blocker", label: "Blocker", x: 110, y: 88 };
  const blocked = getZentrumSchematicRoutes([[platform, south]], [platform, south, blocker]);
  assert.deepEqual(
    blocked.get(getEdgeKey(platform.id, south.id))?.map(({ x, y }) => [x, y]),
    [
      [110, 0],
      [110, 44],
      [44, 110],
    ],
  );
});

test("the eastern approach crosses the trunk square and keeps the lower stops on one straight", () => {
  const samples: { lineId: string; tripCalls: TripCall[] }[] = JSON.parse(
    readFileSync(new URL("./support/zentrum-stop-platforms.json", import.meta.url), "utf8"),
  );
  const reading = buildZentrumSchematicReading(
    samples.map((sample, index) => createDeparture({ id: `routing-${index}`, ...sample })),
    1450,
  );
  const wolf = reading.nodesById.get("wolfartsweierer-strasse")!;
  const schloss = reading.nodesById.get("schloss-gottesaue")!;
  assert.equal(wolf.y, schloss.y);
  const approaches = reading.edges.filter(({ from, to }) =>
    [from, to].some((node) => node.stopId === "tullastrasse"),
  );
  assert.ok(approaches.length > 0);
  for (const edge of approaches) assert.equal(edge.from.x, edge.to.x);
  const schlossArms = reading.edges.filter(
    ({ from, to }) => from.id === schloss.id || to.id === schloss.id,
  );
  for (const edge of schlossArms) assert.equal(edge.from.y, edge.to.y);
});

test("approaches to two boarding places share their crossing and the corridor leading to it", () => {
  const west = { id: "west", label: "West", x: 0, y: 132 };
  const main: ZentrumSchematicNode = { id: "hub", label: "Hub", x: 88, y: 0, platformRun: "level" };
  const apart: ZentrumSchematicNode = {
    id: "hub@north",
    stopId: "hub",
    label: "Hub",
    x: 44,
    y: -44,
    platformRun: "upright",
  };
  const routes = getZentrumSchematicRoutes(
    [
      [west, main],
      [west, apart],
    ],
    [west, main, apart],
  );
  const mainRoute = routes.get(getEdgeKey(west.id, main.id))!;
  const apartRoute = routes.get(getEdgeKey(west.id, apart.id))!;
  assert.deepEqual(mainRoute.slice(0, -1), apartRoute.slice(0, -1));
  assert.deepEqual(
    mainRoute.map(({ x, y }) => [x, y]),
    [
      [0, 132],
      [44, 132],
      [44, 0],
      [88, 0],
    ],
  );
  const reversed = getZentrumSchematicRoutes(
    [
      [apart, west],
      [main, west],
    ],
    [west, main, apart],
  );
  assert.deepEqual(reversed.get(getEdgeKey(west.id, main.id)), [...mainRoute].reverse());
  assert.deepEqual(reversed.get(getEdgeKey(west.id, apart.id)), [...apartRoute].reverse());
});
