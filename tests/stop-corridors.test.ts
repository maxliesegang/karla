import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import { updateStopCorridorPatterns } from "../src/lib/stop-corridor-patterns.ts";
import { getStopServiceCorridorLineGroups } from "../src/lib/stop-corridors.ts";
import { createStopEvent } from "./support/fixtures.ts";

function stopEvent(
  overrides: Partial<StopEvent> & Pick<StopEvent, "id" | "destinationText">,
): StopEvent {
  return createStopEvent({
    journeyRef: overrides.id,
    lineId: "2",
    ptMode: "tram",
    minutesUntilDeparture: 4,
    bay: "1",
    boardingStopPlaceId: "europaplatz",
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

/** The grouping from one reading of the detailed boards, nothing remembered. */
const groupsAt = (
  stopId: string,
  live: readonly StopEvent[],
  topologyStopEvents: readonly StopEvent[] = [],
) =>
  getStopServiceCorridorLineGroups(
    live,
    updateStopCorridorPatterns(null, stopId, topologyStopEvents),
  );

test("does not merge S1 and S11 even when they share a destination", () => {
  const s1 = stopEvent({ id: "s1", lineId: "S1", destinationText: "Hochstetten" });
  const s11 = stopEvent({ id: "s11", lineId: "S11", destinationText: "Hochstetten" });

  const groups = groupsAt("europaplatz", [s1, s11], []);
  assert.deepEqual(
    groups.map(({ id }) => id),
    ["S1", "S11"],
  );
});

test("keeps two detailed patterns separate even when their destination is the same", () => {
  const direct = stopEvent({
    id: "direct",
    destinationText: "Durlach",
    calls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = stopEvent({
    id: "branch",
    destinationText: "Durlach",
    calls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  const corridors = groupsAt("europaplatz", [direct, branch], [direct, branch])[0].corridors;
  assert.equal(corridors.length, 2);
  // Both end at Durlach, so the rows fall back to the stops the journeys part at.
  assert.deepEqual(
    corridors.map(({ directionLabel }) => directionLabel),
    ["Hauptbahnhof", "Marktplatz"],
  );
  // Each row was observed along a full route, so both may claim a shared way.
  assert.equal(
    corridors.every(({ hasObservedSharedRoute }) => hasObservedSharedRoute),
    true,
  );
});

test("a corridor matched only over its first link may not claim a shared route", () => {
  const live = [
    stopEvent({ id: "first", lineRef: "dir", destinationText: "First end" }),
    stopEvent({ id: "second", lineRef: "dir", destinationText: "Second end" }),
  ];
  const earlier = stopEvent({
    id: "earlier",
    lineRef: "dir",
    destinationText: "Earlier end",
    calls: calls("Europaplatz", "Marktplatz", "Earlier end"),
  });
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [earlier]);

  const corridor = getStopServiceCorridorLineGroups(live, patterns)[0].corridors[0];
  // They share the first link, so they group, but nothing beyond it was observed.
  assert.equal(corridor.hasObservedTopology, true);
  assert.equal(corridor.hasObservedSharedRoute, false);
});

test("groups short workings with through journeys over their shared outgoing corridor", () => {
  const live = [
    stopEvent({
      id: "stadt",
      lineId: "S1",
      destinationText: "Ettlingen Stadt",
    }),
    stopEvent({
      id: "albgaubad",
      lineId: "S1",
      destinationText: "Ettlingen Albgaubad",
    }),
    stopEvent({
      id: "hoch",
      lineId: "S1",
      destinationText: "Hochstetten",
    }),
  ];
  const topologyStopEvents = [
    stopEvent({
      ...live[0],
      calls: [
        {
          stopName: "Ostendorfplatz",
          stopPlaceId: "europaplatz",
          isThisCall: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Tulpenstraße", stopPlaceId: "tulpenstrasse", placeName: "Karlsruhe" },
        { stopName: "Battstraße", stopPlaceId: "battstrasse", placeName: "Karlsruhe" },
        { stopName: "Stadt", stopPlaceId: "ettlingen-stadt", placeName: "Ettlingen" },
      ],
    }),
    stopEvent({
      ...live[1],
      calls: [
        {
          stopName: "Ostendorfplatz",
          stopPlaceId: "europaplatz",
          isThisCall: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Tulpenstraße", stopPlaceId: "tulpenstrasse", placeName: "Karlsruhe" },
        { stopName: "Battstraße", stopPlaceId: "battstrasse", placeName: "Karlsruhe" },
        { stopName: "Stadt", stopPlaceId: "ettlingen-stadt", placeName: "Ettlingen" },
        { stopName: "Albgaubad", stopPlaceId: "albgaubad", placeName: "Ettlingen" },
      ],
    }),
    stopEvent({
      ...live[2],
      calls: [
        {
          stopName: "Ostendorfplatz",
          stopPlaceId: "europaplatz",
          isThisCall: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Schloss Rüppurr", stopPlaceId: "schloss-rueppurr", placeName: "Karlsruhe" },
        {
          stopName: "Hochstetten",
          stopPlaceId: "hochstetten",
          placeName: "Linkenheim-Hochstetten",
        },
      ],
    }),
  ];
  const groups = groupsAt("europaplatz", live, topologyStopEvents);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].corridors.length, 2);
  const southbound = groups[0].corridors.find(
    ({ directionLabel }) => directionLabel === "Ettlingen",
  );
  assert.deepEqual(
    southbound?.stopEvents.map(({ destinationText: destination }) => destination),
    ["Ettlingen Stadt", "Ettlingen Albgaubad"],
  );
  // Both full routes were read and chain, so the row may claim a shared way.
  assert.equal(southbound?.hasObservedSharedRoute, true);
});

test("colliding corridors are named by where their journeys part, and the unread row keeps its headsign", () => {
  const live = [
    stopEvent({ id: "direct", destinationText: "Hauptbahnhof", journeyRef: "direct" }),
    stopEvent({ id: "branch", destinationText: "Hauptbahnhof", journeyRef: "branch" }),
    stopEvent({ id: "unread", destinationText: "Hauptbahnhof", journeyRef: "unread" }),
  ];
  const topologyStopEvents = [
    stopEvent({ ...live[0], calls: calls("Europaplatz", "Marktplatz", "Hauptbahnhof") }),
    stopEvent({ ...live[1], calls: calls("Europaplatz", "Kongresszentrum", "Hauptbahnhof") }),
  ];

  const labels = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors.map(
    ({ directionLabel }) => directionLabel,
  );
  // The two observed rows fall back to their parting stops; the unread one keeps its headsign.
  assert.deepEqual(labels, ["Hauptbahnhof", "Kongresszentrum", "Marktplatz"]);
  assert.equal(new Set(labels).size, 3);
});

test("matches an unseen headsign through the feed's unambiguous line direction", () => {
  const live = [
    stopEvent({
      id: "forbach",
      lineId: "S8",
      lineRef: "kvv:22308:E:H:s26",
      destinationText: "Forbach",
    }),
    stopEvent({
      id: "freudenstadt",
      lineId: "S8",
      lineRef: "kvv:22308:E:H:s26",
      destinationText: "Freudenstadt Hbf",
    }),
    stopEvent({
      id: "bondorf",
      lineId: "S8",
      lineRef: "kvv:22308:E:H:s26",
      destinationText: "Bondorf",
    }),
    stopEvent({
      id: "tulla",
      lineId: "S8",
      lineRef: "kvv:22308:E:R:s26",
      destinationText: "Tullastraße",
    }),
  ];
  const topologyStopEvents = [
    stopEvent({ ...live[0], calls: calls("Europaplatz", "Poststraße", "Forbach") }),
    stopEvent({
      ...live[2],
      calls: calls("Europaplatz", "Poststraße", "Forbach", "Freudenstadt", "Bondorf"),
    }),
    stopEvent({ ...live[3], calls: calls("Europaplatz", "Kongresszentrum", "Tullastraße") }),
  ];

  const corridors = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors;
  const outbound = corridors.find(({ destinations }) => destinations.includes("Forbach"));
  assert.ok(outbound);
  assert.deepEqual(outbound.destinations, ["Forbach", "Freudenstadt Hbf", "Bondorf"]);
  assert.equal(outbound.stopEvents.length, 3);
  assert.equal(corridors.length, 2);
});

test("does not infer a direction when its observed journeys leave by competing links", () => {
  const later = stopEvent({
    id: "later",
    lineRef: "same-direction",
    destinationText: "Unknown end",
  });
  const first = stopEvent({
    id: "first",
    lineRef: "same-direction",
    destinationText: "First end",
    calls: calls("Europaplatz", "Marktplatz", "First end"),
  });
  const second = stopEvent({
    id: "second",
    lineRef: "same-direction",
    destinationText: "Second end",
    calls: calls("Europaplatz", "Hauptbahnhof", "Second end"),
  });

  const corridor = groupsAt("europaplatz", [later], [first, second])[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, false);
});

test("collapses calls outside the board's municipality to the place they are in", () => {
  const live = stopEvent({
    id: "live",
    lineId: "S2",
    destinationText: "Rheinstetten",
    journeyRef: "rheinstetten",
  });
  const observed = stopEvent({
    ...live,
    calls: [
      {
        stopName: "Europaplatz",
        stopPlaceId: "europaplatz",
        isThisCall: true,
        placeName: "Karlsruhe",
      },
      { stopName: "Bahnhof", stopPlaceId: "kar-bahnhof", placeName: "Karlsruhe" },
      { stopName: "Silberstreifen", stopPlaceId: "silberstreifen", placeName: "Rheinstetten" },
      { stopName: "Mörscher Straße", stopPlaceId: "moerscher-strasse", placeName: "Rheinstetten" },
      { stopName: "Bahnhof", stopPlaceId: "rheinstetten-bahnhof", placeName: "Rheinstetten" },
    ],
  });

  const corridor = groupsAt("europaplatz", [live], [observed])[0].corridors[0];
  // The headsign is `Rheinstetten Bahnhof`; the direction is its place.
  assert.equal(corridor.directionLabel, "Rheinstetten");
});

test("names a Karlsruhe district the way it names a municipality", () => {
  // Calls name districts (`Durlach`, `Rüppurr`) in the place field and plain `Karlsruhe` for the
  // centre.
  const live = stopEvent({
    id: "live",
    lineId: "1",
    destinationText: "Durlach Turmberg",
    journeyRef: "durlach-turmberg",
  });
  const observed = stopEvent({
    ...live,
    calls: [
      {
        stopName: "Europaplatz",
        stopPlaceId: "europaplatz",
        isThisCall: true,
        placeName: "Karlsruhe",
      },
      { stopName: "Kronenplatz", stopPlaceId: "kronenplatz", placeName: "Karlsruhe" },
      { stopName: "Turmberg", stopPlaceId: "durlach-turmberg", placeName: "Durlach" },
    ],
  });
  const inbound = stopEvent({
    id: "inbound",
    lineId: "1",
    destinationText: "Hauptbahnhof",
    journeyRef: "hbf",
  });
  const observedInbound = stopEvent({
    ...inbound,
    calls: [
      {
        stopName: "Europaplatz",
        stopPlaceId: "europaplatz",
        isThisCall: true,
        placeName: "Karlsruhe",
      },
      { stopName: "Hauptbahnhof", stopPlaceId: "hauptbahnhof", placeName: "Karlsruhe" },
    ],
  });

  const corridors = groupsAt("europaplatz", [live, inbound], [observed, observedInbound])[0]
    .corridors;
  assert.deepEqual(
    corridors.map(({ directionLabel }) => directionLabel),
    ["Durlach", "Hauptbahnhof"],
  );
});

test("names both ends where the short working turns back along the through route", () => {
  const live = [
    stopEvent({
      id: "stadt",
      lineId: "S1",
      destinationText: "Ettlingen Stadt",
      journeyRef: "stadt",
    }),
    stopEvent({
      id: "herrenalb",
      lineId: "S1",
      destinationText: "Bad Herrenalb",
      journeyRef: "herrenalb",
    }),
  ];
  const shared: Call[] = [
    {
      stopName: "Europaplatz",
      stopPlaceId: "europaplatz",
      isThisCall: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Rüppurr Ostendorfplatz", stopPlaceId: "ostendorfplatz", placeName: "Rüppurr" },
    { stopName: "Stadt", stopPlaceId: "ettlingen-stadt", placeName: "Ettlingen" },
  ];
  const topologyStopEvents = [
    stopEvent({ ...live[0], calls: shared }),
    stopEvent({
      ...live[1],
      calls: [
        ...shared,
        { stopName: "Busenbach", stopPlaceId: "busenbach", placeName: "Busenbach (Waldbr.)" },
        { stopName: "Bad Herrenalb", stopPlaceId: "bad-herrenalb", placeName: "Bad Herrenalb" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors[0];
  assert.equal(corridor.stopEvents.length, 2);
  assert.equal(corridor.directionLabel, "Ettlingen");
  assert.deepEqual(
    corridor.places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Ettlingen", isTerminus: true },
      { label: "Bad Herrenalb", isTerminus: true },
    ],
  );
});

test("does not chain two ends the journeys genuinely part for", () => {
  const live = [
    stopEvent({ id: "west", lineId: "2", destinationText: "Knielingen Nord", journeyRef: "west" }),
    stopEvent({ id: "north", lineId: "2", destinationText: "Neureut Heide", journeyRef: "north" }),
  ];
  const topologyStopEvents = [
    stopEvent({ ...live[0], calls: calls("Europaplatz", "Entenfang", "Knielingen Nord") }),
    stopEvent({ ...live[1], calls: calls("Europaplatz", "Entenfang", "Neureut Heide") }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors[0];
  assert.deepEqual(corridor.places, []);
  // Only the last shared point may be claimed.
  assert.equal(corridor.directionLabel, "Entenfang");
});

test("states an end again where the way returns to a place it named before", () => {
  // An end lying behind a further one must still be stated.
  const live = [
    stopEvent({ id: "near", lineId: "S1", destinationText: "Ettlingen", journeyRef: "near" }),
    stopEvent({ id: "through", lineId: "S1", destinationText: "Malsch", journeyRef: "through" }),
    stopEvent({ id: "back", lineId: "S1", destinationText: "Ettlingen", journeyRef: "back" }),
  ];
  const head: Call[] = [
    {
      stopName: "Europaplatz",
      stopPlaceId: "europaplatz",
      isThisCall: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Ettlingen", stopPlaceId: "ettlingen", placeName: "Ettlingen" },
  ];
  const topologyStopEvents = [
    stopEvent({ ...live[0], calls: head }),
    stopEvent({
      ...live[1],
      calls: [...head, { stopName: "Malsch", stopPlaceId: "malsch", placeName: "Malsch" }],
    }),
    stopEvent({
      ...live[2],
      calls: [
        ...head,
        { stopName: "Malsch", stopPlaceId: "malsch", placeName: "Malsch" },
        { stopName: "Ettlingen Erbprinz", stopPlaceId: "erbprinz", placeName: "Ettlingen" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors[0];
  // Three ends, two in Ettlingen: all stated.
  assert.deepEqual(
    corridor.places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Ettlingen", isTerminus: true },
      { label: "Malsch", isTerminus: true },
      { label: "Ettlingen", isTerminus: true },
    ],
  );
});

test("weaves the places the route serves with several stops between the ends", () => {
  const live = [
    stopEvent({
      id: "stadt",
      lineId: "S1",
      destinationText: "Ettlingen Stadt",
      journeyRef: "stadt",
    }),
    stopEvent({
      id: "herrenalb",
      lineId: "S1",
      destinationText: "Bad Herrenalb",
      journeyRef: "herrenalb",
    }),
  ];
  const head: Call[] = [
    {
      stopName: "Europaplatz",
      stopPlaceId: "europaplatz",
      isThisCall: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Ostendorfplatz", stopPlaceId: "ostendorfplatz", placeName: "Rüppurr" },
    { stopName: "Rüppurrer Straße", stopPlaceId: "rueppurrer-strasse", placeName: "Rüppurr" },
  ];
  const topologyStopEvents = [
    stopEvent({
      ...live[0],
      calls: [
        ...head,
        { stopName: "Stadt", stopPlaceId: "ettlingen-stadt", placeName: "Ettlingen" },
      ],
    }),
    stopEvent({
      ...live[1],
      calls: [
        ...head,
        { stopName: "Stadt", stopPlaceId: "ettlingen-stadt", placeName: "Ettlingen" },
        { stopName: "Busenbach", stopPlaceId: "busenbach", placeName: "Busenbach (Waldbr.)" },
        { stopName: "Bad Herrenalb", stopPlaceId: "bad-herrenalb", placeName: "Bad Herrenalb" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors[0];
  // Rüppurr (many stops) is sketched; Busenbach (once, no connections) stands back.
  assert.deepEqual(
    corridor.places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Rüppurr", isTerminus: false },
      { label: "Ettlingen", isTerminus: true },
      { label: "Bad Herrenalb", isTerminus: true },
    ],
  );
  assert.deepEqual(
    corridor.places.filter((place) => !place.isTerminus).map((place) => [place.label, place.rank]),
    [["Rüppurr", 0]],
  );
});

test("a place another line serves is prominent though the route calls there once", () => {
  const live = [
    stopEvent({
      id: "through",
      lineId: "S1",
      destinationText: "Ettlingen Stadt",
      journeyRef: "through",
    }),
  ];
  const topologyStopEvents = [
    stopEvent({
      ...live[0],
      calls: [
        {
          stopName: "Europaplatz",
          stopPlaceId: "europaplatz",
          isThisCall: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Ostendorfplatz", stopPlaceId: "ostendorfplatz", placeName: "Rüppurr" },
        { stopName: "Rüppurrer Straße", stopPlaceId: "rueppurrer-strasse", placeName: "Rüppurr" },
        { stopName: "Malsch", stopPlaceId: "malsch", placeName: "Malsch" },
        { stopName: "Stadt", stopPlaceId: "ettlingen-stadt", placeName: "Ettlingen" },
      ],
    }),
    // A bus through Malsch, read at a post the journey never passes: connections count from anywhere.
    stopEvent({
      id: "bus",
      lineId: "216",
      destinationText: "Malsch",
      boardingStopPlaceId: "muggensturm",
      calls: [
        {
          stopName: "Muggensturm",
          stopPlaceId: "muggensturm",
          isThisCall: true,
          placeName: "Muggensturm",
        },
        { stopName: "Malsch", stopPlaceId: "malsch", placeName: "Malsch" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors[0];
  // Malsch, a connection, outranks Rüppurr, served twice by nothing else.
  assert.deepEqual(
    corridor.places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Rüppurr", isTerminus: false },
      { label: "Malsch", isTerminus: false },
      { label: "Ettlingen", isTerminus: true },
    ],
  );
  assert.deepEqual(
    corridor.places.filter((place) => !place.isTerminus).map((place) => [place.label, place.rank]),
    [
      ["Rüppurr", 1],
      ["Malsch", 0],
    ],
  );
});

test("states three places, the most relevant of the way's own beside the end", () => {
  const live = [stopEvent({ id: "through", lineId: "S1", destinationText: "Ettlingen Stadt" })];
  const topologyStopEvents = [
    stopEvent({
      ...live[0],
      calls: [
        {
          stopName: "Europaplatz",
          stopPlaceId: "europaplatz",
          isThisCall: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Bulach", stopPlaceId: "bulach", placeName: "Bulach" },
        { stopName: "Battstraße", stopPlaceId: "battstrasse", placeName: "Bulach" },
        { stopName: "Ostendorfplatz", stopPlaceId: "ostendorfplatz", placeName: "Rüppurr" },
        { stopName: "Rüppurrer Straße", stopPlaceId: "rueppurrer-strasse", placeName: "Rüppurr" },
        { stopName: "Schloss Rüppurr", stopPlaceId: "schloss-rueppurr", placeName: "Rüppurr" },
        { stopName: "Malsch", stopPlaceId: "malsch", placeName: "Malsch" },
        { stopName: "Stadt", stopPlaceId: "ettlingen-stadt", placeName: "Ettlingen" },
      ],
    }),
    // The one connection along this way.
    stopEvent({
      id: "bus",
      lineId: "216",
      destinationText: "Malsch",
      boardingStopPlaceId: "muggensturm",
      calls: [
        {
          stopName: "Muggensturm",
          stopPlaceId: "muggensturm",
          isThisCall: true,
          placeName: "Muggensturm",
        },
        { stopName: "Malsch", stopPlaceId: "malsch", placeName: "Malsch" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors[0];
  // Three places in all: the end, Malsch (connection) and Rüppurr; Bulach stands down.
  assert.deepEqual(
    corridor.places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Rüppurr", isTerminus: false },
      { label: "Malsch", isTerminus: false },
      { label: "Ettlingen", isTerminus: true },
    ],
  );
  // Ranks stay a run from most prominent down.
  assert.deepEqual(
    corridor.places.filter((place) => !place.isTerminus).map((place) => [place.label, place.rank]),
    [
      ["Rüppurr", 1],
      ["Malsch", 0],
    ],
  );
});

test("states every end, and no way places, where the ends alone fill the row", () => {
  const live = [
    stopEvent({ id: "rueppurr", lineId: "S1", destinationText: "Rüppurr", journeyRef: "rueppurr" }),
    stopEvent({
      id: "stadt",
      lineId: "S1",
      destinationText: "Ettlingen Stadt",
      journeyRef: "stadt",
    }),
    stopEvent({
      id: "herrenalb",
      lineId: "S1",
      destinationText: "Bad Herrenalb",
      journeyRef: "herrenalb",
    }),
    stopEvent({
      id: "ittersbach",
      lineId: "S1",
      destinationText: "Ittersbach",
      journeyRef: "ittersbach",
    }),
  ];
  const head: Call[] = [
    {
      stopName: "Europaplatz",
      stopPlaceId: "europaplatz",
      isThisCall: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Ostendorfplatz", stopPlaceId: "ostendorfplatz", placeName: "Rüppurr" },
    { stopName: "Rüppurrer Straße", stopPlaceId: "rueppurrer-strasse", placeName: "Rüppurr" },
  ];
  const toEttlingen: Call[] = [
    ...head,
    { stopName: "Stadt", stopPlaceId: "ettlingen-stadt", placeName: "Ettlingen" },
  ];
  const toHerrenalb: Call[] = [
    ...toEttlingen,
    { stopName: "Busenbach", stopPlaceId: "busenbach", placeName: "Busenbach (Waldbr.)" },
    { stopName: "Bad Herrenalb", stopPlaceId: "bad-herrenalb", placeName: "Bad Herrenalb" },
  ];
  const topologyStopEvents = [
    stopEvent({ ...live[0], calls: head }),
    stopEvent({ ...live[1], calls: toEttlingen }),
    stopEvent({ ...live[2], calls: toHerrenalb }),
    stopEvent({
      ...live[3],
      calls: [
        ...toHerrenalb,
        { stopName: "Ittersbach", stopPlaceId: "ittersbach", placeName: "Karlsbad" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors[0];
  // Four ends fill the row, leaving no room for places between.
  assert.deepEqual(
    corridor.places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Rüppurr", isTerminus: true },
      { label: "Ettlingen", isTerminus: true },
      { label: "Bad Herrenalb", isTerminus: true },
      { label: "Karlsbad", isTerminus: true },
    ],
  );
});

test("does not apply an observed corridor to a diverted live journey", () => {
  const diverted = stopEvent({
    id: "diverted",
    lineId: "S1",
    destinationText: "Ettlingen Albgaubad",
    journeyRef: "de:kvv:00S01_:.kvv-22-301-E.5.T0.169.s26",
    status: "diverted",
  });
  const observed = stopEvent({
    ...diverted,
    status: "realtime",
    calls: calls("Europaplatz", "Tulpenstraße", "Ettlingen Stadt", "Ettlingen Albgaubad"),
  });

  const corridor = groupsAt("europaplatz", [diverted], [observed])[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, false);
});

test("groups exceptional short and through journeys by their own observed corridor", () => {
  const short = stopEvent({
    id: "daxlanden",
    lineId: "3",
    destinationText: "Daxlanden über Hbf",
    journeyRef: "daxlanden",
    serviceNote: "Umleitung",
  });
  const through = stopEvent({
    id: "rappenwoert",
    lineId: "3",
    destinationText: "Rappenwört über Hbf",
    journeyRef: "rappenwoert",
    serviceNote: "Umleitung",
  });
  const opposite = stopEvent({
    id: "rintheim",
    lineId: "3",
    destinationText: "Rintheim",
    journeyRef: "rintheim",
  });
  const laterShort = stopEvent({ ...short, id: "later-daxlanden", journeyRef: "later-daxlanden" });
  const laterThrough = stopEvent({
    ...through,
    id: "later-rappenwoert",
    journeyRef: "later-rappenwoert",
  });
  // A stop place as two consecutive calls is still the rider's stop, not a shared outgoing link.
  const shared = calls(
    "Hauptfriedhof",
    "Hauptfriedhof",
    "Karl-Wilhelm-Platz",
    "Hauptbahnhof",
    "Waidweg",
  );
  const topologyStopEvents = [
    stopEvent({ ...short, calls: shared }),
    stopEvent({ ...through, calls: [...shared, ...calls("Altrheinbrücke", "Rappenwört")] }),
    stopEvent({
      ...opposite,
      calls: calls("Hauptfriedhof", "Hauptfriedhof", "Dunantstraße", "Rintheim"),
    }),
  ];

  const corridors = groupsAt(
    "hauptfriedhof",
    [short, through, laterShort, laterThrough, opposite],
    topologyStopEvents,
  )[0].corridors;
  assert.equal(corridors.length, 2);
  const corridor = corridors.find(({ destinations }) =>
    destinations.includes("Daxlanden über Hbf"),
  );
  assert.ok(corridor);
  assert.equal(corridor.stopEvents.length, 4);
  assert.equal(corridor.hasObservedTopology, true);
  assert.deepEqual(corridor.destinations, ["Daxlanden über Hbf", "Rappenwört über Hbf"]);
});

test("does not reuse an ambiguous line and destination pattern", () => {
  const live = stopEvent({ id: "later", destinationText: "Durlach", journeyRef: "later" });
  const direct = stopEvent({
    id: "direct",
    destinationText: "Durlach",
    calls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = stopEvent({
    id: "branch",
    destinationText: "Durlach",
    calls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  const corridor = groupsAt("europaplatz", [live], [direct, branch])[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, false);
});

test("does not reuse an ambiguous exceptional pattern", () => {
  const later = stopEvent({
    id: "later",
    destinationText: "Durlach",
    journeyRef: "later",
    serviceNote: "Umleitung",
  });
  const direct = stopEvent({
    id: "direct",
    destinationText: "Durlach",
    journeyRef: "direct",
    serviceNote: "Umleitung",
    calls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = stopEvent({
    id: "branch",
    destinationText: "Durlach",
    journeyRef: "branch",
    serviceNote: "Umleitung",
    calls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  const corridor = groupsAt("europaplatz", [later], [direct, branch])[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, false);
});
test("keeps grouping a journey after the board that showed its route has been refreshed away", () => {
  const stadt = stopEvent({
    id: "stadt",
    lineId: "S1",
    destinationText: "Ettlingen Stadt",
    journeyRef: "stadt",
  });
  const herrenalb = stopEvent({
    id: "herrenalb",
    lineId: "S1",
    destinationText: "Bad Herrenalb",
    journeyRef: "herrenalb",
  });
  const learned = updateStopCorridorPatterns(null, "europaplatz", [
    stopEvent({ ...stadt, calls: calls("Europaplatz", "Ostendorfplatz", "Ettlingen Stadt") }),
    stopEvent({ ...herrenalb, calls: calls("Europaplatz", "Ostendorfplatz", "Bad Herrenalb") }),
  ]);

  // The next light refresh has no sequences; what was observed still relates the two.
  const kept = updateStopCorridorPatterns(learned, "europaplatz", []);
  const corridor = getStopServiceCorridorLineGroups([stadt, herrenalb], kept)[0].corridors[0];

  assert.equal(corridor.stopEvents.length, 2);
  assert.equal(corridor.hasObservedTopology, true);
  assert.equal(corridor.directionLabel, "Ostendorfplatz");
});

test("a route learned once covers a later journey the detailed boards never reached", () => {
  const learned = updateStopCorridorPatterns(null, "europaplatz", [
    stopEvent({
      id: "read",
      destinationText: "Durlach",
      journeyRef: "read",
      calls: calls("Europaplatz", "Marktplatz", "Durlach"),
    }),
  ]);
  const later = stopEvent({ id: "later", destinationText: "Durlach", journeyRef: "later" });

  const corridor = getStopServiceCorridorLineGroups([later], learned)[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, true);
});

test("one oddly reported journey does not withdraw the route the line is known to take", () => {
  const usual = Array.from({ length: 6 }, (_, index) =>
    stopEvent({
      id: `usual-${index}`,
      destinationText: "Durlach",
      journeyRef: `usual-${index}`,
      calls: calls("Europaplatz", "Marktplatz", "Durlach"),
    }),
  );
  const odd = stopEvent({
    id: "odd",
    destinationText: "Durlach",
    journeyRef: "odd",
    calls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [...usual, odd]);
  const later = stopEvent({ id: "later", destinationText: "Durlach", journeyRef: "later" });

  const corridors = getStopServiceCorridorLineGroups([later], patterns)[0].corridors;
  assert.equal(corridors[0].hasObservedTopology, true);
  // Grouped over the link the line is known to take.
  assert.ok(corridors[0].id.endsWith("observed:marktplatz"));
});

test("counts journeys rather than readings, so one board re-read cannot outvote the others", () => {
  const branch = stopEvent({
    id: "branch",
    destinationText: "Durlach",
    journeyRef: "branch",
    calls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });
  const direct = stopEvent({
    id: "direct",
    destinationText: "Durlach",
    journeyRef: "direct",
    calls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });

  // The same two journeys four times over, as a 90-second board delivers them.
  let patterns = updateStopCorridorPatterns(null, "europaplatz", [branch, direct]);
  for (let reading = 0; reading < 3; reading += 1) {
    patterns = updateStopCorridorPatterns(patterns, "europaplatz", [branch, branch, direct]);
  }
  const later = stopEvent({ id: "later", destinationText: "Durlach", journeyRef: "later" });

  // One route each, so neither speaks for an unknown journey.
  assert.equal(
    getStopServiceCorridorLineGroups([later], patterns)[0].corridors[0].hasObservedTopology,
    false,
  );
});

test("journeys whose route is unknown share the row their headsign names", () => {
  const unread = [
    stopEvent({ id: "first", destinationText: "Durlach Turmberg", journeyRef: "first" }),
    stopEvent({ id: "second", destinationText: "Durlach Turmberg", journeyRef: "second" }),
  ];

  const corridors = groupsAt("europaplatz", unread)[0].corridors;
  assert.equal(corridors.length, 1);
  assert.equal(corridors[0].stopEvents.length, 2);
  assert.equal(corridors[0].directionLabel, "Durlach Turmberg");
  assert.equal(corridors[0].hasObservedTopology, false);
});

test("exceptional journeys describe themselves but do not teach later journeys", () => {
  const route = calls("Europaplatz", "Hauptbahnhof", "Rheinstetten");
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [
    stopEvent({
      id: "diverted",
      destinationText: "Rheinstetten",
      journeyRef: "a",
      status: "diverted",
      calls: route,
    }),
    stopEvent({
      id: "sev",
      destinationText: "Rheinstetten",
      journeyRef: "b",
      serviceNote: "Ersatzverkehr",
      calls: route,
    }),
  ]);
  const later = stopEvent({ id: "later", destinationText: "Rheinstetten", journeyRef: "later" });

  const current = getStopServiceCorridorLineGroups(
    [
      stopEvent({
        id: "diverted",
        destinationText: "Rheinstetten",
        journeyRef: "a",
        status: "diverted",
      }),
    ],
    patterns,
  )[0].corridors[0];
  assert.equal(current.hasObservedTopology, true);
  assert.equal(
    getStopServiceCorridorLineGroups([later], patterns)[0].corridors[0].hasObservedTopology,
    false,
  );
});

test("a refresh that taught nothing is not a change, and another stop starts over", () => {
  const observed = stopEvent({
    id: "observed",
    destinationText: "Durlach",
    journeyRef: "observed",
    calls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [observed]);

  assert.equal(updateStopCorridorPatterns(patterns, "europaplatz", [observed]), patterns);
  // Routes are relative to their stop, so nothing carries over.
  const elsewhere = updateStopCorridorPatterns(patterns, "marktplatz", []);
  assert.equal(elsewhere.byJourneyKey.size, 0);
});

test("two boards disagreeing about one journey still settle on a single reading", () => {
  // Two boards disagree about this journey's calls; repeated readings must reach a fixed point instead
  // of overwriting each other forever.
  const ownReading = stopEvent({
    id: "own",
    destinationText: "Durlach",
    journeyRef: "shared",
    calls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const postReading = stopEvent({
    id: "post",
    destinationText: "Durlach",
    journeyRef: "shared",
    calls: calls("Europaplatz", "Marktplatz"),
  });

  const learned = updateStopCorridorPatterns(null, "europaplatz", [ownReading, postReading]);
  // Rereading the same boards teaches nothing, in any order.
  assert.equal(
    updateStopCorridorPatterns(learned, "europaplatz", [ownReading, postReading]),
    learned,
  );
  assert.equal(updateStopCorridorPatterns(learned, "europaplatz", [ownReading]), learned);
  // The stop's own board leads, so its reading is kept.
  assert.equal(learned.byJourneyKey.size, 1);
  assert.deepEqual(
    [...learned.byJourneyKey.values()][0].map((call) => call.stopName),
    ["Marktplatz", "Durlach"],
  );
});

test("reuses route indexes when a reading only learns the board's place", () => {
  const observed = stopEvent({
    id: "observed",
    destinationText: "Durlach",
    journeyRef: "observed",
    calls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [observed]);
  const withPlace = updateStopCorridorPatterns(patterns, "europaplatz", [
    stopEvent({
      id: "place",
      destinationText: "Durlach",
      calls: [
        {
          stopName: "Europaplatz",
          stopPlaceId: "europaplatz",
          isThisCall: true,
          placeName: "Karlsruhe",
        },
      ],
    }),
  ]);

  assert.equal(withPlace.boardPlaceName, "Karlsruhe");
  assert.equal(withPlace.byJourneyKey, patterns.byJourneyKey);
  assert.equal(withPlace.byLineDestination, patterns.byLineDestination);
});

test("forgets the journeys that passed longest ago rather than growing without end", () => {
  const observations = Array.from({ length: 5 }, (_, index) =>
    stopEvent({
      id: `journey-${index}`,
      destinationText: "Durlach",
      journeyRef: `journey-${index}`,
      calls: calls("Europaplatz", "Marktplatz", "Durlach"),
    }),
  );
  const patterns = updateStopCorridorPatterns(null, "europaplatz", observations, 3);

  assert.deepEqual([...patterns.byJourneyKey.keys()], ["journey-2", "journey-3", "journey-4"]);
  // The line's pattern survives trimming.
  const later = stopEvent({ id: "later", destinationText: "Durlach", journeyRef: "later" });
  assert.equal(
    getStopServiceCorridorLineGroups([later], patterns)[0].corridors[0].hasObservedTopology,
    true,
  );
});

test("a journey that turns back is not parted from the service that runs on through it", () => {
  // A terminating journey is reported twice at its terminus (Gottesauer Platz: `Reitschulschlag >
  // Reitschulschlag` vs `Reitschulschlag > Büchig`); both calls stay, and it is still recognised as
  // the through route's short working.
  const live = [
    stopEvent({ id: "spoeck", lineId: "S2", destinationText: "Spöck", journeyRef: "spoeck" }),
    stopEvent({
      id: "short",
      lineId: "S2",
      destinationText: "Reitschulschlag",
      journeyRef: "short",
    }),
  ];
  const shared: Call[] = [
    {
      stopName: "Europaplatz",
      stopPlaceId: "europaplatz",
      isThisCall: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Reitschulschlag", stopPlaceId: "reitschulschlag", placeName: "Hagsfeld" },
  ];
  const topologyStopEvents = [
    stopEvent({
      ...live[0],
      calls: [
        ...shared,
        { stopName: "Büchig", stopPlaceId: "buechig", placeName: "Büchig" },
        { stopName: "Hochhaus", stopPlaceId: "spoeck-hochhaus", placeName: "Spöck" },
      ],
    }),
    stopEvent({
      ...live[1],
      // The same stop again, on the departure platform.
      calls: [...shared, { ...shared[1], bayText: "Gleis 3" }],
    }),
  ];

  const corridors = groupsAt("europaplatz", live, topologyStopEvents)[0].corridors;
  assert.equal(corridors.length, 1);
  assert.deepEqual(
    corridors[0].places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Hagsfeld", isTerminus: true },
      { label: "Spöck", isTerminus: true },
    ],
  );
  assert.equal(corridors[0].hasObservedSharedRoute, true);
});

test("two places sharing a name do not lend each other connections", () => {
  // `Friedrichstal` is Stutensee's on the S2 and Baiersbronn's on the S8, 70 km apart.
  const stutensee = { latitude: 49.109, longitude: 8.476 };
  const murgtal = { latitude: 48.482, longitude: 8.377 };
  const here: Call = {
    stopName: "Europaplatz",
    stopPlaceId: "europaplatz",
    isThisCall: true,
    placeName: "Karlsruhe",
  };
  const murgtalLine = stopEvent({
    id: "s8",
    lineId: "S8",
    destinationText: "Freudenstadt Hbf",
    journeyRef: "s8",
    calls: [
      here,
      {
        stopName: "Bahnhof",
        stopPlaceId: "murgtal-friedrichstal",
        placeName: "Friedrichstal",
        ...murgtal,
      },
      { stopName: "Hauptbahnhof", stopPlaceId: "freudenstadt-hbf", placeName: "Freudenstadt" },
    ],
  });
  const namesake = (position: typeof stutensee) =>
    stopEvent({
      id: "s2",
      lineId: "S2",
      destinationText: "Spöck",
      journeyRef: "s2",
      calls: [
        here,
        {
          stopName: "Mitte",
          stopPlaceId: "friedrichstal-mitte",
          placeName: "Friedrichstal",
          ...position,
        },
        { stopName: "Hochhaus", stopPlaceId: "spoeck-hochhaus", placeName: "Spöck" },
      ],
    });
  const wayOfS8 = (other: StopEvent) =>
    groupsAt("europaplatz", [murgtalLine], [murgtalLine, other])[0].corridors[0].places.map(
      ({ label }) => label,
    );

  // The S2's Friedrichstal is elsewhere, and one call does not make a place.
  assert.deepEqual(wayOfS8(namesake(stutensee)), ["Freudenstadt"]);
  // A line seen at the same place is a connection.
  assert.deepEqual(wayOfS8(namesake(murgtal)), ["Friedrichstal", "Freudenstadt"]);
});

test("reads the board's place at its own stop, not at another stop's marker on a shared reading", () => {
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [
    stopEvent({
      id: "shared",
      destinationText: "Durlach",
      calls: [
        {
          stopName: "Rheinstrandhalle",
          stopPlaceId: "rheinstrandhalle",
          placeName: "Daxlanden",
          isThisCall: true,
        },
        { stopName: "Europaplatz", stopPlaceId: "europaplatz", placeName: "Karlsruhe" },
      ],
    }),
  ]);

  assert.equal(patterns.boardPlaceName, "Karlsruhe");
});

test("another operator's line of a KVV line's name is its own group, after KVV's lines", () => {
  const kvvS4 = stopEvent({
    id: "kvv-s4",
    lineId: "S4",
    ptMode: "lightRail",
    lineRef: "kvv:22304:E:H:s26",
    destinationText: "Heilbronn",
  });
  const rhineNeckarS4 = stopEvent({
    id: "ddb-s4",
    lineId: "S4",
    ptMode: "lightRail",
    lineRef: "ddb:920S4:H:H",
    destinationText: "Germersheim",
  });
  const ice = stopEvent({
    id: "ice",
    lineId: "ICE 377",
    ptMode: "longDistanceRail",
    lineRef: "ddb:98012::R",
    destinationText: "Interlaken West",
  });
  const re = stopEvent({
    id: "re",
    lineId: "RE45",
    ptMode: "regionalRail",
    lineRef: "ddb:90RE4:5:H",
    destinationText: "Heilbronn",
  });

  const groups = groupsAt("bruchsal", [ice, rhineNeckarS4, re, kvvS4]);
  assert.deepEqual(
    groups.map(({ id, line }) => [id, line.id]),
    [
      ["S4", "S4"],
      ["S4@ddb:920S4", "S4"],
      ["RE45@ddb:90RE4", "RE45"],
      ["ICE 377@ddb:98012", "ICE 377"],
    ],
  );
});
