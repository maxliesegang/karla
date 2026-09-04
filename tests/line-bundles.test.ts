import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { updateStopCorridorPatterns } from "../src/lib/stop-corridor-patterns.ts";
import {
  chooseLineBundleChain,
  findLineBundleOffers,
  formatLineSelection,
  getLineBundleControls,
  getLineBundleTermini,
  getLineBundleTerminatingLabel,
  getLineBundleTrunk,
  isSelectedLine,
  parseLineSelection,
} from "../src/lib/line-bundles.ts";

function departure(
  overrides: Partial<Departure> & Pick<Departure, "id" | "destination">,
): Departure {
  return {
    tripId: overrides.id,
    lineId: "S1",
    transportMode: "lightRail",
    minutesUntilDeparture: 4,
    platformCode: "1",
    boardingLocalStopId: "hochstetten",
    status: "realtime",
    scheduledDepartureTime: "2026-08-24T12:04:00+02:00",
    ...overrides,
  };
}

const calls = (...stopNames: string[]): TripCall[] =>
  stopNames.map((stopName, index) => ({
    stopName,
    localStopId: stopName.toLowerCase(),
    isCurrentStop: index === 0,
  }));

/** Both lines read out of Hochstetten: together as far as Busenbach, and apart past it. */
const TRUNK = ["hochstetten", "linkenheim", "eggenstein", "neureut", "busenbach"];
const s1 = departure({
  id: "s1-trip",
  lineId: "S1",
  destination: "Bad Herrenalb",
  tripCalls: calls(...TRUNK, "etzenrot", "bad herrenalb"),
});
const s11 = departure({
  id: "s11-trip",
  lineId: "S11",
  destination: "Ittersbach",
  tripCalls: calls(...TRUNK, "langensteinbach", "ittersbach"),
});

const patternsFor = (departures: readonly Departure[], stopId = "hochstetten") =>
  updateStopCorridorPatterns(null, stopId, departures);

test("offers a sibling line observed running the same corridor out of this stop", () => {
  const offers = findLineBundleOffers({
    lineId: "S1",
    departures: [s1, s11],
    patterns: patternsFor([s1, s11]),
  });

  assert.deepEqual(
    offers.map(({ lineId, sharedRoutes }) => [
      lineId,
      sharedRoutes.map((route) => route[route.length - 1].stopName),
    ]),
    [["S11", ["busenbach"]]],
  );
});

/**
 * A stop in the middle of a corridor is served both ways, and the lines share a stretch out of each
 * of its ends. Ettlingen Neuwiesenreben is the case in the network: S1 and S11 run together for
 * thirty-nine calls north to Hochstetten and for six south to Busenbach. Kept as the longest
 * stretch alone the offer describes the northbound corridor, and the southbound trip — the one
 * heading for the stop the lines actually part at — can never be read with its sibling at all.
 */
test("keeps the stretch out of each end of a stop, not the longer of the two", () => {
  const between = (id: string, lineId: string, ...stopNames: string[]): Departure =>
    departure({
      id,
      lineId,
      boardingLocalStopId: "neureut",
      destination: stopNames[stopNames.length - 1],
      tripCalls: calls("neureut", ...stopNames),
    });
  const northbound = ["eggenstein", "linkenheim", "hochstetten", "grenzstraße", "altenheim"];
  const southbound = ["ettlingen", "albgaubad", "busenbach"];
  const departures = [
    between("s1-north", "S1", ...northbound),
    between("s11-north", "S11", ...northbound),
    between("s1-south", "S1", ...southbound, "etzenrot"),
    between("s11-south", "S11", ...southbound, "langensteinbach"),
  ];

  const offers = findLineBundleOffers({
    lineId: "S1",
    departures,
    patterns: patternsFor(departures, "neureut"),
  });

  assert.deepEqual(
    offers.map(({ lineId, sharedRoutes }) => [
      lineId,
      sharedRoutes.map((route) => route[route.length - 1].stopName),
    ]),
    [["S11", ["altenheim", "busenbach"]]],
  );
});

