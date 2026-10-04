import assert from "node:assert/strict";
import test from "node:test";
import {
  compressRegion,
  countOrderBreaks,
  extendAxis,
  placeAtShares,
  type RegionLayoutEdge,
  solveRegionLayout,
} from "../src/lib/region-layout.ts";

const GRID = 20;

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} ≠ ${expected}`);

// West to east: lameyplatz – entenfang – muehlburger-tor – marktplatz – durlacher-tor – durlach.
const geography = new Map([
  ["lameyplatz", { x: -4, y: -0.5 }],
  ["entenfang", { x: -3, y: 0.2 }],
  ["muehlburger-tor", { x: -1.5, y: 0 }],
  ["marktplatz", { x: 0, y: 0 }],
  ["durlacher-tor", { x: 1.2, y: 0 }],
  ["durlach", { x: 4, y: 1 }],
  ["neureut", { x: -1.4, y: -4 }],
]);

test("extends the axis while a stretch keeps half the lines of the Zentrum's axis at that end", () => {
  const edges: RegionLayoutEdge[] = [
    { from: "muehlburger-tor", to: "marktplatz", lineIds: ["1", "2", "S5"] },
    { from: "marktplatz", to: "durlacher-tor", lineIds: ["1", "2", "S5"] },
    { from: "entenfang", to: "muehlburger-tor", lineIds: ["2", "S5"] },
    { from: "muehlburger-tor", to: "neureut", lineIds: ["1", "3", "4"] },
    { from: "entenfang", to: "lameyplatz", lineIds: ["S5"] },
    { from: "durlacher-tor", to: "durlach", lineIds: ["1", "S5"] },
  ];
  assert.deepEqual(
    extendAxis(["muehlburger-tor", "marktplatz", "durlacher-tor"], edges, geography),
    ["entenfang", "muehlburger-tor", "marktplatz", "durlacher-tor", "durlach"],
  );
});

test("sets places at their share of a folded way, never closer than the gap", () => {
  const way = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
  ];
  assert.deepEqual(placeAtShares(way, [0.25, 0.5, 0.75], 1), [
    { x: 2, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 2 },
  ]);
  // Two places 1 % apart are pushed to the gap; the last keeps the gap to the end.
  assert.deepEqual(placeAtShares(way, [0.5, 0.51, 0.99], 1), [
    { x: 4, y: 0 },
    { x: 4, y: 1 },
    { x: 4, y: 3 },
  ]);
});

test("counts where the branches around a junction leave in another turn than on the ground", () => {
  const ground = new Map([
    ["bruchsal", 290],
    ["bretten", 330],
    ["pforzheim", 20],
    ["hauptbahnhof", 200],
  ]);
  assert.equal(countOrderBreaks(ground, ground), 0);
  assert.equal(
    countOrderBreaks(
      new Map([
        ["bruchsal", 0],
        ["bretten", 45],
        ["pforzheim", 90],
        ["hauptbahnhof", 180],
      ]),
      ground,
    ),
    0,
    "turned as a whole, the order holds",
  );
  assert.equal(
    countOrderBreaks(
      new Map([
        ["bruchsal", 0],
        ["bretten", 315],
        ["pforzheim", 270],
        ["hauptbahnhof", 180],
      ]),
      ground,
    ),
    4,
    "mirrored, every branch has another neighbour",
  );
});

test("a fisheye keeps the core true and shrinks the region ever more beyond it", () => {
  const scale = { kind: "fisheye", coreKm: 2, falloffKm: 4 } as const;
  assert.deepEqual(compressRegion({ x: 1.5, y: 0 }, scale), { x: 1.5, y: 0 });
  const closer = compressRegion({ x: 0, y: 6 }, scale);
  const farther = compressRegion({ x: 0, y: 30 }, scale);
  near(closer.y, 2 + 8 * (1 - 1 / Math.SQRT2));
  assert.equal(closer.x, 0);
  assert.ok(farther.y - closer.y < 4, "24 km further out takes far less than 24 km");
  assert.ok(
    compressRegion({ x: 500, y: 0 }, scale).x < 2 + 2 * 4,
    "everything stays within the rim",
  );
  // No step at the core's edge: just past it, a kilometre is still almost a kilometre.
  const edge = compressRegion({ x: 2.1, y: 0 }, scale);
  assert.ok(edge.x > 2.09);
});

test("zones scale each band of distance by its own factor, joined without a gap", () => {
  const scale = {
    kind: "zones",
    zones: [
      { untilKm: 2, factor: 1 },
      { untilKm: 7, factor: 0.4 },
      { untilKm: Number.POSITIVE_INFINITY, factor: 0.1 },
    ],
  } as const;
  near(compressRegion({ x: 1, y: 0 }, scale).x, 1);
  near(compressRegion({ x: 4, y: 0 }, scale).x, 2 + 2 * 0.4);
  near(compressRegion({ x: 0, y: -17 }, scale).y, -(2 + 5 * 0.4 + 10 * 0.1));
});

test("arms keep the city's zones, and beyond its edge give only a direction", () => {
  const scale = {
    kind: "arms",
    zones: [
      { untilKm: 2, factor: 1 },
      { untilKm: 6, factor: 0.5 },
    ],
  } as const;
  near(compressRegion({ x: 4, y: 0 }, scale).x, 2 + 2 * 0.5);
  const beyond = compressRegion({ x: 0, y: 30 }, scale);
  near(beyond.y, 2 + 4 * 0.5, "beyond the edge, a stop stands on it, in its direction");
});

/** A node `east` and `south` kilometres from Marktplatz. */
const at = (id: string, east: number, south: number) => ({
  id,
  latitude: 49 - south / 110.574,
  longitude: 8.4 + east / (111.32 * Math.cos((49 * Math.PI) / 180)),
});

// A square core plan of four stops, 6 cells a side and 2 km on the ground.
const core = {
  cell: 22,
  stops: [
    { id: "west", x: 0, y: 0 },
    { id: "east", x: 132, y: 0 },
    { id: "south", x: 0, y: 132 },
    { id: "southeast", x: 132, y: 132 },
  ],
};
const coreNodes = [at("west", -1, 0), at("east", 1, 0), at("south", -1, 2), at("southeast", 1, 2)];
const coreEdges: RegionLayoutEdge[] = [
  { from: "west", to: "east", lineIds: ["1", "S5"] },
  { from: "west", to: "south", lineIds: ["2"] },
  { from: "east", to: "southeast", lineIds: ["3"] },
  { from: "south", to: "southeast", lineIds: ["4"] },
];
const fisheye = { kind: "fisheye", coreKm: 2.5, falloffKm: 3 } as const;

const solve = (nodes: typeof coreNodes, edges: RegionLayoutEdge[]) =>
  solveRegionLayout({
    nodes,
    edges,
    core,
    axis: ["west", "east"],
    homeId: "west",
    scale: fisheye,
    grid: GRID,
    gap: 1.5,
  });
const pointIn = (layout: ReturnType<typeof solve>, id: string) => {
  const point = layout.positions.get(id);
  assert.ok(point, id);
  return point;
};

test("keeps the core plan's shape, and fits the region to its scale", () => {
  const layout = solve(coreNodes, coreEdges);
  assert.deepEqual(layout.faults, []);
  const west = pointIn(layout, "west");
  near(pointIn(layout, "east").x - west.x, 6 * GRID);
  near(pointIn(layout, "south").y - west.y, 6 * GRID);
  near(pointIn(layout, "southeast").x - pointIn(layout, "south").x, 6 * GRID);
});

test("sets an arm's places in their direction, at their share of its length, never crowded", () => {
  const layout = solve(
    [...coreNodes, at("a1", 3, 0), at("a2", 4, 0), at("a3", 12, 0), at("a4", 40, 0)],
    [
      ...coreEdges,
      { from: "east", to: "a1", lineIds: ["S5"] },
      { from: "a1", to: "a2", lineIds: ["S5"] },
      { from: "a2", to: "a3", lineIds: ["S5"] },
      { from: "a3", to: "a4", lineIds: ["S5"] },
    ],
  );
  assert.deepEqual(layout.faults, []);
  const arm = ["east", "a1", "a2", "a3", "a4"].map((id) => pointIn(layout, id));
  for (const point of arm) near(point.y, arm[0].y, "the arm runs level, as on the ground");
  const steps = arm.slice(1).map((point, index) => point.x - arm[index].x);
  for (const step of steps) assert.ok(step >= 1.5 * GRID - 1e-6, `${step} keeps the gap`);
  assert.ok(steps[2] > steps[1], "a2 to a3 is longer than a1 to a2, as on the ground");
  assert.ok(steps[3] < (40 - 12) * 3 * GRID, "but the region shrinks with distance");
});

test("takes a link that does not serve the core around it, not through", () => {
  const layout = solve(
    [...coreNodes, at("far", 6, 4)],
    [...coreEdges, { from: "west", to: "far", lineIds: ["S3"] }],
  );
  assert.deepEqual(layout.faults, []);
  const west = pointIn(layout, "west");
  const south = pointIn(layout, "south");
  const east = pointIn(layout, "east");
  const way = [west, ...(layout.bends.get("west far") ?? []), pointIn(layout, "far")];
  for (const point of way.slice(1)) {
    const inside =
      point.x > west.x + 1e-6 &&
      point.x < east.x - 1e-6 &&
      point.y > west.y + 1e-6 &&
      point.y < south.y - 1e-6;
    assert.ok(!inside, `${point.x},${point.y} stays out of the core`);
  }
});

test("beyond the city edge, runs an arm straight in its direction with places a fixed step apart", () => {
  const layout = solveRegionLayout({
    nodes: [...coreNodes, at("a1", 3, 0), at("a2", 4, 0), at("a3", 12, 0), at("a4", 40, 0)],
    edges: [
      ...coreEdges,
      { from: "east", to: "a1", lineIds: ["S5"] },
      { from: "a1", to: "a2", lineIds: ["S5"] },
      { from: "a2", to: "a3", lineIds: ["S5"] },
      { from: "a3", to: "a4", lineIds: ["S5"] },
    ],
    core,
    axis: ["west", "east"],
    homeId: "west",
    scale: { kind: "arms", zones: [{ untilKm: 2.5, factor: 1 }] },
    grid: GRID,
    gap: 1.5,
  });
  assert.deepEqual(layout.faults, []);
  const arm = ["east", "a1", "a2", "a3", "a4"].map((id) => pointIn(layout, id));
  for (const point of arm) near(point.y, arm[0].y, "the arm runs level, as on the ground");
  const steps = arm.slice(2).map((point, index) => point.x - arm[index + 1].x);
  // Positions are rounded to a hundredth of a map unit.
  for (const step of steps) {
    assert.ok(
      Math.abs(step - steps[0]) < 0.05,
      "outside the city, places stand a fixed step apart",
    );
  }
});

test("gives each bend to the edge between the places it falls between, so every leg is octilinear", () => {
  // A link around the core, its first place near one end and its second near the other.
  const nodes = [...coreNodes, at("p1", -1.5, -0.6), at("p2", 5.6, 3.6), at("far", 6, 4)];
  const layout = solve(nodes, [
    ...coreEdges,
    { from: "west", to: "p1", lineIds: ["S3"] },
    { from: "p1", to: "p2", lineIds: ["S3"] },
    { from: "p2", to: "far", lineIds: ["S3"] },
  ]);
  assert.deepEqual(layout.faults, []);
  assert.ok(layout.bends.size > 0, "the link bends");
  for (const [from, to] of [
    ["west", "p1"],
    ["p1", "p2"],
    ["p2", "far"],
  ]) {
    const way = [
      pointIn(layout, from),
      ...(layout.bends.get(`${from} ${to}`) ?? []),
      pointIn(layout, to),
    ];
    for (const [index, point] of way.slice(1).entries()) {
      const [dx, dy] = [Math.abs(point.x - way[index].x), Math.abs(point.y - way[index].y)];
      assert.ok(
        dx < 0.05 || dy < 0.05 || Math.abs(dx - dy) < 0.05,
        `${from}–${to} leg ${index} runs ${dx},${dy}`,
      );
    }
  }
});
