import assert from "node:assert/strict";
import test from "node:test";
import { findReadStopPlacePart, getStopPlaceParts } from "../src/lib/stop-place-parts.ts";
import { deriveStopPlaces, getPartNames } from "../src/lib/stop-places.ts";
import type { CatalogStop } from "../src/networks/network-definition.ts";
import { kvvNetwork } from "../src/networks/kvv/kvv-network.ts";
import { stopPlaces } from "../src/networks/kvv/generated/stop-places.ts";
import { transitNetwork } from "../src/data/transit-network.ts";

const findNetworkStop = (stopId: string) => transitNetwork.stops.find(({ id }) => id === stopId);

const stop = (
  globalId: string,
  name: string,
  latitude: number,
  longitude: number,
  placeName = "Karlsruhe",
  callCount = 1,
): CatalogStop => ({ globalId, name, latitude, longitude, placeName, lineCount: 1, callCount });

test("a tunnel and the street above it are one place, named by the busier", () => {
  const places = deriveStopPlaces(
    [
      stop("de:1:37", "Europaplatz", 49.00983, 8.39487, "Karlsruhe", 15),
      stop("de:1:1004", "Europaplatz (U)", 49.01005, 8.39424, "Karlsruhe", 7),
      stop("de:1:39", "Mühlburger Tor", 49.0107, 8.38425),
    ],
    "Karlsruhe",
  );
  assert.deepEqual(places, {
    europaplatz: {
      name: "Europaplatz",
      stopPoints: ["de:1:37", "de:1:1004"],
      parts: ["Oben", "Unten"],
    },
    "muehlburger-tor": { name: "Mühlburger Tor", stopPoints: ["de:1:39"] },
  });
});

test("one name far apart, or in another district, is two places", () => {
  const places = deriveStopPlaces(
    [
      stop("de:1:1", "Rathaus", 49.0, 8.4),
      stop("de:1:2", "Rathaus", 49.01, 8.4),
      stop("de:1:3", "Rathaus", 49.0, 8.4, "Durlach"),
    ],
    "Karlsruhe",
  );
  assert.deepEqual(Object.keys(places), ["durlach-rathaus", "rathaus-1", "rathaus-2"]);
  assert.equal(places["durlach-rathaus"].placeName, "Durlach");
});

test("overrides join, split and pin what the names miss", () => {
  const catalog = [
    stop("de:1:802", "Bahnhof", 49.00185, 8.46262, "Durlach", 9),
    stop("de:1:801", "Karlsruhe-Durlach", 49.00225, 8.46276, "Durlach", 2),
    stop("de:1:90", "Hauptbahnhof", 48.99335, 8.40104),
    stop("de:1:89", "Hauptbahnhof (Vorplatz)", 48.99437, 8.39967),
  ];
  const places = deriveStopPlaces(catalog, "Karlsruhe", {
    joins: [["de:1:802", "de:1:801"]],
    splits: ["de:1:89"],
    slugs: { "de:1:89": "vorplatz" },
    partNames: { "de:1:802": "Bahnhof", "de:1:801": "Straßenbahn" },
    formerNames: { hauptbahnhof: "Bahnhof Karlsruhe" },
  });
  assert.deepEqual(places, {
    "durlach-bahnhof": {
      name: "Bahnhof",
      placeName: "Durlach",
      stopPoints: ["de:1:802", "de:1:801"],
      parts: ["Bahnhof", "Straßenbahn"],
    },
    hauptbahnhof: {
      name: "Hauptbahnhof",
      formerName: "Bahnhof Karlsruhe",
      stopPoints: ["de:1:90"],
    },
    vorplatz: { name: "Hauptbahnhof", stopPoints: ["de:1:89"] },
  });
});

