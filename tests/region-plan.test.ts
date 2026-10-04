import assert from "node:assert/strict";
import test from "node:test";
import { getDirectTravelTimes } from "../src/lib/direct-travel-times.ts";
import type { GeoLink, GeoNetwork, GeoStop } from "../src/lib/geo-map.ts";
import { deriveRegionPlan, findRegionNodeId } from "../src/lib/region-plan.ts";
import { createDeparture } from "./support/fixtures.ts";

const stop = (id: string, placeName = "Karlsruhe", name = id): GeoStop => ({
  id,
  name,
  placeName,
  latitude: 49,
  longitude: 8.4,
  lineIds: [],
});

/** Lines running the stops in order; links merge across lines. */
const network = (
  stops: readonly GeoStop[],
  lines: Record<string, readonly string[]>,
): GeoNetwork => {
  const links = new Map<string, GeoLink & { lineIds: string[] }>();
  const byId = new Map(stops.map((entry) => [entry.id, { ...entry, lineIds: [] as string[] }]));
  for (const [lineId, path] of Object.entries(lines)) {
    for (const [index, id] of path.entries()) {
      const entry = byId.get(id);
      if (entry && !entry.lineIds.includes(lineId)) entry.lineIds.push(lineId);
      if (index === 0) continue;
      const [fromId, toId] = [path[index - 1], id].sort();
      const key = `${fromId}\u0000${toId}`;
      const link = links.get(key) ?? { id: key, fromId, toId, lineIds: [] };
      if (!link.lineIds.includes(lineId)) link.lineIds.push(lineId);
      links.set(key, link);
    }
  }
  return { stops: byId, links: [...links.values()] };
};

// Two lines share the trunk Europaplatz – Marktplatz – Kronenplatz; line 2 turns south at
// Marktplatz past Kongresszentrum and Werderstraße. S5 runs on east through Durlach's two stops to
// Grötzingen.
const city = network(
  [
    stop("europaplatz"),
    stop("marktplatz"),
    stop("kronenplatz"),
    stop("kongresszentrum"),
    stop("werderstrasse"),
    stop("wolfartsweier"),
    stop("untermuehl", "Durlach", "Untermühlstraße"),
    stop("durlach-bf", "Durlach", "Durlach Bahnhof"),
    stop("groetzingen", "Grötzingen"),
    stop("groetzingen-ober", "Grötzingen", "Grötzingen Oberausstraße"),
    stop("berghausen", "Berghausen"),
  ],
  {
    S5: [
      "europaplatz",
      "marktplatz",
      "kronenplatz",
      "untermuehl",
      "durlach-bf",
      "groetzingen",
      "groetzingen-ober",
      "berghausen",
    ],
    "2": ["europaplatz", "marktplatz", "kongresszentrum", "werderstrasse", "wolfartsweier"],
  },
);

test("keeps junctions and ends of the home place, and skips the stops trams only pass", () => {
  const plan = deriveRegionPlan(city, "Karlsruhe");

  const ids = plan.nodes.map(({ id }) => id).sort();
  assert.ok(ids.includes("marktplatz"));
  assert.ok(ids.includes("europaplatz"));
  assert.ok(ids.includes("wolfartsweier"));
  assert.ok(!ids.includes("kongresszentrum"));
  assert.ok(!ids.includes("werderstrasse"));
  // Kronenplatz is passed by S5 alone.
  assert.ok(!ids.includes("kronenplatz"));
});

test("draws each other place once per branch, named by the place", () => {
  const plan = deriveRegionPlan(city, "Karlsruhe");

  const labels = plan.nodes.map(({ label }) => label);
  assert.equal(labels.filter((label) => label === "Durlach").length, 1);
  assert.equal(labels.filter((label) => label === "Grötzingen").length, 1);
  assert.ok(labels.includes("Berghausen"));
  assert.equal(findRegionNodeId(plan, "untermuehl"), findRegionNodeId(plan, "durlach-bf"));
});

test("links nodes in the order the runs pass them, with the lines between", () => {
  const plan = deriveRegionPlan(city, "Karlsruhe");
  const durlach = findRegionNodeId(plan, "durlach-bf") ?? "";
  const groetzingen = findRegionNodeId(plan, "groetzingen") ?? "";

  const edges = plan.edges.map(
    ({ fromId, toId, lineIds }) => [[fromId, toId].sort().join(" "), lineIds.join(",")] as const,
  );
  assert.deepEqual(new Map(edges).get([durlach, "marktplatz"].sort().join(" ")), "S5");
  assert.deepEqual(new Map(edges).get([durlach, groetzingen].sort().join(" ")), "S5");
  assert.deepEqual(new Map(edges).get(["marktplatz", "wolfartsweier"].sort().join(" ")), "2");
});

test("a junction inside another place stands for that place", () => {
  // Line 1 leaves S5 at Durlach Bahnhof for Turmberg.
  const branched = network(
    [
      stop("marktplatz"),
      stop("untermuehl", "Durlach", "Untermühlstraße"),
      stop("durlach-bf", "Durlach", "Durlach Bahnhof"),
      stop("turmberg", "Durlach", "Turmberg"),
      stop("groetzingen", "Grötzingen"),
    ],
    {
      S5: ["marktplatz", "untermuehl", "durlach-bf", "groetzingen"],
      "1": ["marktplatz", "untermuehl", "durlach-bf", "turmberg"],
    },
  );

  const plan = deriveRegionPlan(branched, "Karlsruhe");

  assert.equal(findRegionNodeId(plan, "untermuehl"), "durlach-bf");
  // Durlach has two nodes, so each is named by its stop, with the place where the name lacks it.
  assert.deepEqual(
    plan.nodes
      .filter(({ placeName }) => placeName === "Durlach")
      .map(({ label }) => label)
      .sort(),
    ["Durlach Bahnhof", "Durlach Turmberg"],
  );
});

