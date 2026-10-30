import assert from "node:assert/strict";
import test from "node:test";
import type { StopPlace } from "../src/data/transit-types.ts";
import type { Feed, FeedStopSearchResult } from "../src/data/feed.ts";
import type { Bounds } from "../src/data/network-scope.ts";
import { TriasTransitSource } from "../src/data/transit-source.ts";
import { getDistanceMeters } from "../src/lib/geo.ts";
import { getNearbySearchBounds, getNearbyStops } from "../src/lib/nearby-stops.ts";

const createStop = (id: string, latitude?: number, longitude?: number): StopPlace => ({
  id,
  name: id,
  latitude,
  longitude,
});

test("orders locatable stops by distance and excludes remote or unlocated stops", () => {
  const stops = [
    createStop("far", 49.02, 8.4),
    createStop("unlocated"),
    createStop("near", 49.0002, 8.4),
    createStop("nearest", 49.0001, 8.4),
  ];

  assert.deepEqual(
    getNearbyStops(stops, 49, 8.4, 1_000).map(({ stop }) => stop.id),
    ["nearest", "near"],
  );
});

test("caps the result count after distance ordering", () => {
  const stops = [
    createStop("third", 49.0003, 8.4),
    createStop("first", 49.0001, 8.4),
    createStop("second", 49.0002, 8.4),
  ];

  assert.deepEqual(
    getNearbyStops(stops, 49, 8.4, 1_000, 2).map(({ stop }) => stop.id),
    ["first", "second"],
  );
});

test("offers six nearby stops by default", () => {
  const stops = Array.from({ length: 7 }, (_, index) =>
    createStop(String(index), 49 + (index + 1) / 100_000, 8.4),
  );

  assert.equal(getNearbyStops(stops, 49, 8.4, 1_000).length, 6);
});

test("the search area holds every stop in reach and is the same across a grid cell", () => {
  const bounds = getNearbySearchBounds(48.8932, 8.7008);
  for (const edge of Object.values(bounds)) assert.match(String(edge), /^-?\d+(\.\d{1,3})?$/);
  assert.ok(bounds.north - bounds.south <= 0.05 && bounds.east - bounds.west <= 0.05);
  // A step within the cell asks the same area; the position itself is not sent.
  assert.deepEqual(getNearbySearchBounds(48.8941, 8.6996), bounds);

  for (const [latitude, longitude] of [
    [48.8932, 8.7008],
    [48.8949, 8.7024],
    [48.8926, 8.6976],
  ]) {
    const { south, north, west, east } = getNearbySearchBounds(latitude, longitude);
    const corners = [
      [north, longitude],
      [south, longitude],
      [latitude, west],
      [latitude, east],
    ];
    for (const [cornerLatitude, cornerLongitude] of corners) {
      const reach = getDistanceMeters(latitude, longitude, {
        latitude: cornerLatitude,
        longitude: cornerLongitude,
      });
      assert.ok(reach >= 900, `edge only ${Math.round(reach)} m from ${latitude}, ${longitude}`);
    }
  }
});

test("stops around beyond the network register as places, the network's as its own", async () => {
  const marktplatz = { id: "marktplatz", name: "Marktplatz", latitude: 49.0094, longitude: 8.4044 };
  const asked: Bounds[] = [];
  const client = {
    locateStops: async (bounds: Bounds): Promise<FeedStopSearchResult[]> => {
      asked.push(bounds);
      return [
        { stopPointId: "de:08212:1011", name: "Marktplatz", latitude: 49.0091, longitude: 8.4041 },
        { stopPointId: "de:08212:1003", name: "Marktplatz", latitude: 49.0095, longitude: 8.4038 },
        {
          stopPointId: "de:08231:50",
          name: "Hauptbahnhof",
          placeName: "Pforzheim",
          latitude: 48.89398,
          longitude: 8.70325,
        },
        { stopPointId: "de:08231:999", name: "Unverortet", placeName: "Pforzheim" },
      ];
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client, { stops: [marktplatz], lines: [] });
  const bounds = getNearbySearchBounds(48.8932, 8.7008);

  const stops = await source.locateStops(bounds);

  assert.deepEqual(asked, [bounds]);
  assert.deepEqual(
    stops.map(({ id, name, placeName }) => [id, name, placeName]),
    [
      ["marktplatz", "Marktplatz", undefined],
      [stops[1]?.id, "Hauptbahnhof", "Pforzheim"],
    ],
  );
  assert.match(stops[1]?.id ?? "", /^pforzheim-hauptbahnhof--/);
  assert.equal(source.getKnownStop(stops[1]?.id ?? ""), stops[1]);
});
