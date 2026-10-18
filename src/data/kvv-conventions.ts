/** How KVV words its data, in both the EFA and the TRIAS feed. */
import { EXCEPTIONAL_OPERATION_WORDS } from "./operational-exceptions";
import type { PlatformKind, VehicleAccess } from "./transit-types";

const NETWORK_TIME_ZONE = "Europe/Berlin";
const networkDateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: NETWORK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An instant's network calendar day and minute, as a trip locator states them. */
export function formatNetworkDateAndTime(instant: number): { date: string; time: string } {
  const parts = Object.fromEntries(
    networkDateTimeFormat.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    time: `${parts.hour}${parts.minute}`,
  };
}

/**
 * The data pool of KVV's own lines, the first segment of a line id (`kvv:22304:E:H:s26`). The
 * server also answers for other pools that share KVV's modes: DB's S-Bahn Rhein-Neckar (S3, S6, S9,
 * since December 2025) and `rab:` rail replacement. Measured 5 September 2026.
 */
const LOCAL_NETWORK_POOL = "kvv";

/** An unstated pool is unknown, not foreign. */
export function isLocalNetworkPool(lineId: string | undefined): boolean {
  if (lineId === undefined || !lineId.includes(":")) return true;
  return lineId.slice(0, lineId.indexOf(":")) === LOCAL_NETWORK_POOL;
}

/**
 * Boarding as the remarks state it. The negation is matched first because it contains the positive
 * word; a trip whose remarks say nothing about boarding stays unanswered, not `notStepFree`.
 */
const NOT_STEP_FREE_PATTERN = /nicht\s+(barrierefrei|stufenlos|rollstuhl)/i;
const STEP_FREE_PATTERN = /stufenlos|niederflur|barrierefrei|behindertengerecht|einstiegshilfe/i;

export function readVehicleAccess(remarks: readonly string[]): VehicleAccess | undefined {
  if (remarks.some((remark) => NOT_STEP_FREE_PATTERN.test(remark))) return "notStepFree";
  return remarks.some((remark) => STEP_FREE_PATTERN.test(remark)) ? "stepFree" : undefined;
}

/**
 * Remarks about how the trip is running (`Verspätung eines vorausfahrenden Zuges`), as opposed to
 * equipment (`WLAN`, `Bordrestaurant`), which shares the field and is dropped.
 */
const OPERATING_REMARK_PATTERN = new RegExp(
  `verspätung|störung|${EXCEPTIONAL_OPERATION_WORDS}|entfällt|ausfall|behinderung|gleiswechsel`,
  "i",
);

/** The operating remarks, as one note. */
export function readOperatingNote(remarks: readonly string[]): string | undefined {
  const operating = remarks.filter((remark) => OPERATING_REMARK_PATTERN.test(remark));
  return operating.length > 0 ? [...new Set(operating)].join(" · ") : undefined;
}

/** Two remarks about one trip read as one note; either may be missing. */
export function joinServiceNotes(...notes: (string | undefined)[]): string | undefined {
  const stated = [...new Set(notes.filter((note): note is string => Boolean(note)))];
  return stated.length > 0 ? stated.join(" · ") : undefined;
}

/**
 * Operational remarks KVV appends to destinations (`Waldstadt > SEV ab Hirtenweg`,
 * `Heide (Umleitung)`). A parenthesis counts only with operational vocabulary: `Söllingen (b.
 * Karlsruhe)` is part of the place name.
 */
const DESTINATION_REMARK_PATTERN = new RegExp(
  `${EXCEPTIONAL_OPERATION_WORDS}|entfällt|sonderfahrt|verstärker|nur bis|ab \\S`,
  "i",
);

/** The destination and the remark appended to it, if any. */
export function splitDestination(destination: string): [string, string | undefined] {
  const chevron = destination.indexOf(">");
  if (chevron > 0) {
    return [
      destination.slice(0, chevron).trim(),
      destination.slice(chevron + 1).trim() || undefined,
    ];
  }

  const suffix = /\s*\(([^()]+)\)\s*$/.exec(destination);
  if (suffix && DESTINATION_REMARK_PATTERN.test(suffix[1])) {
    return [destination.slice(0, suffix.index).trim(), suffix[1].trim()];
  }

  return [destination.trim(), undefined];
}

/**
 * `Gleis` (rail) or `Bstg.` (bus stand); anything else is left unstated, not guessed from the mode.
 */
export function parsePlatformKind(word: string | undefined): PlatformKind | undefined {
  const stated = word?.trim().toLowerCase();
  if (stated === "gleis" || stated === "bahnsteig") return "track";
  if (stated === "bstg" || stated === "bstg." || stated === "bussteig") return "stand";
  return undefined;
}