test("rides past the stops the plan leaves out, to the next node", () => {
  const plan = deriveRegionPlan(city, "Karlsruhe");
  const at = (minute: number) => `2026-10-04T12:0${minute}:00+02:00`;
  const run = createDeparture({
    lineId: "2",
    tripCalls: ["marktplatz", "kongresszentrum", "werderstrasse", "wolfartsweier"].map(
      (localStopId, minute) => ({
        stopName: localStopId,
        localStopId,
        scheduledArrivalTime: at(minute + 1),
        scheduledDepartureTime: at(minute + 1),
        delayMinutes: 0,
      }),
    ),
  });

  const times = getDirectTravelTimes(
    [run],
    "marktplatz",
    Date.parse(at(0)),
    "arrival",
    (call) => (call.localStopId ? findRegionNodeId(plan, call.localStopId) : undefined),
    true,
  );

  assert.deepEqual(times.get("wolfartsweier")?.stopIds, ["marktplatz", "wolfartsweier"]);
});

const placed = (entry: GeoStop, latitude: number, longitude: number): GeoStop => ({
  ...entry,
  latitude,
  longitude,
});

test("draws one station's stops as one node, so a turning loop folds into its stop", () => {
  // Line 5 turns in a loop past two stops named Tullastraße beside Tullastraße/Alter Schlachthof.
  const looped = network(
    [
      placed(stop("marktplatz"), 49.0094, 8.4037),
      placed(stop("schlachthof", "Karlsruhe", "Tullastraße/Alter Schlachthof"), 49.0064, 8.4322),
      placed(stop("tulla-22", "Karlsruhe", "Tullastraße"), 49.0078, 8.4331),
      placed(stop("tulla-e43", "Karlsruhe", "Tullastraße"), 49.007, 8.4343),
      placed(stop("durlach-bf", "Durlach", "Durlach Bahnhof"), 48.999, 8.4627),
    ],
    {
      "5": ["marktplatz", "schlachthof", "tulla-22", "tulla-e43", "schlachthof"],
      S5: ["marktplatz", "schlachthof", "durlach-bf"],
    },
  );

  const plan = deriveRegionPlan(looped, "Karlsruhe");

  assert.equal(findRegionNodeId(plan, "tulla-22"), "schlachthof");
  assert.equal(findRegionNodeId(plan, "tulla-e43"), "schlachthof");
  assert.ok(plan.edges.every(({ fromId, toId }) => fromId !== toId));
  assert.deepEqual(plan.nodes.map(({ id }) => id).sort(), [
    "durlach-bf",
    "marktplatz",
    "schlachthof",
  ]);
});

test("keeps stops of one name apart when they stand far from each other", () => {
  const apart = network(
    [
      placed(stop("marktplatz"), 49.0094, 8.4037),
      placed(stop("hauptstrasse-a", "Karlsruhe", "Hauptstraße"), 49.03, 8.4),
      placed(stop("hauptstrasse-b", "Karlsruhe", "Hauptstraße"), 48.98, 8.4),
    ],
    { "1": ["hauptstrasse-a", "marktplatz", "hauptstrasse-b"] },
  );

  const plan = deriveRegionPlan(apart, "Karlsruhe");

  assert.notEqual(
    findRegionNodeId(plan, "hauptstrasse-a"),
    findRegionNodeId(plan, "hauptstrasse-b"),
  );
});

test("names two branches' nodes of one place by their stops, so no two nodes share a name", () => {
  // S2 and S7 each pass a place called Forchheim, on branches that never meet there.
  const twice = network(
    [
      stop("albtalbahnhof", "Karlsruhe", "Albtalbahnhof"),
      stop("europaplatz"),
      stop("hauptstrasse", "Forchheim", "Hauptstraße"),
      stop("moersch", "Mörsch"),
      stop("forchheim-bf", "Forchheim", "Forchheim (b Karlsruhe)"),
      stop("durmersheim", "Durmersheim"),
    ],
    {
      S2: ["europaplatz", "hauptstrasse", "moersch"],
      S7: ["albtalbahnhof", "forchheim-bf", "durmersheim"],
    },
  );

  const plan = deriveRegionPlan(twice, "Karlsruhe");

  assert.deepEqual(
    plan.nodes
      .filter(({ placeName }) => placeName === "Forchheim")
      .map(({ label }) => label)
      .sort(),
    ["Forchheim (b Karlsruhe)", "Forchheim Hauptstraße"],
  );
});

test("an edge two runs of the network both reduce to carries the lines of both", () => {
  // Lines 1 and 2 leave Entenfang by different streets the plan passes, and meet again at Yorckstraße.
  const parallel = network(
    [
      stop("entenfang"),
      stop("hardtstrasse"),
      stop("kaeppelestrasse"),
      stop("yorckstrasse"),
      stop("knielingen", "Knielingen"),
      stop("rheinhafen"),
    ],
    {
      "1": ["rheinhafen", "entenfang", "hardtstrasse", "yorckstrasse", "knielingen"],
      "2": ["entenfang", "kaeppelestrasse", "yorckstrasse"],
    },
  );

  const plan = deriveRegionPlan(parallel, "Karlsruhe");

  const edge = plan.edges.find(
    ({ fromId, toId }) => [fromId, toId].sort().join(" ") === "entenfang yorckstrasse",
  );
  assert.deepEqual([...(edge?.lineIds ?? [])].sort(), ["1", "2"]);
});
