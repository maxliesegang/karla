/**
 * Station board mode: an unattended display configured by the query string (`?display=stop`), so
 * the hash remains the canonical stop address. See the README for the parameters.
 */

export type StationBoardGrouping = "none" | "platform";
/** What the alternating second line of a row carries, or nothing at all. */
export type StationBoardDetail = "via" | "note" | "off";

export type StationBoardConfig = {
  mode: "stop" | "platform";
  /** The bays covered; one screen often serves a whole island. */
  bays: readonly string[];
  rowCount: number;
  grouping: StationBoardGrouping;
  detail: StationBoardDetail;
  /** Departures sooner than this are dropped: nobody reaches them. */
  minimumMinutes: number;
  /** Minutes until the page reloads, which picks up deploys. */
  reloadMinutes: number;
};

/**
 * A bay reduced to its identifying part, since the feed spells it several ways (`2`,
 * `Gleis 2`, `Steig 2`, `Bstg. 2`) and an exact match would leave the screen empty.
 */
export function normalizeBay(bay: string): string {
  return bay
    .toLowerCase()
    .replace(/\b(gleis|steig|bstg\.?|bahnsteig|pos\.?)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export const isBayMatch = (bay: string, wantedBays: readonly string[]): boolean =>
  wantedBays.length === 0 || wantedBays.includes(normalizeBay(bay));

/** Whole numbers within a range, else the default. */
function parseBoundedNumber(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

/** Parses the query-string config. */
export function parseStationBoardConfig(search: string): StationBoardConfig | null {
  const parameters = new URLSearchParams(search);
  const displayMode = parameters.get("display");
  if (displayMode !== "stop" && displayMode !== "platform") return null;

  const bays = (parameters.get("platform") ?? "")
    .split(",")
    .map((name) => normalizeBay(name))
    .filter(Boolean);
  const detail = parameters.get("detail");

  return {
    mode: displayMode === "platform" ? "platform" : "stop",
    bays,
    rowCount: parseBoundedNumber(parameters.get("rows"), 8, 3, 20),
    grouping: parameters.get("group") === "platform" ? "platform" : "none",
    detail: detail === "via" || detail === "note" || detail === "off" ? detail : "note",
    minimumMinutes: parseBoundedNumber(parameters.get("minMinutes"), 0, 0, 30),
    reloadMinutes: parseBoundedNumber(parameters.get("reloadMinutes"), 1440, 15, 10_080),
  };
}

export const stationBoardConfig = parseStationBoardConfig(window.location.search);
export const isStationBoardMode = stationBoardConfig !== null;

/** The board's heading for its bays. */
export const getBayText = (config: StationBoardConfig): string =>
  config.bays.length > 0 ? config.bays.join(" + ").toUpperCase() : "?";
