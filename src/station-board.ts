/**
 * Station board mode: an unattended display configured by the query string (`?display=stop`), so
 * the hash remains the canonical stop address. See the README for the parameters.
 */

export type StationBoardGrouping = "none" | "platform";
/** What the alternating second line of a row carries, or nothing at all. */
export type StationBoardDetail = "via" | "note" | "off";

export type StationBoardConfig = {
  mode: "stop" | "platform";
  /** The platforms this board covers. Several are allowed: one screen often serves a whole island. */
  platformCodes: readonly string[];
  rowCount: number;
  grouping: StationBoardGrouping;
  detail: StationBoardDetail;
  /** Departures closer than this are dropped: a rider cannot reach a train leaving in under a minute. */
  minimumMinutes: number;
  /** How long before the page reloads itself, which is how a station board picks up a deploy. */
  reloadMinutes: number;
};

/**
 * A platform as a board can match it.
 *
 * The feed spells the same platform several ways — `2`, `Gleis 2`, `Steig 2`, `Bstg. 2` — and an
 * exact comparison against whatever the operator typed into the URL makes the screen silently
 * empty. Both sides are reduced to the part that identifies the platform before they are compared.
 */
export function normalizePlatformCode(platformCode: string): string {
  return platformCode
    .toLowerCase()
    .replace(/\b(gleis|steig|bstg\.?|bahnsteig|pos\.?)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export const isPlatformMatch = (
  platformCode: string,
  wantedPlatformCodes: readonly string[],
): boolean =>
  wantedPlatformCodes.length === 0 ||
  wantedPlatformCodes.includes(normalizePlatformCode(platformCode));

/** Whole numbers within a range, falling back to a default rather than to a broken screen. */
function parseBoundedNumber(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

/**
 * Unattended station boards are configured by query string so the hash remains the canonical stop
 * address. `display=1` is retained as the former spelling of a whole-stop board.
 */
export function parseStationBoardConfig(search: string): StationBoardConfig | null {
  const parameters = new URLSearchParams(search);
  const displayMode = parameters.get("display");
  if (displayMode !== "1" && displayMode !== "stop" && displayMode !== "platform") return null;

  const platformCodes = (parameters.get("platform") ?? "")
    .split(",")
    .map((name) => normalizePlatformCode(name))
    .filter(Boolean);
  const detail = parameters.get("detail");

  return {
    mode: displayMode === "platform" ? "platform" : "stop",
    platformCodes,
    rowCount: parseBoundedNumber(parameters.get("rows"), 8, 3, 20),
    grouping: parameters.get("group") === "platform" ? "platform" : "none",
    detail: detail === "via" || detail === "note" || detail === "off" ? detail : "note",
    minimumMinutes: parseBoundedNumber(parameters.get("minMinutes"), 0, 0, 30),
    reloadMinutes: parseBoundedNumber(parameters.get("reloadMinutes"), 1440, 15, 10_080),
  };
}

export const stationBoardConfig = parseStationBoardConfig(window.location.search);
export const isStationBoardMode = stationBoardConfig !== null;

/** How a board names the platforms it covers, for its own heading. */
export const getPlatformLabel = (config: StationBoardConfig): string =>
  config.platformCodes.length > 0 ? config.platformCodes.join(" + ").toUpperCase() : "?";
