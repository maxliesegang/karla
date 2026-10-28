import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, StopEventBoard, Call } from "../src/data/transit-types.ts";
import { updateStopCorridorPatterns } from "../src/lib/stop-corridor-patterns.ts";
import {
  chooseLineBundleChain,
  findLineBundleOffers,
  formatLineSelection,
  getLineBundleControls,
  getResolvedBundledLineIds,
  getLineBundleTermini,
  getLineBundleTerminatingLabel,
  getLineBundleTrunk,
  isSelectedLine,
  parseLineSelection,
} from "../src/lib/line-bundles.ts";
import { createStopEvent } from "./support/fixtures.ts";

function stopEvent(
  overrides: Partial<StopEvent> & Pick<StopEvent, "id" | "destinationText">,
): StopEvent {
  return createStopEvent({
    journeyRef: overrides.id,
    lineId: "S1",
    ptMode: "lightRail",
    minutesUntilDeparture: 4,
    bay: "1",
    boardingStopPlaceId: "hochstetten",
    status: "realtime",
    timetabledDepartureTime: "2026-08-24T12:04:00+02:00",
    ...overrides,
  });
}

const calls = (...stopNames: string[]): Call[] =>
  stopNames.map((stopName, index) => ({
    stopName,
    stopPlaceId: stopName.toLowerCase(),
    isThisCall: index === 0,
  }));

/** Both lines out of Hochstetten: together to Busenbach, apart after. */
const TRUNK = ["hochstetten", "linkenheim", "eggenstein", "neureut", "busenbach"];
const s1 = stopEvent({
  id: "s1-journey",
  lineId: "S1",
  destinationText: "Bad Herrenalb",
  calls: calls(...TRUNK, "etzenrot", "bad herrenalb"),
});
const s11 = stopEvent({
  id: "s11-journey",
  lineId: "S11",
  destinationText: "Ittersbach",
  calls: calls(...TRUNK, "langensteinbach", "ittersbach"),
});

const patternsFor = (stopEvents: readonly StopEvent[], stopId = "hochstetten") =>
  updateStopCorridorPatterns(null, stopId, stopEvents);

