import assert from "node:assert/strict";
import test from "node:test";

import { isWithinScopeBounds } from "../src/data/network-scope.ts";
import { kvvNetwork } from "../src/networks/kvv/kvv-network.ts";
import type { Feed, FeedStopSearchResult } from "../src/data/feed.ts";
import { TriasTransitSource } from "../src/data/transit-source.ts";
import { hashStopPointId, StopRegistry } from "../src/data/stop-registry.ts";
import type { TransitNetwork } from "../src/data/transit-types.ts";

test("the KVV area box keeps the network's far corners and excludes the neighbours", () => {
  const inside: [string, number, number][] = [
    ["Karlsruhe Hbf", 48.9933, 8.4012],
    ["Renchen, the district's southernmost stop", 48.5776, 8.0752],
    ["Achern in the Rastatt district", 48.6334, 8.0711],
    ["Lingenfeld in the Germersheim district", 49.2554, 8.3356],
    ["Dahn in the Südliche Weinstraße", 49.2035, 7.7875],
    ["Mühlacker at the Enzkreis edge", 48.9971, 8.8651],
    ["Lauterbourg, the rail line into France", 48.9753, 8.2294],
  ];
  const outside: [string, number, number][] = [
    ["Offenburg in the Ortenau", 48.4728, 7.9295],
    ["Speyer, already VRN", 49.3175, 8.4354],
    ["Stuttgart", 48.7758, 9.1829],
    ["Pirmasens", 49.2037, 7.6016],
    ["Ravensburg", 47.7826, 9.6006],
    ["Duisburg", 51.5222, 6.774],
  ];

  for (const [name, latitude, longitude] of inside) {
    assert.equal(
      isWithinScopeBounds(kvvNetwork.scope, latitude, longitude),
      true,
      `${name} should be inside`,
    );
  }
  for (const [name, latitude, longitude] of outside) {
    assert.equal(
      isWithinScopeBounds(kvvNetwork.scope, latitude, longitude),
      false,
      `${name} should be outside`,
    );
  }
});

const network: TransitNetwork = {
  stops: [
    {
      id: "muhlburg",
      name: "Mühlburg",
      placeName: "Karlsruhe-Mühlburg",
      latitude: 49.0146,
      longitude: 8.3511,
    },
    { id: "europaplatz", name: "Europaplatz", latitude: 49.0093, longitude: 8.3653 },
  ],
  lines: [],
};

const clientWith = (matches: FeedStopSearchResult[]): Feed =>
  ({ searchStops: async () => matches }) as unknown as Feed;

test("a link with an unmatched digest cannot resolve to another stop with the same name", async () => {
  const source = new TriasTransitSource(
    clientWith([{ stopPointId: "de:08235:9711", name: "Bahnhof", placeName: "Anderer Ort" }]),
    { stops: [], lines: [] },
  );
  assert.equal(await source.resolveStop("bahnhof--wrongdigest"), undefined);
  assert.equal(source.getKnownStop("bahnhof--wrongdigest"), undefined);
});

test("a link naming a stop without its digest does not resolve", async () => {
  const source = new TriasTransitSource(clientWith([{ stopPointId: "1", name: "Bahnhof" }]), {
    stops: [],
    lines: [],
  });
  assert.equal(await source.resolveStop("bahnhof"), undefined);
});

test("the search answers with local matches, then provider matches in the area, then beyond", async () => {
  const source = new TriasTransitSource(
    clientWith([
      {
        stopPointId: "2000991",
        name: "Zum Mühlberg",
        placeName: "Rotenburg a. d. Fulda",
        latitude: 50.9954,
        longitude: 9.7398,
      },
      {
        stopPointId: "de:08212:91",
        name: "Mühlburg West",
        placeName: "Karlsruhe",
        latitude: 49.020297,
        longitude: 8.35073,
      },
      { stopPointId: "de:08212:992", name: "Ohne Position", placeName: "Karlsruhe" },
    ]),
    network,
  );

  const results = await source.searchStops("mühlburg");

  assert.deepEqual(results, [
    {
      id: "muhlburg",
      name: "Mühlburg",
      placeName: "Karlsruhe-Mühlburg",
      latitude: 49.0146,
      longitude: 8.3511,
    },
    {
      id: results[1].id,
      name: "Mühlburg West",
      placeName: "Karlsruhe",
      latitude: 49.020297,
      longitude: 8.35073,
    },
    {
      id: results[2].id,
      name: "Zum Mühlberg",
      placeName: "Rotenburg a. d. Fulda",
      latitude: 50.9954,
      longitude: 9.7398,
    },
  ]);
});

test("a search finds stops beyond the network's area", async () => {
  const source = new TriasTransitSource(
    clientWith([
      {
        stopPointId: "2000991",
        name: "Schloss",
        placeName: "Ravensburg",
        latitude: 47.7826,
        longitude: 9.6006,
      },
    ]),
    network,
  );

  assert.deepEqual(
    (await source.searchStops("schloss")).map(({ name, placeName }) => [name, placeName]),
    [["Schloss", "Ravensburg"]],
  );
});

