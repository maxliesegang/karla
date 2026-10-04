import assert from "node:assert/strict";
import test from "node:test";
import {
  countOrderBreaks,
  extendAxis,
  getZentrumPins,
  placeEvenly,
  type RegionLayoutEdge,
  solveRegionLayout,
} from "../src/lib/region-layout.ts";

const GRID = 20;

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} ≠ ${expected}`);

test("pins the Zentrum's stops to its own grid, one cell per Zentrum cell", () => {
  const pins = getZentrumPins(
    ["marktplatz", "europaplatz", "durlach"],
    [
      { id: "europaplatz", x: 374, y: 154 },
      { id: "marktplatz", x: 572, y: 154 },
      { id: "hauptbahnhof", x: 462, y: 616 },
    ],
    22,
  );
  assert.deepEqual(
    [...pins],
    [
      ["europaplatz", { x: 17, y: 7 }],
      ["marktplatz", { x: 26, y: 7 }],
    ],
  );
});

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

test("extends the axis along its main bundle while it stays in the home place", () => {
  const edges: RegionLayoutEdge[] = [
    { from: "muehlburger-tor", to: "marktplatz", lineIds: ["1", "2", "S5"] },
    { from: "marktplatz", to: "durlacher-tor", lineIds: ["1", "2", "S5"] },
    { from: "entenfang", to: "muehlburger-tor", lineIds: ["2", "S5"] },
    { from: "muehlburger-tor", to: "neureut", lineIds: ["1", "3", "4"] },
    { from: "entenfang", to: "lameyplatz", lineIds: ["S5"] },
    { from: "durlacher-tor", to: "durlach", lineIds: ["1", "S5"] },
  ];
  assert.deepEqual(
    extendAxis(
      ["muehlburger-tor", "marktplatz", "durlacher-tor"],
      edges,
      geography,
      (id) => id !== "durlach",
    ),
    ["lameyplatz", "entenfang", "muehlburger-tor", "marktplatz", "durlacher-tor"],
  );
});

test("spaces places evenly along a folded way, a level stretch taking twice the room for names", () => {
  const points = placeEvenly(
    [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
    ],
    3,
  );
  assert.deepEqual(points, [
    { x: 3, y: 0 },
    { x: 4, y: 1 },
    { x: 4, y: 2.5 },
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

/** A node `east` and `south` kilometres from Marktplatz. */
const at = (id: string, east: number, south: number) => ({
  id,
  latitude: 49 - south / 110.574,
  longitude: 8.4 + east / (111.32 * Math.cos((49 * Math.PI) / 180)),
});

const distance = (left: { x: number; y: number }, right: { x: number; y: number }) =>
  Math.hypot(left.x - right.x, left.y - right.y);

// A pinned core of two stops; S5 runs east through four places that stand ever farther apart, and
// S7 runs south through two.
const branchNodes = [
  at("west", -1, 0),
  at("east", 1, 0),
  at("a1", 3, 0.3),
  at("a2", 8, -0.4),
  at("a3", 20, 0.5),
  at("a4", 45, 0),
  at("b1", 1, 5),
  at("b2", 1.5, 30),
];
const branchEdges: RegionLayoutEdge[] = [
  { from: "west", to: "east", lineIds: ["S5", "S7"] },
  { from: "east", to: "a1", lineIds: ["S5"] },
  { from: "a1", to: "a2", lineIds: ["S5"] },
  { from: "a2", to: "a3", lineIds: ["S5"] },
  { from: "a3", to: "a4", lineIds: ["S5"] },
  { from: "east", to: "b1", lineIds: ["S7"] },
  { from: "b1", to: "b2", lineIds: ["S7"] },
];
const pins = new Map([
  ["west", { x: 0, y: 0 }],
  ["east", { x: 6, y: 0 }],
]);

test("keeps the pins, and draws a branch straight with its places evenly spaced, whatever the kilometres", () => {
  const layout = solveRegionLayout({
    nodes: branchNodes,
    edges: branchEdges,
    pins,
    axis: ["west", "east"],
    homeId: "west",
    grid: GRID,
    spacing: 2,
    frame: { x: 40, y: 40 },
    seed: 3,
    steps: 40_000,
  });
  assert.deepEqual(layout.faults, []);
  const point = (id: string) => {
    const found = layout.positions.get(id);
    assert.ok(found, id);
    return found;
  };
  near(point("east").x - point("west").x, 6 * GRID);
  near(point("east").y, point("west").y);

  const branch = ["east", "a1", "a2", "a3", "a4"].map(point);
  for (const node of branch) near(node.y, branch[0].y, "the eastward branch runs level");
  for (let index = 1; index < branch.length; index += 1) {
    near(distance(branch[index - 1], branch[index]), 4 * GRID, "two spacings apart, on the level");
  }
  assert.equal(layout.bends.size, 0);
});

test("folds a long branch to stay inside the frame, keeping its places evenly spaced along it", () => {
  const nodes = [
    at("west", -1, 0),
    at("east", 1, 0),
    ...Array.from({ length: 10 }, (_, index) => at(`p${index}`, 3 + index * 3, index * 0.8)),
  ];
  const edges: RegionLayoutEdge[] = [
    { from: "west", to: "east", lineIds: ["S5"] },
    ...Array.from({ length: 10 }, (_, index) => ({
      from: index === 0 ? "east" : `p${index - 1}`,
      to: `p${index}`,
      lineIds: ["S5"],
    })),
  ];
  const layout = solveRegionLayout({
    nodes,
    edges,
    pins,
    axis: ["west", "east"],
    homeId: "west",
    grid: GRID,
    spacing: 2,
    frame: { x: 8, y: 18 },
    seed: 5,
    steps: 60_000,
  });
  assert.deepEqual(layout.faults, []);
  const home = layout.positions.get("west");
  assert.ok(home);
  // The frame reaches 8 cells beyond the pins, which stand 6 cells apart.
  for (const [id, point] of layout.positions) {
    assert.ok(point.x - home.x <= 14 * GRID + 1e-6, `${id} inside the frame`);
    assert.ok(Math.abs(point.y - home.y) <= 18 * GRID + 1e-6, `${id} inside the frame`);
  }
  const branch = ["east", ...Array.from({ length: 10 }, (_, index) => `p${index}`)].map((id) => {
    const point = layout.positions.get(id);
    assert.ok(point, id);
    return point;
  });
  const headings = branch
    .slice(1)
    .map((point, index) =>
      Math.round(
        (Math.atan2(point.y - branch[index].y, point.x - branch[index].x) * 180) / Math.PI,
      ),
    );
  const turns = headings.filter((heading, index) => index > 0 && heading !== headings[index - 1]);
  assert.ok(turns.length >= 1 && turns.length <= 2, `one fold, not ${turns.length} turns`);
  const isEven = branch.slice(1).map((point, index) => {
    const level = Math.abs(point.y - branch[index].y) < 1e-6;
    return Math.abs(distance(branch[index], point) - (level ? 4 : 2) * GRID) < 1e-6;
  });
  assert.ok(
    isEven.filter(Boolean).length >= isEven.length - 1,
    "evenly spaced but for the step across the fold",
  );
});
