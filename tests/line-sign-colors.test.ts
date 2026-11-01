import assert from "node:assert/strict";
import test from "node:test";
import {
  colorDistance,
  contrastRatio,
  getLineColors,
  getPlanLineTone,
  needsLineOutline,
} from "../src/lib/line-sign-colors.ts";
import { homeLineColors, otherLineColors } from "../src/networks/kvv/generated/line-colors.ts";

const paper = "#e9ebe5";

/** The pressed row's tint, as CSS mixes it: 27% of the colour over white. */
const rowTint = (color: string): string =>
  `#${[1, 3, 5]
    .map((offset) =>
      Math.round(Number.parseInt(color.slice(offset, offset + 2), 16) * 0.27 + 255 * 0.73)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

const publishedPairs = (): [string, string | undefined][] => [
  ...Object.values(homeLineColors).map(([color, textColor]): [string, string | undefined] => [
    color,
    textColor,
  ]),
  ...Object.values(otherLineColors).flatMap((entries) =>
    entries.map(([color, , textColor]): [string, string | undefined] => [color, textColor]),
  ),
];

/** Eight steps of each channel: 512 colours across the cube. */
const sweep = (): string[] => {
  const steps = Array.from({ length: 8 }, (_, index) =>
    Math.round((index * 255) / 7)
      .toString(16)
      .padStart(2, "0"),
  );
  return steps.flatMap((red) =>
    steps.flatMap((green) => steps.map((blue) => `#${red}${green}${blue}`)),
  );
};

test("every published and swept colour gets a sign pair and a text tone at 4.5:1, tints included", () => {
  const cases: [string, string | undefined][] = [
    ...publishedPairs(),
    ...sweep().flatMap((color): [string, string | undefined][] => [
      [color, undefined],
      [color, "#ffffff"],
      [color, "#000000"],
    ]),
  ];
  for (const [color, textColor] of cases) {
    const colors = getLineColors(color, textColor);
    const label = `${color} / ${textColor ?? "none"}`;
    assert.ok(contrastRatio(colors.signColor, colors.signInk) >= 4.5, label);
    assert.ok(contrastRatio(colors.textTone, paper) >= 4.5, label);
    assert.ok(contrastRatio(colors.textTone, rowTint(colors.signColor)) >= 4.5, label);
    assert.ok(colorDistance(color, colors.signColor) <= 8, label);
  }
});

test("a fill shifts only to keep the published ink, and never far", () => {
  const { signColor, signInk } = getLineColors("#00975f", "#ffffff");
  assert.equal(signInk, "#ffffff");
  assert.ok(colorDistance("#00975f", signColor) < 5);
  assert.deepEqual(getLineColors("#0069b9", "#ffffff"), {
    color: "#0069b9",
    signColor: "#0069b9",
    signInk: "#ffffff",
    textTone: "#005baa",
  });
});

test("without a published ink, the sign takes the one that needs the smaller shift", () => {
  assert.equal(getLineColors("#ffed00").signInk, "#102c2c");
  assert.equal(getLineColors("#312362").signInk, "#ffffff");
  assert.equal(getLineColors("#e30613").signInk, "#ffffff");
});

test("text tone darkens a pale line just enough and leaves a dark one alone", () => {
  const { textTone } = getLineColors("#ffed00", "#000000");
  assert.ok(contrastRatio(textTone, paper) >= 4.5);
  assert.ok(contrastRatio(textTone, paper) < 4.7);
  assert.equal(getLineColors("#a31546").textTone, "#a31546");
});

test("line graphics under 3:1 on white are outlined", () => {
  for (const color of [
    "#ffed00",
    "#ffcc00",
    "#c7d300",
    "#b3b3b3",
    "#f39b9a",
    "#0abaee",
    "#86bc24",
    "#f39200",
  ]) {
    assert.equal(needsLineOutline(color), true, color);
  }
  for (const color of [
    "#e30613",
    "#0069b9",
    "#966c29",
    "#00975f",
    "#009993",
    "#008cb5",
    "#6e682c",
  ]) {
    assert.equal(needsLineOutline(color), false, color);
  }
});

test("the plan's tone darkens only colours under 3:1, to 3:1", () => {
  assert.equal(getPlanLineTone("#0069b9"), undefined);
  for (const color of ["#ffed00", "#ffcc00", "#c7d300", "#0abaee"]) {
    const tone = getPlanLineTone(color);
    assert.ok(tone && !needsLineOutline(tone), color);
    assert.notEqual(tone, color);
  }
});
