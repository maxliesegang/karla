import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { updateStopCorridorPatterns } from "../src/lib/stop-corridor-patterns.ts";
import { getStopServiceCorridorLineGroups } from "../src/lib/stop-corridors.ts";

function departure(
  overrides: Partial<Departure> & Pick<Departure, "id" | "destination">,
): Departure {
  return {
    tripId: overrides.id,
    lineId: "2",
    transportMode: "tram",
    minutesUntilDeparture: 4,
    platformCode: "1",
    boardingLocalStopId: "europaplatz",
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

/** The grouping as a rider first sees it: one reading of the detailed boards, nothing remembered. */
const groupsAt = (
  stopId: string,
  live: readonly Departure[],
  topologyDepartures: readonly Departure[] = [],
) =>
  getStopServiceCorridorLineGroups(
    live,
    updateStopCorridorPatterns(null, stopId, topologyDepartures),
  );

test("does not merge S1 and S11 even when they share a destination", () => {
  const s1 = departure({ id: "s1", lineId: "S1", destination: "Hochstetten" });
  const s11 = departure({ id: "s11", lineId: "S11", destination: "Hochstetten" });

  const groups = groupsAt("europaplatz", [s1, s11], []);
  assert.deepEqual(
    groups.map(({ id }) => id),
    ["S1", "S11"],
  );
});

test("keeps two detailed patterns separate even when their destination is the same", () => {
  const direct = departure({
    id: "direct",
    destination: "Durlach",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = departure({
    id: "branch",
    destination: "Durlach",
    tripCalls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  const corridors = groupsAt("europaplatz", [direct, branch], [direct, branch])[0].corridors;
  assert.equal(corridors.length, 2);
  // Both end at Durlach, so naming the place twice would tell a rider nothing: the rows fall back
  // to the stops the two trips actually part at.
  assert.deepEqual(
    corridors.map(({ directionLabel }) => directionLabel),
    ["Hauptbahnhof", "Marktplatz"],
  );
  // Each row was observed along a full route of its own, so both may claim a shared way.
  assert.equal(
    corridors.every(({ hasObservedSharedRoute }) => hasObservedSharedRoute),
    true,
  );
});

test("a corridor matched only over its first link may not claim a shared route", () => {
  const live = [
    departure({ id: "first", routeDirectionId: "dir", destination: "First end" }),
    departure({ id: "second", routeDirectionId: "dir", destination: "Second end" }),
  ];
  const earlier = departure({
    id: "earlier",
    routeDirectionId: "dir",
    destination: "Earlier end",
    tripCalls: calls("Europaplatz", "Marktplatz", "Earlier end"),
  });
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [earlier]);

  const corridor = getStopServiceCorridorLineGroups(live, patterns)[0].corridors[0];
  // The two live trips share the direction's outgoing link, so they group — but nothing was
  // observed beyond that link, so the row may not claim that its destinations share a way.
  assert.equal(corridor.hasObservedTopology, true);
  assert.equal(corridor.hasObservedSharedRoute, false);
});

test("groups short workings with through trips over their shared outgoing corridor", () => {
  const live = [
    departure({
      id: "stadt",
      lineId: "S1",
      destination: "Ettlingen Stadt",
    }),
    departure({
      id: "albgaubad",
      lineId: "S1",
      destination: "Ettlingen Albgaubad",
    }),
    departure({
      id: "hoch",
      lineId: "S1",
      destination: "Hochstetten",
    }),
  ];
  const topologyDepartures = [
    departure({
      ...live[0],
      tripCalls: [
        {
          stopName: "Ostendorfplatz",
          localStopId: "europaplatz",
          isCurrentStop: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Tulpenstraße", localStopId: "tulpenstrasse", placeName: "Karlsruhe" },
        { stopName: "Battstraße", localStopId: "battstrasse", placeName: "Karlsruhe" },
        { stopName: "Stadt", localStopId: "ettlingen-stadt", placeName: "Ettlingen" },
      ],
    }),
    departure({
      ...live[1],
      tripCalls: [
        {
          stopName: "Ostendorfplatz",
          localStopId: "europaplatz",
          isCurrentStop: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Tulpenstraße", localStopId: "tulpenstrasse", placeName: "Karlsruhe" },
        { stopName: "Battstraße", localStopId: "battstrasse", placeName: "Karlsruhe" },
        { stopName: "Stadt", localStopId: "ettlingen-stadt", placeName: "Ettlingen" },
        { stopName: "Albgaubad", localStopId: "albgaubad", placeName: "Ettlingen" },
      ],
    }),
    departure({
      ...live[2],
      tripCalls: [
        {
          stopName: "Ostendorfplatz",
          localStopId: "europaplatz",
          isCurrentStop: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Schloss Rüppurr", localStopId: "schloss-rueppurr", placeName: "Karlsruhe" },
        {
          stopName: "Hochstetten",
          localStopId: "hochstetten",
          placeName: "Linkenheim-Hochstetten",
        },
      ],
    }),
  ];
  const groups = groupsAt("europaplatz", live, topologyDepartures);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].corridors.length, 2);
  const southbound = groups[0].corridors.find(
    ({ directionLabel }) => directionLabel === "Ettlingen",
  );
  assert.deepEqual(
    southbound?.departures.map(({ destination }) => destination),
    ["Ettlingen Stadt", "Ettlingen Albgaubad"],
  );
  // Both trips were read along their full routes and the routes chain, so the row — whose two
  // headsigns end in the one place — may say that they share the way.
  assert.equal(southbound?.hasObservedSharedRoute, true);
});

test("colliding corridors are named by where their trips part, and the unread row keeps its headsign", () => {
  const live = [
    departure({ id: "direct", destination: "Hauptbahnhof", tripId: "direct" }),
    departure({ id: "branch", destination: "Hauptbahnhof", tripId: "branch" }),
    departure({ id: "unread", destination: "Hauptbahnhof", tripId: "unread" }),
  ];
  const topologyDepartures = [
    departure({ ...live[0], tripCalls: calls("Europaplatz", "Marktplatz", "Hauptbahnhof") }),
    departure({ ...live[1], tripCalls: calls("Europaplatz", "Kongresszentrum", "Hauptbahnhof") }),
  ];

  const labels = groupsAt("europaplatz", live, topologyDepartures)[0].corridors.map(
    ({ directionLabel }) => directionLabel,
  );
  // Three rows headed into the same place: the two observed ones fall back to the stops they part
  // at, and the unread one has no stop to fall back to — its headsign is the only name it has.
  assert.deepEqual(labels, ["Hauptbahnhof", "Kongresszentrum", "Marktplatz"]);
  assert.equal(new Set(labels).size, 3);
});

test("matches an unseen headsign through the feed's unambiguous line direction", () => {
  const live = [
    departure({
      id: "forbach",
      lineId: "S8",
      routeDirectionId: "kvv:22308:E:H:s26",
      destination: "Forbach",
    }),
    departure({
      id: "freudenstadt",
      lineId: "S8",
      routeDirectionId: "kvv:22308:E:H:s26",
      destination: "Freudenstadt Hbf",
    }),
    departure({
      id: "bondorf",
      lineId: "S8",
      routeDirectionId: "kvv:22308:E:H:s26",
      destination: "Bondorf",
    }),
    departure({
      id: "tulla",
      lineId: "S8",
      routeDirectionId: "kvv:22308:E:R:s26",
      destination: "Tullastraße",
    }),
  ];
  const topologyDepartures = [
    departure({ ...live[0], tripCalls: calls("Europaplatz", "Poststraße", "Forbach") }),
    departure({
      ...live[2],
      tripCalls: calls("Europaplatz", "Poststraße", "Forbach", "Freudenstadt", "Bondorf"),
    }),
    departure({ ...live[3], tripCalls: calls("Europaplatz", "Kongresszentrum", "Tullastraße") }),
  ];

  const corridors = groupsAt("europaplatz", live, topologyDepartures)[0].corridors;
  const outbound = corridors.find(({ destinations }) => destinations.includes("Forbach"));
  assert.ok(outbound);
  assert.deepEqual(outbound.destinations, ["Forbach", "Freudenstadt Hbf", "Bondorf"]);
  assert.equal(outbound.departures.length, 3);
  assert.equal(corridors.length, 2);
});

test("does not infer a direction when its observed trips leave by competing links", () => {
  const later = departure({
    id: "later",
    routeDirectionId: "same-direction",
    destination: "Unknown end",
  });
  const first = departure({
    id: "first",
    routeDirectionId: "same-direction",
    destination: "First end",
    tripCalls: calls("Europaplatz", "Marktplatz", "First end"),
  });
  const second = departure({
    id: "second",
    routeDirectionId: "same-direction",
    destination: "Second end",
    tripCalls: calls("Europaplatz", "Hauptbahnhof", "Second end"),
  });

  const corridor = groupsAt("europaplatz", [later], [first, second])[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, false);
});

test("collapses calls outside the board's municipality to the place they are in", () => {
  const live = departure({
    id: "live",
    lineId: "S2",
    destination: "Rheinstetten",
    tripId: "rheinstetten",
  });
  const observed = departure({
    ...live,
    tripCalls: [
      {
        stopName: "Europaplatz",
        localStopId: "europaplatz",
        isCurrentStop: true,
        placeName: "Karlsruhe",
      },
      { stopName: "Bahnhof", localStopId: "kar-bahnhof", placeName: "Karlsruhe" },
      { stopName: "Silberstreifen", localStopId: "silberstreifen", placeName: "Rheinstetten" },
      { stopName: "Mörscher Straße", localStopId: "moerscher-strasse", placeName: "Rheinstetten" },
      { stopName: "Bahnhof", localStopId: "rheinstetten-bahnhof", placeName: "Rheinstetten" },
    ],
  });

  const corridor = groupsAt("europaplatz", [live], [observed])[0].corridors[0];
  // The headsign is `Rheinstetten Bahnhof`; the direction is the place it is in.
  assert.equal(corridor.directionLabel, "Rheinstetten");
});

test("names a Karlsruhe district the way it names a municipality", () => {
  // EFA answers `Durlach` and `Rüppurr` in the same field it answers `Ettlingen` in, and plain
  // `Karlsruhe` for the inner city — so a district is a direction and the city centre is not.
  const live = departure({
    id: "live",
    lineId: "1",
    destination: "Durlach Turmberg",
    tripId: "turmberg",
  });
  const observed = departure({
    ...live,
    tripCalls: [
      {
        stopName: "Europaplatz",
        localStopId: "europaplatz",
        isCurrentStop: true,
        placeName: "Karlsruhe",
      },
      { stopName: "Kronenplatz", localStopId: "kronenplatz", placeName: "Karlsruhe" },
      { stopName: "Turmberg", localStopId: "turmberg", placeName: "Durlach" },
    ],
  });
  const inbound = departure({
    id: "inbound",
    lineId: "1",
    destination: "Hauptbahnhof",
    tripId: "hbf",
  });
  const observedInbound = departure({
    ...inbound,
    tripCalls: [
      {
        stopName: "Europaplatz",
        localStopId: "europaplatz",
        isCurrentStop: true,
        placeName: "Karlsruhe",
      },
      { stopName: "Hauptbahnhof", localStopId: "hauptbahnhof", placeName: "Karlsruhe" },
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
    departure({ id: "stadt", lineId: "S1", destination: "Ettlingen Stadt", tripId: "stadt" }),
    departure({ id: "herrenalb", lineId: "S1", destination: "Bad Herrenalb", tripId: "herrenalb" }),
  ];
  const shared: TripCall[] = [
    {
      stopName: "Europaplatz",
      localStopId: "europaplatz",
      isCurrentStop: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Rüppurr Ostendorfplatz", localStopId: "ostendorfplatz", placeName: "Rüppurr" },
    { stopName: "Stadt", localStopId: "ettlingen-stadt", placeName: "Ettlingen" },
  ];
  const topologyDepartures = [
    departure({ ...live[0], tripCalls: shared }),
    departure({
      ...live[1],
      tripCalls: [
        ...shared,
        { stopName: "Busenbach", localStopId: "busenbach", placeName: "Busenbach (Waldbr.)" },
        { stopName: "Bad Herrenalb", localStopId: "bad-herrenalb", placeName: "Bad Herrenalb" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyDepartures)[0].corridors[0];
  assert.equal(corridor.departures.length, 2);
  assert.equal(corridor.directionLabel, "Ettlingen");
  assert.deepEqual(
    corridor.places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Ettlingen", isTerminus: true },
      { label: "Bad Herrenalb", isTerminus: true },
    ],
  );
});

test("does not chain two ends the trips genuinely part for", () => {
  const live = [
    departure({ id: "west", lineId: "2", destination: "Knielingen Nord", tripId: "west" }),
    departure({ id: "north", lineId: "2", destination: "Neureut Heide", tripId: "north" }),
  ];
  const topologyDepartures = [
    departure({ ...live[0], tripCalls: calls("Europaplatz", "Entenfang", "Knielingen Nord") }),
    departure({ ...live[1], tripCalls: calls("Europaplatz", "Entenfang", "Neureut Heide") }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyDepartures)[0].corridors[0];
  assert.deepEqual(corridor.places, []);
  // The last point they still share is all the row may claim.
  assert.equal(corridor.directionLabel, "Entenfang");
});

test("states an end again where the way returns to a place it named before", () => {
  // The old chain dropped any place it had named once: an end that lies back behind a further one
  // vanished from the row, and the rider read one end fewer than the corridor has.
  const live = [
    departure({ id: "near", lineId: "S1", destination: "Ettlingen", tripId: "near" }),
    departure({ id: "through", lineId: "S1", destination: "Malsch", tripId: "through" }),
    departure({ id: "back", lineId: "S1", destination: "Ettlingen", tripId: "back" }),
  ];
  const head: TripCall[] = [
    {
      stopName: "Europaplatz",
      localStopId: "europaplatz",
      isCurrentStop: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Ettlingen", localStopId: "ettlingen", placeName: "Ettlingen" },
  ];
  const topologyDepartures = [
    departure({ ...live[0], tripCalls: head }),
    departure({
      ...live[1],
      tripCalls: [...head, { stopName: "Malsch", localStopId: "malsch", placeName: "Malsch" }],
    }),
    departure({
      ...live[2],
      tripCalls: [
        ...head,
        { stopName: "Malsch", localStopId: "malsch", placeName: "Malsch" },
        { stopName: "Ettlingen Erbprinz", localStopId: "erbprinz", placeName: "Ettlingen" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyDepartures)[0].corridors[0];
  // Three ends, two of them in Ettlingen: both are the rider's business, so both are stated.
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
    departure({ id: "stadt", lineId: "S1", destination: "Ettlingen Stadt", tripId: "stadt" }),
    departure({ id: "herrenalb", lineId: "S1", destination: "Bad Herrenalb", tripId: "herrenalb" }),
  ];
  const head: TripCall[] = [
    {
      stopName: "Europaplatz",
      localStopId: "europaplatz",
      isCurrentStop: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Ostendorfplatz", localStopId: "ostendorfplatz", placeName: "Rüppurr" },
    { stopName: "Rüppurrer Straße", localStopId: "rueppurrer-strasse", placeName: "Rüppurr" },
  ];
  const topologyDepartures = [
    departure({
      ...live[0],
      tripCalls: [
        ...head,
        { stopName: "Stadt", localStopId: "ettlingen-stadt", placeName: "Ettlingen" },
      ],
    }),
    departure({
      ...live[1],
      tripCalls: [
        ...head,
        { stopName: "Stadt", localStopId: "ettlingen-stadt", placeName: "Ettlingen" },
        { stopName: "Busenbach", localStopId: "busenbach", placeName: "Busenbach (Waldbr.)" },
        { stopName: "Bad Herrenalb", localStopId: "bad-herrenalb", placeName: "Bad Herrenalb" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyDepartures)[0].corridors[0];
  // Rüppurr is where the line runs stop after stop, so the chain sketches it; Busenbach is passed
  // once and served by nothing else, so it stands back. The ends keep their places in the walk.
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
    departure({ id: "through", lineId: "S1", destination: "Ettlingen Stadt", tripId: "through" }),
  ];
  const topologyDepartures = [
    departure({
      ...live[0],
      tripCalls: [
        {
          stopName: "Europaplatz",
          localStopId: "europaplatz",
          isCurrentStop: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Ostendorfplatz", localStopId: "ostendorfplatz", placeName: "Rüppurr" },
        { stopName: "Rüppurrer Straße", localStopId: "rueppurrer-strasse", placeName: "Rüppurr" },
        { stopName: "Malsch", localStopId: "malsch", placeName: "Malsch" },
        { stopName: "Stadt", localStopId: "ettlingen-stadt", placeName: "Ettlingen" },
      ],
    }),
    // A bus line through Malsch, read at a post the trip never passes: the connection is observed
    // wherever the reading comes from.
    departure({
      id: "bus",
      lineId: "216",
      destination: "Malsch",
      boardingLocalStopId: "muggensturm",
      tripCalls: [
        {
          stopName: "Muggensturm",
          localStopId: "muggensturm",
          isCurrentStop: true,
          placeName: "Muggensturm",
        },
        { stopName: "Malsch", localStopId: "malsch", placeName: "Malsch" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyDepartures)[0].corridors[0];
  // Malsch is called once, but the bus makes it a place to change at: it outranks Rüppurr, which
  // the route serves twice and nothing else serves at all. Both keep their places in the walk.
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
  const live = [departure({ id: "through", lineId: "S1", destination: "Ettlingen Stadt" })];
  const topologyDepartures = [
    departure({
      ...live[0],
      tripCalls: [
        {
          stopName: "Europaplatz",
          localStopId: "europaplatz",
          isCurrentStop: true,
          placeName: "Karlsruhe",
        },
        { stopName: "Bulach", localStopId: "bulach", placeName: "Bulach" },
        { stopName: "Battstraße", localStopId: "battstrasse", placeName: "Bulach" },
        { stopName: "Ostendorfplatz", localStopId: "ostendorfplatz", placeName: "Rüppurr" },
        { stopName: "Rüppurrer Straße", localStopId: "rueppurrer-strasse", placeName: "Rüppurr" },
        { stopName: "Schloss Rüppurr", localStopId: "schloss-rueppurr", placeName: "Rüppurr" },
        { stopName: "Malsch", localStopId: "malsch", placeName: "Malsch" },
        { stopName: "Stadt", localStopId: "ettlingen-stadt", placeName: "Ettlingen" },
      ],
    }),
    // A bus through Malsch: the one place along this way another line connects at.
    departure({
      id: "bus",
      lineId: "216",
      destination: "Malsch",
      boardingLocalStopId: "muggensturm",
      tripCalls: [
        {
          stopName: "Muggensturm",
          localStopId: "muggensturm",
          isCurrentStop: true,
          placeName: "Muggensturm",
        },
        { stopName: "Malsch", localStopId: "malsch", placeName: "Malsch" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyDepartures)[0].corridors[0];
  // Bulach, Rüppurr and Malsch are all prominent, but three places is the whole row: the end takes
  // one, and the two the way keeps are Malsch, where the bus connects, and Rüppurr, which the route
  // winds through stop after stop — Bulach, passed twice and served by nothing else, stands down.
  assert.deepEqual(
    corridor.places.map(({ label, isTerminus }) => ({ label, isTerminus })),
    [
      { label: "Rüppurr", isTerminus: false },
      { label: "Malsch", isTerminus: false },
      { label: "Ettlingen", isTerminus: true },
    ],
  );
  // The ranks left are a run from the most prominent down, so a narrow row still stands the least
  // useful of them down first.
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
    departure({ id: "rueppurr", lineId: "S1", destination: "Rüppurr", tripId: "rueppurr" }),
    departure({ id: "stadt", lineId: "S1", destination: "Ettlingen Stadt", tripId: "stadt" }),
    departure({ id: "herrenalb", lineId: "S1", destination: "Bad Herrenalb", tripId: "herrenalb" }),
    departure({ id: "ittersbach", lineId: "S1", destination: "Ittersbach", tripId: "ittersbach" }),
  ];
  const head: TripCall[] = [
    {
      stopName: "Europaplatz",
      localStopId: "europaplatz",
      isCurrentStop: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Ostendorfplatz", localStopId: "ostendorfplatz", placeName: "Rüppurr" },
    { stopName: "Rüppurrer Straße", localStopId: "rueppurrer-strasse", placeName: "Rüppurr" },
  ];
  const toEttlingen: TripCall[] = [
    ...head,
    { stopName: "Stadt", localStopId: "ettlingen-stadt", placeName: "Ettlingen" },
  ];
  const toHerrenalb: TripCall[] = [
    ...toEttlingen,
    { stopName: "Busenbach", localStopId: "busenbach", placeName: "Busenbach (Waldbr.)" },
    { stopName: "Bad Herrenalb", localStopId: "bad-herrenalb", placeName: "Bad Herrenalb" },
  ];
  const topologyDepartures = [
    departure({ ...live[0], tripCalls: head }),
    departure({ ...live[1], tripCalls: toEttlingen }),
    departure({ ...live[2], tripCalls: toHerrenalb }),
    departure({
      ...live[3],
      tripCalls: [
        ...toHerrenalb,
        { stopName: "Ittersbach", localStopId: "ittersbach", placeName: "Karlsbad" },
      ],
    }),
  ];

  const corridor = groupsAt("europaplatz", live, topologyDepartures)[0].corridors[0];
  // Four ends: every one is a place a rider picks between, so every one is stated — and they leave
  // no room for the way's own places, prominent though Rüppurr's several stops would make it.
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

test("does not apply an observed corridor to a diverted live trip", () => {
  const diverted = departure({
    id: "diverted",
    lineId: "S1",
    destination: "Ettlingen Albgaubad",
    tripId: "de:kvv:00S01_:.kvv-22-301-E.5.T0.169.s26",
    status: "diverted",
  });
  const observed = departure({
    ...diverted,
    status: "realtime",
    tripCalls: calls("Europaplatz", "Tulpenstraße", "Ettlingen Stadt", "Ettlingen Albgaubad"),
  });

  const corridor = groupsAt("europaplatz", [diverted], [observed])[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, false);
});

test("groups exceptional short and through trips by their own observed corridor", () => {
  const short = departure({
    id: "daxlanden",
    lineId: "3",
    destination: "Daxlanden über Hbf",
    tripId: "daxlanden",
    serviceNote: "Umleitung",
  });
  const through = departure({
    id: "rappenwoert",
    lineId: "3",
    destination: "Rappenwört über Hbf",
    tripId: "rappenwoert",
    serviceNote: "Umleitung",
  });
  const opposite = departure({
    id: "rintheim",
    lineId: "3",
    destination: "Rintheim",
    tripId: "rintheim",
  });
  const laterShort = departure({ ...short, id: "later-daxlanden", tripId: "later-daxlanden" });
  const laterThrough = departure({
    ...through,
    id: "later-rappenwoert",
    tripId: "later-rappenwoert",
  });
  // EFA exposes the stop complex as two consecutive calling points. The second Hauptfriedhof is
  // still the stop the rider is standing at, not a shared outgoing link between both directions.
  const shared = calls(
    "Hauptfriedhof",
    "Hauptfriedhof",
    "Karl-Wilhelm-Platz",
    "Hauptbahnhof",
    "Waidweg",
  );
  const topologyDepartures = [
    departure({ ...short, tripCalls: shared }),
    departure({ ...through, tripCalls: [...shared, ...calls("Altrheinbrücke", "Rappenwört")] }),
    departure({
      ...opposite,
      tripCalls: calls("Hauptfriedhof", "Hauptfriedhof", "Dunantstraße", "Rintheim"),
    }),
  ];

  const corridors = groupsAt(
    "hauptfriedhof",
    [short, through, laterShort, laterThrough, opposite],
    topologyDepartures,
  )[0].corridors;
  assert.equal(corridors.length, 2);
  const corridor = corridors.find(({ destinations }) =>
    destinations.includes("Daxlanden über Hbf"),
  );
  assert.ok(corridor);
  assert.equal(corridor.departures.length, 4);
  assert.equal(corridor.hasObservedTopology, true);
  assert.deepEqual(corridor.destinations, ["Daxlanden über Hbf", "Rappenwört über Hbf"]);
});

test("does not reuse an ambiguous line and destination pattern", () => {
  const live = departure({ id: "later", destination: "Durlach", tripId: "later" });
  const direct = departure({
    id: "direct",
    destination: "Durlach",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = departure({
    id: "branch",
    destination: "Durlach",
    tripCalls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  const corridor = groupsAt("europaplatz", [live], [direct, branch])[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, false);
});

test("does not reuse an ambiguous exceptional pattern", () => {
  const later = departure({
    id: "later",
    destination: "Durlach",
    tripId: "later",
    serviceNote: "Umleitung",
  });
  const direct = departure({
    id: "direct",
    destination: "Durlach",
    tripId: "direct",
    serviceNote: "Umleitung",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = departure({
    id: "branch",
    destination: "Durlach",
    tripId: "branch",
    serviceNote: "Umleitung",
    tripCalls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  const corridor = groupsAt("europaplatz", [later], [direct, branch])[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, false);
});
test("keeps grouping a trip after the board that showed its route has been refreshed away", () => {
  const stadt = departure({
    id: "stadt",
    lineId: "S1",
    destination: "Ettlingen Stadt",
    tripId: "stadt",
  });
  const herrenalb = departure({
    id: "herrenalb",
    lineId: "S1",
    destination: "Bad Herrenalb",
    tripId: "herrenalb",
  });
  const learned = updateStopCorridorPatterns(null, "europaplatz", [
    departure({ ...stadt, tripCalls: calls("Europaplatz", "Ostendorfplatz", "Ettlingen Stadt") }),
    departure({ ...herrenalb, tripCalls: calls("Europaplatz", "Ostendorfplatz", "Bad Herrenalb") }),
  ]);

  // The next refresh of the light board carries no calling sequences at all, and the detailed
  // boards have moved on to later trips. What was observed once still relates these two.
  const kept = updateStopCorridorPatterns(learned, "europaplatz", []);
  const corridor = getStopServiceCorridorLineGroups([stadt, herrenalb], kept)[0].corridors[0];

  assert.equal(corridor.departures.length, 2);
  assert.equal(corridor.hasObservedTopology, true);
  assert.equal(corridor.directionLabel, "Ostendorfplatz");
});

test("a route learned once covers a later trip the detailed boards never reached", () => {
  const learned = updateStopCorridorPatterns(null, "europaplatz", [
    departure({
      id: "read",
      destination: "Durlach",
      tripId: "read",
      tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
    }),
  ]);
  const later = departure({ id: "later", destination: "Durlach", tripId: "later" });

  const corridor = getStopServiceCorridorLineGroups([later], learned)[0].corridors[0];
  assert.equal(corridor.hasObservedTopology, true);
});

test("one oddly reported run does not withdraw the route the line is known to take", () => {
  const usual = Array.from({ length: 6 }, (_, index) =>
    departure({
      id: `usual-${index}`,
      destination: "Durlach",
      tripId: `usual-${index}`,
      tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
    }),
  );
  const odd = departure({
    id: "odd",
    destination: "Durlach",
    tripId: "odd",
    tripCalls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [...usual, odd]);
  const later = departure({ id: "later", destination: "Durlach", tripId: "later" });

  const corridors = getStopServiceCorridorLineGroups([later], patterns)[0].corridors;
  assert.equal(corridors[0].hasObservedTopology, true);
  // Grouped over the link the line is actually known to take out of the stop.
  assert.ok(corridors[0].id.endsWith("observed:marktplatz"));
});

test("counts trips rather than readings, so one board re-read cannot outvote the others", () => {
  const branch = departure({
    id: "branch",
    destination: "Durlach",
    tripId: "branch",
    tripCalls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });
  const direct = departure({
    id: "direct",
    destination: "Durlach",
    tripId: "direct",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });

  // The same two trips read four times over, as a board on a ninety-second cadence delivers them.
  let patterns = updateStopCorridorPatterns(null, "europaplatz", [branch, direct]);
  for (let reading = 0; reading < 3; reading += 1) {
    patterns = updateStopCorridorPatterns(patterns, "europaplatz", [branch, branch, direct]);
  }
  const later = departure({ id: "later", destination: "Durlach", tripId: "later" });

  // Two trips, two routes: still one each, so neither may speak for a trip nothing is known about.
  assert.equal(
    getStopServiceCorridorLineGroups([later], patterns)[0].corridors[0].hasObservedTopology,
    false,
  );
});

test("trips whose route is unknown share the row their headsign names", () => {
  const unread = [
    departure({ id: "first", destination: "Durlach Turmberg", tripId: "first" }),
    departure({ id: "second", destination: "Durlach Turmberg", tripId: "second" }),
  ];

  const corridors = groupsAt("europaplatz", unread)[0].corridors;
  assert.equal(corridors.length, 1);
  assert.equal(corridors[0].departures.length, 2);
  assert.equal(corridors[0].directionLabel, "Durlach Turmberg");
  assert.equal(corridors[0].hasObservedTopology, false);
});

test("exceptional trips describe themselves but do not teach later trips", () => {
  const route = calls("Europaplatz", "Hauptbahnhof", "Rheinstetten");
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [
    departure({
      id: "diverted",
      destination: "Rheinstetten",
      tripId: "a",
      status: "diverted",
      tripCalls: route,
    }),
    departure({
      id: "sev",
      destination: "Rheinstetten",
      tripId: "b",
      serviceNote: "Ersatzverkehr",
      tripCalls: route,
    }),
  ]);
  const later = departure({ id: "later", destination: "Rheinstetten", tripId: "later" });

  const current = getStopServiceCorridorLineGroups(
    [departure({ id: "diverted", destination: "Rheinstetten", tripId: "a", status: "diverted" })],
    patterns,
  )[0].corridors[0];
  assert.equal(current.hasObservedTopology, true);
  assert.equal(
    getStopServiceCorridorLineGroups([later], patterns)[0].corridors[0].hasObservedTopology,
    false,
  );
});

test("a refresh that taught nothing is not a change, and another stop starts over", () => {
  const observed = departure({
    id: "observed",
    destination: "Durlach",
    tripId: "observed",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [observed]);

  assert.equal(updateStopCorridorPatterns(patterns, "europaplatz", [observed]), patterns);
  // The routes are stated relative to the stop they were read at, so none of them carries over.
  const elsewhere = updateStopCorridorPatterns(patterns, "marktplatz", []);
  assert.equal(elsewhere.byTripKey.size, 0);
});

test("two boards disagreeing about one trip still settle on a single reading", () => {
  // The stop's own detailed board and an observation post both see this trip, and they do not agree
  // about what it calls at after here. Last-write-wins made the two readings overwrite each other on
  // every pass, so a repeated reading kept producing a new memory and the caller — which sets state
  // whenever the memory changes — re-rendered without end.
  const ownReading = departure({
    id: "own",
    destination: "Durlach",
    tripId: "shared",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const postReading = departure({
    id: "post",
    destination: "Durlach",
    tripId: "shared",
    tripCalls: calls("Europaplatz", "Marktplatz"),
  });

  const learned = updateStopCorridorPatterns(null, "europaplatz", [ownReading, postReading]);
  // Reading the very same boards again taught nothing, whichever order they are held in.
  assert.equal(
    updateStopCorridorPatterns(learned, "europaplatz", [ownReading, postReading]),
    learned,
  );
  assert.equal(updateStopCorridorPatterns(learned, "europaplatz", [ownReading]), learned);
  // The stop's own board leads the list, so its fuller reading is the one that was kept.
  assert.equal(learned.byTripKey.size, 1);
  assert.deepEqual(
    [...learned.byTripKey.values()][0].map((call) => call.stopName),
    ["Marktplatz", "Durlach"],
  );
});

test("reuses route indexes when a reading only learns the board's place", () => {
  const observed = departure({
    id: "observed",
    destination: "Durlach",
    tripId: "observed",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const patterns = updateStopCorridorPatterns(null, "europaplatz", [observed]);
  const withPlace = updateStopCorridorPatterns(patterns, "europaplatz", [
    departure({
      id: "place",
      destination: "Durlach",
      tripCalls: [
        {
          stopName: "Europaplatz",
          localStopId: "europaplatz",
          isCurrentStop: true,
          placeName: "Karlsruhe",
        },
      ],
    }),
  ]);

  assert.equal(withPlace.boardPlaceName, "Karlsruhe");
  assert.equal(withPlace.byTripKey, patterns.byTripKey);
  assert.equal(withPlace.byLineDestination, patterns.byLineDestination);
});

test("forgets the runs that passed longest ago rather than growing without end", () => {
  const observations = Array.from({ length: 5 }, (_, index) =>
    departure({
      id: `trip-${index}`,
      destination: "Durlach",
      tripId: `trip-${index}`,
      tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
    }),
  );
  const patterns = updateStopCorridorPatterns(null, "europaplatz", observations, 3);

  assert.deepEqual([...patterns.byTripKey.keys()], ["trip-2", "trip-3", "trip-4"]);
  // The line's own pattern is what the trimmed entries were evidence for, and it stays.
  const later = departure({ id: "later", destination: "Durlach", tripId: "later" });
  assert.equal(
    getStopServiceCorridorLineGroups([later], patterns)[0].corridors[0].hasObservedTopology,
    true,
  );
});

test("a trip that turns back is not parted from the service that runs on through it", () => {
  // A terminating trip is reported at the platform it arrives on and again at the one it leaves
  // from, which is one call of the route stated twice: at Gottesauer Platz the S2's Reitschulschlag
  // working reads `Reitschulschlag > Reitschulschlag` where its Spöck service reads
  // `Reitschulschlag > Büchig`. Both calls must remain published while the topology comparison
  // still recognizes that this is the short working of the through route.
  const live = [
    departure({ id: "spoeck", lineId: "S2", destination: "Spöck", tripId: "spoeck" }),
    departure({ id: "short", lineId: "S2", destination: "Reitschulschlag", tripId: "short" }),
  ];
  const shared: TripCall[] = [
    {
      stopName: "Europaplatz",
      localStopId: "europaplatz",
      isCurrentStop: true,
      placeName: "Karlsruhe",
    },
    { stopName: "Reitschulschlag", localStopId: "reitschulschlag", placeName: "Hagsfeld" },
  ];
  const topologyDepartures = [
    departure({
      ...live[0],
      tripCalls: [
        ...shared,
        { stopName: "Büchig", localStopId: "buechig", placeName: "Büchig" },
        { stopName: "Hochhaus", localStopId: "spoeck-hochhaus", placeName: "Spöck" },
      ],
    }),
    departure({
      ...live[1],
      // The reversal: the same stop again, on the platform the vehicle leaves from.
      tripCalls: [...shared, { ...shared[1], platformLabel: "Gleis 3" }],
    }),
  ];

  const corridors = groupsAt("europaplatz", live, topologyDepartures)[0].corridors;
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
  // `Friedrichstal` is Stutensee's on the S2 and Baiersbronn's, seventy kilometres up the Murg
  // valley, on the S8. Held by name alone the Murg valley's reads as an interchange with the S2.
  const stutensee = { latitude: 49.109, longitude: 8.476 };
  const murgtal = { latitude: 48.482, longitude: 8.377 };
  const here: TripCall = {
    stopName: "Europaplatz",
    localStopId: "europaplatz",
    isCurrentStop: true,
    placeName: "Karlsruhe",
  };
  const murgtalLine = departure({
    id: "s8",
    lineId: "S8",
    destination: "Freudenstadt Hbf",
    tripId: "s8",
    tripCalls: [
      here,
      {
        stopName: "Bahnhof",
        localStopId: "murgtal-friedrichstal",
        placeName: "Friedrichstal",
        ...murgtal,
      },
      { stopName: "Hauptbahnhof", localStopId: "freudenstadt-hbf", placeName: "Freudenstadt" },
    ],
  });
  const namesake = (position: typeof stutensee) =>
    departure({
      id: "s2",
      lineId: "S2",
      destination: "Spöck",
      tripId: "s2",
      tripCalls: [
        here,
        {
          stopName: "Mitte",
          localStopId: "friedrichstal-mitte",
          placeName: "Friedrichstal",
          ...position,
        },
        { stopName: "Hochhaus", localStopId: "spoeck-hochhaus", placeName: "Spöck" },
      ],
    });
  const wayOfS8 = (other: Departure) =>
    groupsAt("europaplatz", [murgtalLine], [murgtalLine, other])[0].corridors[0].places.map(
      ({ label }) => label,
    );

  // The S2's Friedrichstal is not this one, and one call is not a place the way winds through.
  assert.deepEqual(wayOfS8(namesake(stutensee)), ["Freudenstadt"]);
  // A line seen at the same place on the ground is the connection that makes it worth naming.
  assert.deepEqual(wayOfS8(namesake(murgtal)), ["Friedrichstal", "Freudenstadt"]);
});