test("does not offer a line that only leaves the stop the same way", () => {
  // One shared link and then apart: trips that leave together are not trips that stay together.
  const s2 = departure({
    id: "s2-trip",
    lineId: "S2",
    destination: "Spöck",
    tripCalls: calls("hochstetten", "linkenheim", "blankenloch", "spöck"),
  });

  assert.deepEqual(
    findLineBundleOffers({
      lineId: "S1",
      departures: [s1, s2],
      patterns: patternsFor([s1, s2]),
    }),
    [],
  );
});

test("does not offer a line of another mode over the same corridor", () => {
  const bus = departure({
    id: "bus-trip",
    lineId: "123",
    transportMode: "bus",
    destination: "Busenbach",
    tripCalls: calls(...TRUNK),
  });

  assert.deepEqual(
    findLineBundleOffers({
      lineId: "S1",
      departures: [s1, bus],
      patterns: patternsFor([s1, bus]),
    }),
    [],
  );
});

test("offers nothing until a whole route has been observed, not only an outgoing link", () => {
  // Rows off a plain board: no sequences, so nothing is known about where either line runs.
  const plain = [
    { ...s1, tripCalls: undefined },
    { ...s11, tripCalls: undefined },
  ];

  assert.deepEqual(
    findLineBundleOffers({ lineId: "S1", departures: plain, patterns: patternsFor(plain) }),
    [],
  );
});

test("draws the bundle over the shared stretch and names where the lines part", () => {
  const trunk = getLineBundleTrunk(
    [
      { lineId: "S1", calls: s1.tripCalls ?? [], destination: "Bad Herrenalb" },
      { lineId: "S11", calls: s11.tripCalls ?? [], destination: "Ittersbach" },
    ],
    ["hochstetten"],
  );

  assert.deepEqual(
    trunk?.calls.map(({ stopName }) => stopName),
    TRUNK,
  );
  assert.deepEqual(
    trunk?.branches.map(({ lineId, direction, destination, continues }) => ({
      lineId,
      direction,
      destination,
      continues,
    })),
    [
      { lineId: "S1", direction: "ahead", destination: "Bad Herrenalb", continues: true },
      { lineId: "S11", direction: "ahead", destination: "Ittersbach", continues: true },
    ],
  );
  // Each leg is drawn from the call the lines part at, so a vehicle on its first link has both ends.
  assert.deepEqual(
    trunk?.branches.map(({ calls: branchCalls }) => branchCalls.map(({ stopName }) => stopName)),
    [
      ["busenbach", "etzenrot", "bad herrenalb"],
      ["busenbach", "langensteinbach", "ittersbach"],
    ],
  );
  // Every line has a leg, so there is nothing left for the words to say.
  assert.equal(
    getLineBundleTerminatingLabel(trunk?.branches ?? [], "ahead", "Busenbach"),
    undefined,
  );
});

test("keeps the different branch termini for the bundled heading", () => {
  const branches = getLineBundleTrunk(
    [
      { lineId: "S1", calls: s1.tripCalls ?? [], destination: "Bad Herrenalb" },
      { lineId: "S11", calls: s11.tripCalls ?? [], destination: "Ittersbach" },
    ],
    ["hochstetten"],
  )?.branches;

  assert.deepEqual(getLineBundleTermini(branches ?? [], "ahead", "Busenbach"), [
    "Bad Herrenalb",
    "Ittersbach",
  ]);
  assert.deepEqual(getLineBundleTermini(branches ?? [], "behind", "Hochstetten"), ["Hochstetten"]);
});

test("states one terminus once when bundled lines share it", () => {
  assert.deepEqual(
    getLineBundleTermini(
      [
        {
          lineId: "S1",
          direction: "ahead",
          destination: "Hochstetten",
          continues: true,
          calls: [],
        },
        {
          lineId: "S11",
          direction: "ahead",
          destination: "Hochstetten",
          continues: true,
          calls: [],
        },
      ],
      "ahead",
      "Neureut",
    ),
    ["Hochstetten"],
  );
});

