/**
 * Regenerates the build network's `generated/line-colors.ts`: its own lines' `route_color` from the
 * operator's GTFS, and other operators' colours from the community list, kept to the operators of
 * the network's `operatorAreas`.
 *
 *     npm run refresh:line-colors
 *
 * Requires `unzip`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { squashLineName } from "../src/lib/line-colors.ts";
import type { PtMode } from "../src/data/transit-types.ts";
import { network } from "../src/networks/network.ts";
import { downloadGtfsArchive, readFields, readTable, selectColumns } from "./gtfs-archive.ts";

const { gtfs, community } = network.lineColorSource;
const outputPath = new URL(
  `../src/networks/${network.id}/generated/line-colors.ts`,
  import.meta.url,
);

/** GTFS `route_type` as the feed's modes: tram, rail as `lightRail`, the rest bus. */
const toPtMode = (routeType: string): PtMode =>
  routeType === "0" ? "tram" : routeType === "1" || routeType === "2" ? "lightRail" : "bus";

async function main(): Promise<void> {
  const workingDirectory = await mkdtemp(join(tmpdir(), "karla-colors-"));
  try {
    const archivePath = join(workingDirectory, "gtfs.zip");
    const feedVersion = await downloadGtfsArchive(gtfs.url, archivePath);
    const homeColors = await readHomeColors(archivePath);
    console.log(
      `GTFS: ${Object.keys(homeColors).length} line colours, feed version ${feedVersion}`,
    );

    const otherColors = await readOtherColors();
    console.log(`Community: ${Object.keys(otherColors).length} other line names`);

    const sources = [
      `// Own lines: ${gtfs.publisher}, ${gtfs.licence}, feed version ${feedVersion}, ${gtfs.url}`,
      `// Other lines: ${community.publisher}, ${community.licence}, ${community.url}`,
    ].join("\n");
    await writeFile(outputPath, renderModule(homeColors, otherColors, sources), "utf8");
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

/** `#rrggbb` from a GTFS or community colour, which may lack the `#`. */
const toHex = (color: string | undefined): string | undefined =>
  color ? `#${color.replace(/^#/, "").toLowerCase()}` : undefined;

type HomeColor = [color: string, textColor?: string];

/** By name, or by `name|mode` where one name has a colour per mode (`E`: tram red, rail green). */
async function readHomeColors(archivePath: string): Promise<Record<string, HomeColor>> {
  const countsByName = new Map<string, Map<PtMode, Map<string, number>>>();
  for await (const [name, routeType, color, textColor] of readTable(archivePath, "routes.txt", [
    "route_short_name",
    "route_type",
    "route_color",
    "route_text_color",
  ])) {
    if (!name || !routeType || !color) continue;
    const byMode = countsByName.get(name) ?? new Map<PtMode, Map<string, number>>();
    const counts = byMode.get(toPtMode(routeType)) ?? new Map<string, number>();
    const pair = JSON.stringify([toHex(color), toHex(textColor)].filter(Boolean));
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
    byMode.set(toPtMode(routeType), counts);
    countsByName.set(name, byMode);
  }

  const colors: Record<string, HomeColor> = {};
  for (const [name, byMode] of [...countsByName].sort(([a], [b]) => a.localeCompare(b))) {
    // A mode's colour is its most common; a name with one colour across modes needs no mode.
    const colorByMode = new Map(
      [...byMode].map(([mode, counts]) => [mode, [...counts].sort(([, a], [, b]) => b - a)[0][0]]),
    );
    const distinct = new Set(colorByMode.values());
    if (distinct.size === 1) colors[name] = JSON.parse([...distinct][0]);
    else for (const [mode, pair] of colorByMode) colors[`${name}|${mode}`] = JSON.parse(pair);
  }
  return colors;
}

type OtherColor = [color: string, areaIndex: number, textColor?: string];

async function readOtherColors(): Promise<Record<string, OtherColor[]>> {
  const response = await fetch(community.url);
  if (!response.ok) throw new Error(`Community colours: HTTP ${response.status}`);
  const lines = (await response.text())
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => readFields(line));
  const rows = selectColumns(
    lines,
    ["shortOperatorName", "lineName", "backgroundColor", "textColor"],
    "Community colours",
  );

  const colors: Record<string, OtherColor[]> = {};
  for await (const [operator = "", name, backgroundColor, textColor] of rows) {
    const color = toHex(backgroundColor);
    const ink = toHex(textColor);
    const areaIndex = network.operatorAreas.findIndex(({ operators }) =>
      operators.some((prefix) => operator.startsWith(prefix)),
    );
    // The network's own lines take its operator's colours; a white sign has no badge colour.
    if (!name || !color || color === "#ffffff" || areaIndex === -1) continue;
    if (network.operatorAreas[areaIndex].isHome) continue;
    const key = squashLineName(name);
    const entries = colors[key] ?? [];
    if (!entries.some(([known, area]) => known === color && area === areaIndex))
      entries.push(ink ? [color, areaIndex, ink] : [color, areaIndex]);
    colors[key] = entries;
  }
  return Object.fromEntries(Object.entries(colors).sort(([a], [b]) => a.localeCompare(b)));
}

function renderModule(
  homeColors: Record<string, HomeColor>,
  otherColors: Record<string, OtherColor[]>,
  sources: string,
): string {
  const home = Object.entries(homeColors)
    .map(([name, color]) => `  ${JSON.stringify(name)}: ${JSON.stringify(color)},`)
    .join("\n");
  const other = Object.entries(otherColors)
    .map(([name, entries]) => `  ${JSON.stringify(name)}: ${JSON.stringify(entries)},`)
    .join("\n");
  return `// Generated by scripts/refresh-line-colors.ts — do not edit by hand.
//
${sources}
//
// Refresh with: npm run refresh:line-colors

import type { HomeLineColors, OtherLineColors } from "../../network-definition";

/** The network's lines' colours and text colours by name, or by \`name|mode\` where a name has one per mode. */
export const homeLineColors: HomeLineColors = {
${home}
};

/** Other operators' colours by name without spaces, each with its operator area's index and text colour. */
export const otherLineColors: OtherLineColors = {
${other}
};
`;
}

await main();