test("offers a sibling line observed running the same corridor out of this stop", () => {
  const offers = findLineBundleOffers({
    lineId: "S1",
    stopEvents: [s1, s11],
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
 * Keeps a stretch out of each end of the stop: at Ettlingen Neuwiesenreben S1 and S11 share 39
 * calls north and six south, and the southbound journey must still get its offer.
 */
test("keeps the stretch out of each end of a stop, not the longer of the two", () => {
  const between = (id: string, lineId: string, ...stopNames: string[]): StopEvent =>
    stopEvent({
      id,
      lineId,
      boardingStopPlaceId: "neureut",
      destinationText: stopNames[stopNames.length - 1],
      calls: calls("neureut", ...stopNames),
    });
  const northbound = ["eggenstein", "linkenheim", "hochstetten", "grenzstraße", "altenheim"];
  const southbound = ["ettlingen", "albgaubad", "busenbach"];
  const stopEvents = [
    between("s1-north", "S1", ...northbound),
    between("s11-north", "S11", ...northbound),
    between("s1-south", "S1", ...southbound, "etzenrot"),
    between("s11-south", "S11", ...southbound, "langensteinbach"),
  ];

  const offers = findLineBundleOffers({
    lineId: "S1",
    stopEvents,
    patterns: patternsFor(stopEvents, "neureut"),
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
  // One shared link, then apart.
  const s2 = stopEvent({
    id: "s2-journey",
    lineId: "S2",
    destinationText: "Spöck",
    calls: calls("hochstetten", "linkenheim", "blankenloch", "spöck"),
  });

  assert.deepEqual(
    findLineBundleOffers({
      lineId: "S1",
      stopEvents: [s1, s2],
      patterns: patternsFor([s1, s2]),
    }),
    [],
  );
});

test("does not offer a line of another mode over the same corridor", () => {
  const bus = stopEvent({
    id: "bus-journey",
    lineId: "123",
    ptMode: "bus",
    destinationText: "Busenbach",
    calls: calls(...TRUNK),
  });

  assert.deepEqual(
    findLineBundleOffers({
      lineId: "S1",
      stopEvents: [s1, bus],
      patterns: patternsFor([s1, bus]),
    }),
    [],
  );
});

test("offers nothing until a whole route has been observed, not only an outgoing link", () => {
  // Plain board rows: nothing known about routes.
  const plain = [
    { ...s1, calls: undefined },
    { ...s11, calls: undefined },
  ];

  assert.deepEqual(
    findLineBundleOffers({ lineId: "S1", stopEvents: plain, patterns: patternsFor(plain) }),
    [],
  );
});

test("draws the bundle over the shared stretch and names where the lines part", () => {
  const trunk = getLineBundleTrunk(
    [
      { lineId: "S1", calls: s1.calls ?? [], destination: "Bad Herrenalb" },
      { lineId: "S11", calls: s11.calls ?? [], destination: "Ittersbach" },
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
  // Each leg starts at the parting call, so a vehicle on its first link has both ends.
  assert.deepEqual(
    trunk?.branches.map(({ calls: branchCalls }) => branchCalls.map(({ stopName }) => stopName)),
    [
      ["busenbach", "etzenrot", "bad herrenalb"],
      ["busenbach", "langensteinbach", "ittersbach"],
    ],
  );
  // Every line has a leg, so nothing is said in words.
  assert.equal(
    getLineBundleTerminatingLabel(trunk?.branches ?? [], "ahead", "Busenbach"),
    undefined,
  );
});

test("keeps the different branch termini for the bundled heading", () => {
  const branches = getLineBundleTrunk(
    [
      { lineId: "S1", calls: s1.calls ?? [], destination: "Bad Herrenalb" },
      { lineId: "S11", calls: s11.calls ?? [], destination: "Ittersbach" },
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
  const shortWorking = stopEvent({
    id: "s11-short",
    lineId: "S11",
    destinationText: "Busenbach",
    calls: calls(...TRUNK),
  });
  const trunk = getLineBundleTrunk(
    [
      { lineId: "S1", calls: s1.calls ?? [], destination: "Bad Herrenalb" },
      { lineId: "S11", calls: shortWorking.calls ?? [], destination: "Busenbach" },
    ],
    ["hochstetten"],
  );

  assert.equal(
    getLineBundleTerminatingLabel(trunk?.branches ?? [], "ahead", "Busenbach"),
    "S11 endet in Busenbach",
  );
  // The short working has no leg; the line running on does.
  assert.deepEqual(
    trunk?.branches.map(({ lineId, calls: branchCalls }) => [lineId, branchCalls.length]),
    [
      ["S1", 3],
      ["S11", 0],
    ],
  );
});

test("measures the shared stretch outwards from the rider's own stop", () => {
  // Read from the middle: the lines part ahead and behind.
  const northern = stopEvent({
    id: "north",
    lineId: "S1",
    destinationText: "Bad Herrenalb",
    boardingStopPlaceId: "neureut",
    calls: calls("hochstetten", "eggenstein", "neureut", "busenbach", "bad herrenalb"),
  });
  const southern = stopEvent({
    id: "south",
    lineId: "S11",
    destinationText: "Ittersbach",
    boardingStopPlaceId: "neureut",
    calls: calls("spöck", "blankenloch", "neureut", "busenbach", "ittersbach"),
  });

  const trunk = getLineBundleTrunk(
    [
      { lineId: "S1", calls: northern.calls ?? [], destination: "Bad Herrenalb" },
      { lineId: "S11", calls: southern.calls ?? [], destination: "Ittersbach" },
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
  // A leg behind the rider ends at the junction, in travel order.
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
  const bayCall = (stopName: string, stopPlaceId: string): Call => ({
    stopName,
    stopPlaceId,
  });
  const sharedNorth = calls("hochstetten", "europaplatz");
  const sharedSouth = calls("ostendorfplatz", "busenbach");
  const trunk = getLineBundleTrunk(
    [
      {
        lineId: "S1",
        calls: [
          ...sharedNorth,
          bayCall("Marktplatz (Kaiserstraße U)", "marktplatz"),
          bayCall("Marktplatz (Pyramide U)", "marktplatz"),
          ...sharedSouth,
          ...calls("bad herrenalb"),
        ],
        destination: "Bad Herrenalb",
      },
      {
        lineId: "S11",
        calls: [
          ...sharedNorth,
          bayCall("Marktplatz (Pyramide U)", "marktplatz"),
          ...sharedSouth,
          ...calls("ittersbach"),
        ],
        destination: "Ittersbach",
      },
    ],
    ["ostendorfplatz"],
  );

  assert.deepEqual(
    trunk?.calls.map(({ stopPlaceId }) => stopPlaceId),
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
        { lineId: "S1", calls: s1.calls ?? [], destination: "Bad Herrenalb" },
        { lineId: "S11", calls: calls("ettlingen", "rastatt"), destination: "Rastatt" },
      ],
      ["hochstetten"],
    ),
    undefined,
  );
});

test("draws the sibling journey that runs with this one farthest, not the opposite direction", () => {
  const s11Back = stopEvent({
    id: "s11-back",
    lineId: "S11",
    destinationText: "Ittersbach",
    calls: calls("neureut", "hochstetten"),
  });
  const chosen = chooseLineBundleChain(
    { lineId: "S1", calls: s1.calls ?? [], destination: "Bad Herrenalb" },
    [
      { lineId: "S11", calls: s11Back.calls ?? [], destination: "Ittersbach" },
      { lineId: "S11", calls: s11.calls ?? [], destination: "Ittersbach" },
    ],
    ["hochstetten"],
  );

  assert.equal(chosen?.calls.length, s11.calls?.length);
});

test("uses the sibling's farthest observed end when candidates share the same trunk", () => {
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
    { lineId: "S1", calls: s1.calls ?? [], destination: "Bad Herrenalb" },
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

test("keeps an addressed bundle until the new stop's board has answered", () => {
  assert.deepEqual(getResolvedBundledLineIds(["S11"], null), ["S11"]);
  assert.deepEqual(
    getResolvedBundledLineIds(["S11"], {
      stopId: "ettlingen-neuwiesenreben--sc3hvj",
      receivedAt: 1,
      stopEvents: [],
      dataStatus: "unavailable",
      errorMessage: "nicht erreichbar",
    }),
    ["S11"],
  );
});

test("resolves a bundle from all lines serving the stop, not only its limited rows", () => {
  const board = {
    stopId: "ettlingen-neuwiesenreben--sc3hvj",
    receivedAt: 1,
    stopEvents: [s1],
    servingLines: [
      { lineId: "S1", lineRef: "s1-north" },
      { lineId: "S11", lineRef: "s11-north" },
    ],
    dataStatus: "live",
    feedUpdatedAt: "2026-09-04T12:00:00+02:00",
  } satisfies StopEventBoard;

  assert.deepEqual(getResolvedBundledLineIds(["S11"], board), ["S11"]);
  assert.deepEqual(getResolvedBundledLineIds(["S2"], board), []);
});

test("falls back to live departure rows when a whole-stop line list is absent", () => {
  const board = {
    stopId: "hochstetten",
    receivedAt: 1,
    stopEvents: [s11],
    dataStatus: "live",
    feedUpdatedAt: "2026-09-04T12:00:00+02:00",
  } satisfies StopEventBoard;

  assert.deepEqual(getResolvedBundledLineIds(["S11"], board), ["S11"]);
});

test("reads a departure of any bundled line as the selection", () => {
  const selection = { lineId: "S1", bundledLineIds: ["S11"] };
  assert.equal(isSelectedLine(selection, { lineId: "S11" }), true);
  assert.equal(isSelectedLine(selection, { lineId: "S2" }), false);
  assert.equal(isSelectedLine({ lineId: "S1", bundledLineIds: [] }, { lineId: "S11" }), false);
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
  // `MAX_BUNDLED_LINES` reached: no control may lead to an address that would drop a line.
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