test("states the short working of the pair rather than leaving it blank", () => {
  const shortWorking = departure({
    id: "s11-short",
    lineId: "S11",
    destination: "Busenbach",
    tripCalls: calls(...TRUNK),
  });
  const trunk = getLineBundleTrunk(
    [
      { lineId: "S1", calls: s1.tripCalls ?? [], destination: "Bad Herrenalb" },
      { lineId: "S11", calls: shortWorking.tripCalls ?? [], destination: "Busenbach" },
    ],
    ["hochstetten"],
  );

  assert.equal(
    getLineBundleTerminatingLabel(trunk?.branches ?? [], "ahead", "Busenbach"),
    "S11 endet in Busenbach",
  );
  // The short working has no leg to draw; the line that runs on still has one.
  assert.deepEqual(
    trunk?.branches.map(({ lineId, calls: branchCalls }) => [lineId, branchCalls.length]),
    [
      ["S1", 3],
      ["S11", 0],
    ],
  );
});

test("measures the shared stretch outwards from the rider's own stop", () => {
  // Read from the middle: the two lines part ahead of this stop and behind it alike.
  const northern = departure({
    id: "north",
    lineId: "S1",
    destination: "Bad Herrenalb",
    boardingLocalStopId: "neureut",
    tripCalls: calls("hochstetten", "eggenstein", "neureut", "busenbach", "bad herrenalb"),
  });
  const southern = departure({
    id: "south",
    lineId: "S11",
    destination: "Ittersbach",
    boardingLocalStopId: "neureut",
    tripCalls: calls("spöck", "blankenloch", "neureut", "busenbach", "ittersbach"),
  });

  const trunk = getLineBundleTrunk(
    [
      { lineId: "S1", calls: northern.tripCalls ?? [], destination: "Bad Herrenalb" },
      { lineId: "S11", calls: southern.tripCalls ?? [], destination: "Ittersbach" },
    ],
    ["neureut"],
  );

  assert.deepEqual(
    trunk?.calls.map(({ stopName }) => stopName),
    ["neureut", "busenbach"],
  );
  assert.deepEqual(
    trunk?.branches.map(({ lineId, direction, destination }) => [lineId, direction, destination]),
    [
      ["S1", "ahead", "Bad Herrenalb"],
      ["S11", "ahead", "Ittersbach"],
      ["S1", "behind", "hochstetten"],
      ["S11", "behind", "spöck"],
    ],
  );
  // A leg behind the rider ends at the junction, in travel order, for the same reason.
  assert.deepEqual(
    trunk?.branches
      .filter(({ direction }) => direction === "behind")
      .map(({ calls: branchCalls }) => branchCalls.map(({ stopName }) => stopName)),
    [
      ["hochstetten", "eggenstein", "neureut"],
      ["spöck", "blankenloch", "neureut"],
    ],
  );
});

test("does not fork where one line states two consecutive platforms of the same stop", () => {
  const platformCall = (stopName: string, localStopId: string): TripCall => ({
    stopName,
    localStopId,
  });
  const sharedNorth = calls("hochstetten", "europaplatz");
  const sharedSouth = calls("ostendorfplatz", "busenbach");
  const trunk = getLineBundleTrunk(
    [
      {
        lineId: "S1",
        calls: [
          ...sharedNorth,
          platformCall("Marktplatz (Kaiserstraße U)", "marktplatz"),
          platformCall("Marktplatz (Pyramide U)", "marktplatz"),
          ...sharedSouth,
          ...calls("bad herrenalb"),
        ],
        destination: "Bad Herrenalb",
      },
      {
        lineId: "S11",
        calls: [
          ...sharedNorth,
          platformCall("Marktplatz (Pyramide U)", "marktplatz"),
          ...sharedSouth,
          ...calls("ittersbach"),
        ],
        destination: "Ittersbach",
      },
    ],
    ["ostendorfplatz"],
  );

  assert.deepEqual(
    trunk?.calls.map(({ localStopId }) => localStopId),
    ["hochstetten", "europaplatz", "marktplatz", "marktplatz", "ostendorfplatz", "busenbach"],
  );
  assert.equal(
    trunk?.branches.some(({ direction }) => direction === "behind"),
    false,
  );
});

test("keeps the lines apart where a chain does not call at the rider's stop", () => {
  assert.equal(
    getLineBundleTrunk(
      [
        { lineId: "S1", calls: s1.tripCalls ?? [], destination: "Bad Herrenalb" },
        { lineId: "S11", calls: calls("ettlingen", "rastatt"), destination: "Rastatt" },
      ],
      ["hochstetten"],
    ),
    undefined,
  );
});