test("an override naming what the catalog no longer has fails the derivation", () => {
  const catalog = [stop("de:1:1", "Rathaus", 49.0, 8.4)];
  assert.throws(
    () => deriveStopPlaces(catalog, "Karlsruhe", { joins: [["de:1:8", "de:1:9"]] }),
    /catalog lacks: de:1:8, de:1:9/,
  );
  assert.throws(
    () => deriveStopPlaces(catalog, "Karlsruhe", { partNames: { "de:1:9": "Unten" } }),
    /catalog lacks: de:1:9/,
  );
  assert.throws(
    () => deriveStopPlaces(catalog, "Karlsruhe", { formerNames: { gone: "Alter Name" } }),
    /no longer exist: gone/,
  );
});

test("two parts the name rule names alike fail the derivation until overridden", () => {
  const catalog = [
    stop("de:1:1", "Bahnhof", 49.0, 8.4),
    stop("de:1:2", "Bahnhof", 49.0001, 8.4001),
  ];
  const joins = [["de:1:1", "de:1:2"]];
  assert.throws(
    () => deriveStopPlaces(catalog, "Karlsruhe", { joins }),
    /bahnhof \(Bahnhof, Bahnhof\)/,
  );
  const places = deriveStopPlaces(catalog, "Karlsruhe", {
    joins,
    partNames: { "de:1:2": "Vorplatz" },
  });
  assert.deepEqual(places.bahnhof.parts, ["Bahnhof", "Vorplatz"]);
});

test("a part is named by the operator's aside, a bare `U` being `Unten`", () => {
  const { marktplatz } = deriveStopPlaces(
    [
      stop("de:1:1003", "Marktplatz (Kaiserstraße U)", 49.00966, 8.40238, "Karlsruhe", 7),
      stop("de:1:1011", "Marktplatz (Pyramide U)", 49.00873, 8.40374, "Karlsruhe", 3),
    ],
    "Karlsruhe",
  );
  assert.deepEqual(marktplatz.parts, ["Kaiserstraße", "Pyramide"]);
});

test("a joined place's parts have names of their own", () => {
  for (const [id, { parts }] of Object.entries(stopPlaces)) {
    if (parts) assert.equal(new Set(parts).size, parts.length, `${id}: ${parts}`);
  }
});

test("the generated stop places are the catalog's, as derived now", () => {
  assert.deepEqual(
    stopPlaces,
    deriveStopPlaces(
      kvvNetwork.stopCatalog,
      kvvNetwork.home.placeName,
      kvvNetwork.stopPlaceOverrides,
    ),
    "run npm run refresh:stop-places",
  );
});

test("a place's parts read `Oben` before `Unten`, whichever is busier", () => {
  const names = (stopId: string) =>
    getStopPlaceParts(findNetworkStop(stopId)).map(({ name }) => name);

  // Europaplatz's street is the busier, Kronenplatz's tunnel.
  assert.deepEqual(names("europaplatz"), ["Oben", "Unten"]);
  assert.deepEqual(names("kronenplatz"), ["Oben", "Unten"]);
  assert.deepEqual(names("marktplatz"), ["Kaiserstraße", "Pyramide"]);
});

test("a remembered part answers only a bare stop address", () => {
  const chosen = { europaplatz: "unten" };
  const read = (address: { partId?: string; lineId?: string; addressId?: string }) =>
    findReadStopPlacePart(
      findNetworkStop("europaplatz"),
      { partId: "", lineId: "", ...address },
      chosen,
    )?.name;

  assert.equal(read({}), "Unten");
  assert.equal(read({ partId: "oben" }), "Oben");
  assert.equal(read({ lineId: "2" }), undefined);
  assert.equal(read({ addressId: "kvv:21002:E:H:s26:12" }), undefined);
  assert.equal(read({ lineId: "2", partId: "oben" }), "Oben");
});

test("a part is named by its aside, and a bare name is `Oben` only beside a tunnel", () => {
  assert.deepEqual(getPartNames(["Europaplatz", "Europaplatz (U)"]), ["Oben", "Unten"]);
  assert.deepEqual(getPartNames(["Marktplatz (Pyramide U)", "Marktplatz"]), ["Pyramide", "Oben"]);
  assert.deepEqual(getPartNames(["Hauptbahnhof", "Hauptbahnhof (tief)"]), ["Hauptbahnhof", "Tief"]);
});
