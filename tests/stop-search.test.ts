import assert from "node:assert/strict";
import test from "node:test";

import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { isWithinKvvArea } from "../src/data/kvv-area.ts";
import { parseStopSearchResponse, type KvvStopSearchResult } from "../src/data/kvv-efa-parsers.ts";
import { KvvTransitSource } from "../src/data/transit-source.ts";
import type { KvvEfaClient as KvvEfaClientType } from "../src/data/kvv-efa-client.ts";
import type { TransitNetwork } from "../src/data/transit-types.ts";

test("the stop search parser reads where a found stop stands", () => {
  const results = parseStopSearchResponse({
    stopFinder: {
      points: [
        { anyType: "loc", name: "Landau", ref: { id: "2500001" } },
        {
          anyType: "stop",
          name: "Karlsruhe, Mühlburg West",
          ref: { id: "7000091", place: "Karlsruhe", coords: "8.350730,49.020297" },
        },
        { anyType: "stop", name: "Ohne Position", ref: { id: "7000992", place: "Irgendwo" } },
        {
          anyType: "stop",
          name: "Verdorbene Koordinaten",
          ref: { id: "7000993", place: "Irgendwo", coords: "keine,zahlen" },
        },
      ],
    },
  });

  assert.deepEqual(results, [
    {
      providerId: "7000091",
      name: "Mühlburg West",
      placeName: "Karlsruhe",
      latitude: 49.020297,
      longitude: 8.35073,
    },
    { providerId: "7000992", name: "Ohne Position", placeName: "Irgendwo" },
    { providerId: "7000993", name: "Verdorbene Koordinaten", placeName: "Irgendwo" },
  ]);
});

test("the stop search asks the feed to answer in WGS84", async () => {
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    stopSearchEndpoint: "https://example.test/XSLT_STOPFINDER_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ stopFinder: { points: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.searchStops("Mühlburg");

  assert.equal(requestedUrl?.searchParams.get("type_sf"), "any");
  assert.equal(requestedUrl?.searchParams.get("name_sf"), "Mühlburg");
  assert.equal(requestedUrl?.searchParams.get("coordOutputFormat"), "WGS84[DD.ddddd]");
});

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
    assert.equal(isWithinKvvArea(latitude, longitude), true, `${name} should be inside`);
  }
  for (const [name, latitude, longitude] of outside) {
    assert.equal(isWithinKvvArea(latitude, longitude), false, `${name} should be outside`);
  }
});

const network: TransitNetwork = {
  stops: [
    {
      id: "muhlburg",
      name: "Mühlburg",
      alias: "Karlsruhe-Mühlburg",
      latitude: 49.0146,
      longitude: 8.3511,
    },
    { id: "europaplatz", name: "Europaplatz", latitude: 49.0093, longitude: 8.3653 },
  ],
  lines: [],
};

const clientWith = (matches: KvvStopSearchResult[]): KvvEfaClientType =>
  ({ searchStops: async () => matches }) as unknown as KvvEfaClientType;

test("the search answers with local matches first and keeps only in-area provider matches", async () => {
  const source = new KvvTransitSource(
    clientWith([
      {
        providerId: "2000991",
        name: "Zum Mühlberg",
        placeName: "Rotenburg a. d. Fulda",
        latitude: 50.9954,
        longitude: 9.7398,
      },
      {
        providerId: "7000091",
        name: "Mühlburg West",
        placeName: "Karlsruhe",
        latitude: 49.020297,
        longitude: 8.35073,
      },
      { providerId: "7000992", name: "Ohne Position", placeName: "Karlsruhe" },
    ]),
    network,
  );

  const results = await source.searchStops("mühlburg");

  assert.deepEqual(results, [
    {
      id: "muhlburg",
      name: "Mühlburg",
      alias: "Karlsruhe-Mühlburg",
      latitude: 49.0146,
      longitude: 8.3511,
    },
    {
      id: results[1].id,
      name: "Mühlburg West",
      alias: "Karlsruhe",
      latitude: 49.020297,
      longitude: 8.35073,
    },
  ]);
});

test("a search for what only the provider knows outside the area answers nothing", async () => {
  const source = new KvvTransitSource(
    clientWith([
      {
        providerId: "2000991",
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
  const source = new KvvTransitSource(failing as unknown as KvvEfaClientType, network);

  assert.deepEqual(await source.searchStops("mühlburg"), [network.stops[0]]);
});

test("a failed provider read without local matches stays a failed search", async () => {
  const failing = {
    searchStops: async () => {
      throw new Error("offline");
    },
  };
  const source = new KvvTransitSource(failing as unknown as KvvEfaClientType, network);

  await assert.rejects(source.searchStops("schloss"));
});

test("a stop the session has already met is answered without another wait", async () => {
  // A view that has to await an answer it already holds renders the not-knowing first, and for a
  // rider walking along a line diagram that was the whole shell blanking between two of its stops.
  const source = new KvvTransitSource(
    clientWith([{ providerId: "7000992", name: "Ohne Position", placeName: "Karlsruhe" }]),
    network,
  );

  assert.equal(source.getKnownStop("europaplatz")?.name, "Europaplatz");
  // Not yet met is not the same claim as not existing — that stays `resolveStop`'s to answer.
  assert.equal(source.getKnownStop("ohne-position"), undefined);

  const resolved = await source.resolveStop("ohne-position");
  assert.ok(resolved);
  assert.equal(source.getKnownStop(resolved.id)?.id, resolved.id);
});

test("a search that matched exactly one stop is read, not dropped", () => {
  // The finder lists its points when it found several and wraps the one point in an object when it
  // found one. Reading only the list shape lost every search that succeeded outright — and that is
  // the search a deep link performs: a stop whose name matches nothing else could then not be
  // resolved by the one query that names it precisely, and the whole address failed with it.
  const results = parseStopSearchResponse({
    stopFinder: {
      points: {
        point: {
          anyType: "stop",
          name: "Öhringen, Öhringen Hbf",
          ref: { id: "5410220", place: "Öhringen", coords: "9.502280,49.203248" },
        },
      },
    },
  });

  assert.deepEqual(results, [
    {
      providerId: "5410220",
      name: "Öhringen Hbf",
      placeName: "Öhringen",
      longitude: 9.50228,
      latitude: 49.203248,
    },
  ]);
});

test("a stop the session has never met is resolved from the id in a shared link", () => {
  // The digest in the id says which stop point the link was made from, so only that one will do.
  const client = {
    searchStops: async (): Promise<KvvStopSearchResult[]> => [
      { providerId: "5419603", name: "Öhringen West", placeName: "Öhringen" },
      { providerId: "5410220", name: "Öhringen Hbf", placeName: "Öhringen" },
    ],
  } as unknown as KvvEfaClientType;
  const source = new KvvTransitSource(client, { stops: [], lines: [] } as TransitNetwork);

  return source.resolveStop("oehringen-hbf--1lmhxmn").then((stop) => {
    assert.equal(stop?.id, "oehringen-hbf--1lmhxmn");
    assert.equal(stop?.name, "Öhringen Hbf");
  });
});