test("a provider read that failed still answers with the local matches", async () => {
  const failing = {
    searchStops: async () => {
      throw new Error("offline");
    },
  };
  const source = new TriasTransitSource(failing as unknown as Feed, network);

  assert.deepEqual(await source.searchStops("mühlburg"), [network.stops[0]]);
});

test("a failed provider read without local matches stays a failed search", async () => {
  const failing = {
    searchStops: async () => {
      throw new Error("offline");
    },
  };
  const source = new TriasTransitSource(failing as unknown as Feed, network);

  await assert.rejects(source.searchStops("schloss"));
});

test("a stop the session has already met is answered without another wait", async () => {
  // A view that has to await an answer it already holds renders the not-knowing first, and for a
  // rider walking along a line diagram that was the whole shell blanking between two of its stops.
  const source = new TriasTransitSource(
    clientWith([{ stopPointId: "de:08212:992", name: "Ohne Position", placeName: "Karlsruhe" }]),
    network,
  );

  assert.equal(source.getKnownStop("europaplatz")?.name, "Europaplatz");
  // Not yet met is not the same claim as not existing — that stays `resolveStop`'s to answer.
  const stopId = `ohne-position--${hashStopPointId("de:08212:992")}`;
  assert.equal(source.getKnownStop(stopId), undefined);

  const resolved = await source.resolveStop(stopId);
  assert.ok(resolved);
  assert.equal(source.getKnownStop(resolved.id)?.id, resolved.id);
});

test("a provider stop with a stable local id never gains a dynamic duplicate", async () => {
  const kongresszentrum = {
    id: "kongresszentrum",
    name: "Kongresszentrum",
    latitude: 49.002532,
    longitude: 8.403165,
  };
  const source = new TriasTransitSource(
    clientWith([
      {
        stopPointId: "de:08212:1013",
        name: "Kongresszentrum (U)",
        placeName: "Karlsruhe",
        latitude: 49.002532,
        longitude: 8.403165,
      },
    ]),
    { stops: [kongresszentrum], lines: [] },
  );

  // The local and provider results are the same stop, so search offers one route rather than a
  // canonical entry beside a dynamic duplicate.
  assert.deepEqual(await source.searchStops("Kongresszentrum"), [kongresszentrum]);

  // Old shared links still resolve, but their answer is the stable identity. The selection chain
  // writes this id back into the address and uses it for the board and its calling sequences.
  const resolved = await source.resolveStop("kongresszentrum-u--1o924sc");
  assert.equal(resolved?.id, "kongresszentrum");
  assert.equal(source.getKnownStop("kongresszentrum-u--1o924sc"), undefined);
});

test("a stop the session has never met is resolved from the id in a shared link", () => {
  // The digest in the id says which stop point the link was made from, so only that one will do.
  const client = {
    searchStops: async (): Promise<FeedStopSearchResult[]> => [
      { stopPointId: "5419603", name: "Öhringen West", placeName: "Öhringen" },
      { stopPointId: "5410220", name: "Öhringen Hbf", placeName: "Öhringen" },
    ],
  } as unknown as Feed;
  const source = new TriasTransitSource(client, { stops: [], lines: [] } as TransitNetwork);

  return source.resolveStop("oehringen-hbf--1lmhxmn").then((stop) => {
    assert.equal(stop?.id, "oehringen-hbf--1lmhxmn");
    assert.equal(stop?.name, "Öhringen Hbf");
  });
});

test("local matches rank by how well they match, then by how busy the stop is", async () => {
  const stops = [
    { id: "am-heegwald", name: "Am Heegwald", placeName: "Durlach" },
    { id: "durlach-bahnhof", name: "Bahnhof", placeName: "Durlach" },
    { id: "durlacher-tor", name: "Durlacher Tor" },
    { id: "durlach-turmberg", name: "Turmberg", placeName: "Durlach" },
  ];
  const source = new TriasTransitSource(clientWith([]), {
    stops,
    lines: [],
    callCountByStopId: new Map([
      ["am-heegwald", 10],
      ["durlach-bahnhof", 900],
      ["durlacher-tor", 2000],
      ["durlach-turmberg", 300],
    ]),
  });

  // The name's start before the district's, and among the district's the busiest first.
  assert.deepEqual(
    (await source.searchStops("durlach")).map(({ id }) => id),
    ["durlacher-tor", "durlach-bahnhof", "durlach-turmberg", "am-heegwald"],
  );
  assert.deepEqual(
    (await source.searchStops("durlach bahnhof")).map(({ id }) => id),
    ["durlach-bahnhof"],
  );
  // The home municipality is a word of every home stop.
  assert.deepEqual(
    (await source.searchStops("karlsruhe durlacher")).map(({ id }) => id),
    ["durlacher-tor"],
  );
});

