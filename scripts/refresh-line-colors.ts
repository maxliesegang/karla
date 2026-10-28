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

/** By name, or by `name|mode` where one name has a colour per mode (`E`: tram red, rail green). */
async function readHomeColors(archivePath: string): Promise<Record<string, string>> {
  const countsByName = new Map<string, Map<PtMode, Map<string, number>>>();
  for await (const [name, routeType, color] of readTable(archivePath, "routes.txt", [
    "route_short_name",
    "route_type",
    "route_color",
  ])) {
    if (!name || !routeType || !color) continue;
    const byMode = countsByName.get(name) ?? new Map<PtMode, Map<string, number>>();
    const counts = byMode.get(toPtMode(routeType)) ?? new Map<string, number>();
    const hex = `#${color.toLowerCase()}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
    byMode.set(toPtMode(routeType), counts);
    countsByName.set(name, byMode);
  }

  const colors: Record<string, string> = {};
  for (const [name, byMode] of [...countsByName].sort(([a], [b]) => a.localeCompare(b))) {
    // A mode's colour is its most common; a name with one colour across modes needs no mode.
    const colorByMode = new Map(
      [...byMode].map(([mode, counts]) => [mode, [...counts].sort(([, a], [, b]) => b - a)[0][0]]),
    );
    const distinct = new Set(colorByMode.values());
    if (distinct.size === 1) colors[name] = [...distinct][0];
    else for (const [mode, color] of colorByMode) colors[`${name}|${mode}`] = color;
  }
  return colors;
}

async function readOtherColors(): Promise<Record<string, [string, number][]>> {
  const response = await fetch(community.url);
  if (!response.ok) throw new Error(`Community colours: HTTP ${response.status}`);
  const lines = (await response.text())
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => readFields(line));
  const rows = selectColumns(
    lines,
    ["shortOperatorName", "lineName", "backgroundColor"],
    "Community colours",
  );

  const colors: Record<string, [string, number][]> = {};
  for await (const [operator = "", name, backgroundColor] of rows) {
    const color = backgroundColor?.toLowerCase();
    const areaIndex = network.operatorAreas.findIndex(({ operators }) =>
      operators.some((prefix) => operator.startsWith(prefix)),
    );
    // The network's own lines take its operator's colours; a white sign has no badge colour.
    if (!name || !color || color === "#ffffff" || areaIndex === -1) continue;
    if (network.operatorAreas[areaIndex].isHome) continue;
    const key = squashLineName(name);
    const entries = colors[key] ?? [];
    if (!entries.some(([known, area]) => known === color && area === areaIndex))
      entries.push([color, areaIndex]);
    colors[key] = entries;
  }
  return Object.fromEntries(Object.entries(colors).sort(([a], [b]) => a.localeCompare(b)));
}

function renderModule(
  homeColors: Record<string, string>,
  otherColors: Record<string, [string, number][]>,
  sources: string,
): string {
  const home = Object.entries(homeColors)
    .map(([name, color]) => `  ${JSON.stringify(name)}: "${color}",`)
    .join("\n");
  const other = Object.entries(otherColors)
    .map(([name, entries]) => `  ${JSON.stringify(name)}: ${JSON.stringify(entries)},`)
    .join("\n");
  return `// Generated by scripts/refresh-line-colors.ts — do not edit by hand.
//
${sources}
//
// Refresh with: npm run refresh:line-colors

import type { OtherLineColors } from "../../network-definition";

/** The network's lines' colours by name, or by \`name|mode\` where a name has one per mode. */
export const homeLineColors: Readonly<Record<string, string>> = {
${home}
};

/** Other operators' colours by name without spaces, each with its operator area's index. */
export const otherLineColors: OtherLineColors = {
${other}
};
`;
}

await main();
