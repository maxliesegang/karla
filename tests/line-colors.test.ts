import assert from "node:assert/strict";
import test from "node:test";
import { createLineSign } from "../src/data/line-signs.ts";
import { findOtherLineColor, squashLineName } from "../src/lib/line-colors.ts";
import type { OperatorArea } from "../src/networks/network-definition.ts";

const areas: OperatorArea[] = [
  { operators: ["home-"], districts: ["de:08212", "de:08215"], isHome: true },
  { operators: ["north-"], districts: ["de:08221", "de:08222", "de:07334"] },
  { operators: ["east-"], districts: ["de:08111", "de:08119"] },
  { operators: ["state-"], districts: ["de:08"] },
];
const sources = {
  areas,
  colors: {
    S3: [
      ["#fddd04", 1],
      ["#f36e31", 2],
    ],
    RE2: [
      ["#0069b4", 3],
      ["#1575c5", 1],
    ],
  } as const,
  getHomeColor: (lineId: string) => (lineId === "S52" ? "#f39b9a" : undefined),
  homeDistrict: "de:08212",
};

test("a line name is one name with or without its space", () => {
  assert.equal(squashLineName("RE 1"), squashLineName("RE1"));
});

test("lines of one name take the colour of the operator whose area holds the journey's ends", () => {
  assert.equal(findOtherLineColor("S3", ["de:07334:1714", "de:08221:1160"], sources), "#fddd04");
  assert.equal(findOtherLineColor("S3", ["de:08111:6118", "de:08119:7000"], sources), "#f36e31");
  // The home municipality says nothing about which operator runs the line.
  assert.equal(findOtherLineColor("S3", ["de:08212:90", "de:08221:1160"], sources), "#fddd04");
  // A named district outweighs a state-wide operator.
  assert.equal(findOtherLineColor("RE2", ["de:08212:90", "de:08222:2417"], sources), "#1575c5");
  assert.equal(findOtherLineColor("RE2", ["de:08212:90", "de:08311:6508"], sources), "#0069b4");
});

test("ends in no known area, or no source for the name, leave the line uncoloured", () => {
  assert.equal(findOtherLineColor("S3", ["de:09162:1", "de:09162:2"], sources), undefined);
  assert.equal(findOtherLineColor("S3", [], sources), undefined);
  assert.equal(findOtherLineColor("RB99", ["de:08221:1160"], sources), undefined);
});

test("the network's own operator's line under another pool keeps the network's colour", () => {
  assert.equal(findOtherLineColor("S52", ["de:08212:89", "de:08215:1"], sources), "#f39b9a");
});

test("other operators' lines are coloured from the generated table by their journey's ends", () => {
  const rhineNeckarS3 = createLineSign("S3", "lightRail", "ddb:920S3:D:R", [
    "de:07334:1714",
    "de:08221:1160",
  ]);
  const stuttgartS3 = createLineSign("S3", "lightRail", "ddb:920S3:B:H", [
    "de:08111:6118",
    "de:08119:7000",
  ]);
  assert.equal(rhineNeckarS3.color, "#fddd04");
  assert.equal(stuttgartS3.color, "#f36e31");
  // A long-distance train has no community colour.
  assert.equal(
    createLineSign("ICE 377", "longDistanceRail", "ddb:98012::R", ["de:11000:1", "ch:1:sloid"])
      .color,
    "#3a3a3a",
  );
  // KVV's S4 keeps KVV's colour, whatever another operator's S4 looks like.
  assert.equal(createLineSign("S4", "lightRail", "kvv:22304:E:H:s26").color, "#a31546");
});