test("draws the sibling trip that runs with this one furthest, not the opposite direction", () => {
  const s11Back = departure({
    id: "s11-back",
    lineId: "S11",
    destination: "Ittersbach",
    tripCalls: calls("neureut", "hochstetten"),
  });
  const chosen = chooseLineBundleChain(
    { lineId: "S1", calls: s1.tripCalls ?? [], destination: "Bad Herrenalb" },
    [
      { lineId: "S11", calls: s11Back.tripCalls ?? [], destination: "Ittersbach" },
      { lineId: "S11", calls: s11.tripCalls ?? [], destination: "Ittersbach" },
    ],
    ["hochstetten"],
  );

  assert.equal(chosen?.calls.length, s11.tripCalls?.length);
});

test("uses the sibling's furthest observed end when candidates share the same trunk", () => {
  const short = {
    lineId: "S11",
    calls: calls(...TRUNK, "langensteinbach"),
    destination: "Langensteinbach",
  };
  const full = {
    lineId: "S11",
    calls: calls(...TRUNK, "langensteinbach", "ittersbach"),
    destination: "Ittersbach",
  };

  const chosen = chooseLineBundleChain(
    { lineId: "S1", calls: s1.tripCalls ?? [], destination: "Bad Herrenalb" },
    [short, full],
    ["hochstetten"],
  );

  assert.equal(chosen, full);
});

test("reads and writes the bundle address, and drops a repeated line from it", () => {
  assert.deepEqual(parseLineSelection("S1+S11"), { lineId: "S1", bundledLineIds: ["S11"] });
  assert.deepEqual(parseLineSelection("S1+S1"), { lineId: "S1", bundledLineIds: [] });
  assert.deepEqual(parseLineSelection("2"), { lineId: "2", bundledLineIds: [] });
  assert.equal(formatLineSelection({ lineId: "S1", bundledLineIds: ["S11"] }), "S1+S11");
  assert.equal(formatLineSelection({ lineId: "S1", bundledLineIds: [] }), "S1");
});

test("reads a departure of any bundled line as the selection", () => {
  const selection = { lineId: "S1", bundledLineIds: ["S11"] };
  assert.equal(isSelectedLine(selection, "S11"), true);
  assert.equal(isSelectedLine(selection, "S2"), false);
  assert.equal(isSelectedLine({ lineId: "S1", bundledLineIds: [] }, "S11"), false);
});

test("offers every sibling once: the ones being read as a way out, the rest as a way in", () => {
  const controls = getLineBundleControls(
    ["S11"],
    [
      { lineId: "S11", sharedCalls: [], sharedUntilStopName: "Busenbach" },
      { lineId: "S12", sharedCalls: [], sharedUntilStopName: "Ettlingen Stadt" },
    ],
  );

  assert.deepEqual(controls, [
    {
      lineId: "S11",
      isActive: true,
      next: [],
      label: "S11 nicht mehr bündeln",
    },
    {
      lineId: "S12",
      isActive: false,
      next: ["S11", "S12"],
      label: "Mit S12 bündeln, gleicher Weg bis Ettlingen Stadt",
      sharedUntilStopName: "Ettlingen Stadt",
    },
  ]);
});

test("offers nothing further once the reading is as wide as a reading gets", () => {
  // Two siblings is the whole of `MAX_BUNDLED_LINES`, and a control leading past it would navigate
  // to an address that quietly drops a line on the way back in.
  const controls = getLineBundleControls(
    ["S11", "S12"],
    [{ lineId: "S2", sharedCalls: [], sharedUntilStopName: "Ettlingen Stadt" }],
  );

  assert.deepEqual(
    controls.map(({ lineId, isActive }) => [lineId, isActive]),
    [
      ["S11", true],
      ["S12", true],
    ],
  );
});

test("keeps the way out of an active bundle when no corridor offer remains", () => {
  assert.deepEqual(getLineBundleControls(["S11"], []), [
    {
      lineId: "S11",
      isActive: true,
      next: [],
      label: "S11 nicht mehr bündeln",
    },
  ]);
});