test("many local matches leave rows for stops beyond the catalog", async () => {
  const stops = Array.from({ length: 12 }, (_, index) => ({
    id: `schlossplatz-${index}`,
    name: `Schlossplatz ${index}`,
  }));
  const source = new TriasTransitSource(
    clientWith([
      {
        stopPointId: "de:08111:6022",
        name: "Schlossplatz",
        placeName: "Stuttgart",
        latitude: 48.7784,
        longitude: 9.1794,
      },
    ]),
    { stops, lines: [] },
  );

  const results = await source.searchStops("schlossplatz");
  assert.equal(results.length, 8);
  assert.ok(results.some(({ placeName }) => placeName === "Stuttgart"));
});

const stuttgartHbf: FeedStopSearchResult[] = [
  {
    stopPointId: "de:08111:6115",
    name: "Hauptbahnhof",
    placeName: "Stuttgart",
    latitude: 48.78413,
    longitude: 9.18177,
  },
  // 262 m from the first, so joined only through the next, as the provider lists them.
  {
    stopPointId: "de:08111:6118",
    name: "Hauptbahnhof (tief)",
    placeName: "Stuttgart",
    latitude: 48.78339,
    longitude: 9.18023,
  },
  {
    stopPointId: "de:08111:6112",
    name: "Hauptbahnhof (A.-Klett-Platz)",
    placeName: "Stuttgart",
    latitude: 48.78316,
    longitude: 9.18112,
  },
  // 420 m north, its own place, as the catalog would have it.
  {
    stopPointId: "de:08111:6110",
    name: "Hauptbahnhof (Pariser Platz)",
    placeName: "Stuttgart",
    latitude: 48.78848,
    longitude: 9.18248,
  },
];

test("a place's stop points beyond the catalog are one search result, under the town's name", async () => {
  const source = new TriasTransitSource(clientWith(stuttgartHbf), { stops: [], lines: [] });

  const [stop, ...rest] = await source.searchStops("stuttgart hbf");
  assert.deepEqual(
    rest.map(({ name }) => name),
    ["Hauptbahnhof (Pariser Platz)"],
  );
  assert.equal(stop.name, "Hauptbahnhof");
  assert.equal(stop.placeName, "Stuttgart");
  assert.equal(stop.id, `stuttgart-hauptbahnhof--${hashStopPointId("de:08111:6115")}`);
});

test("a link to a joined place beyond the catalog resolves to the whole place", async () => {
  // A fresh session: the link's slug is the query, and its town is what finds the place.
  const queries: string[] = [];
  const client = {
    searchStops: async (query: string) => {
      queries.push(query);
      return [...stuttgartHbf].reverse();
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client, { stops: [], lines: [] });
  const stopId = `stuttgart-hauptbahnhof--${hashStopPointId("de:08111:6115")}`;

  const stop = await source.resolveStop(stopId);
  assert.deepEqual(queries, ["stuttgart hauptbahnhof"]);
  assert.equal(stop?.id, stopId);
  assert.equal(stop?.name, "Hauptbahnhof");
});

test("a joined place beyond the catalog reads every stop point, and a call at any lands on it", () => {
  const registry = new StopRegistry([]);
  const [first, ...joined] = stuttgartHbf.slice(0, 3).map(({ stopPointId }) => stopPointId);
  const stop = registry.register({
    stopPointId: first,
    joinedStopPointIds: joined,
    name: "Hauptbahnhof",
    placeName: "Stuttgart",
  });

  assert.deepEqual(registry.findStopPoints(stop.id), [first, ...joined]);
  for (const stopPointId of [first, ...joined]) {
    assert.equal(registry.findStopPlaceId(stopPointId), stop.id);
  }
  // Met again through one of its other stop points, it is the same place.
  assert.equal(
    registry.register({ stopPointId: joined[1], name: "Hauptbahnhof (A.-Klett-Platz)" }),
    stop,
  );
});

test("a stop first met through a call becomes the whole place once a search joins it", () => {
  const registry = new StopRegistry([]);
  const [called] = registry.toCalls([
    {
      stopPointId: "de:08111:6118",
      stopName: "Hauptbahnhof (tief)",
      placeName: "Stuttgart",
      latitude: 48.78339,
      longitude: 9.18023,
    } as never,
  ]);

  // As search registers the place: its first stop point, and the others beside it.
  const stop = registry.register({
    stopPointId: "de:08111:6115",
    joinedStopPointIds: ["de:08111:6118", "de:08111:6112"],
    name: "Hauptbahnhof",
    placeName: "Stuttgart",
  });
  assert.equal(stop.id, called.stopPlaceId);
  assert.equal(stop.name, "Hauptbahnhof");
  assert.deepEqual(registry.findStopPoints(stop.id), [
    "de:08111:6118",
    "de:08111:6115",
    "de:08111:6112",
  ]);
  assert.equal(registry.findStopPlaceId("de:08111:6112"), stop.id);
});

test("a joined place ranks by the name it is shown under, not its first stop point's", async () => {
  const source = new TriasTransitSource(clientWith([...stuttgartHbf].reverse()), {
    stops: [],
    lines: [],
  });

  const names = (await source.searchStops("stuttgart hauptbahnhof")).map(({ name }) => name);
  assert.deepEqual(names, ["Hauptbahnhof", "Hauptbahnhof (Pariser Platz)"]);
});
