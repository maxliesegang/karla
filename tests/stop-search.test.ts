import assert from "node:assert/strict";
import test from "node:test";

import { isWithinScopeBounds } from "../src/data/network-scope.ts";
import { kvvNetwork } from "../src/networks/kvv/kvv-network.ts";
import type { Feed, FeedStopSearchResult } from "../src/data/feed.ts";
import { TriasTransitSource } from "../src/data/transit-source.ts";
import { hashStopPointId } from "../src/data/stop-registry.ts";
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

test("the search answers with local matches first and keeps only in-area provider matches", async () => {
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
  ]);
});

test("a search for what only the provider knows outside the area answers nothing", async () => {
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

  assert.deepEqual(await source.searchStops("schloss"), []);
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
