/** How KVV words its data in the feed. */
import { EXCEPTIONAL_OPERATION_WORDS } from "./operational-exceptions";
import type { BayKind, VehicleAccess } from "./transit-types";

/**
 * Boarding as the remarks state it. The negation is matched first because it contains the positive
 * word; a journey whose remarks say nothing about boarding stays unanswered, not `notStepFree`.
 */
const NOT_STEP_FREE_PATTERN = /nicht\s+(barrierefrei|stufenlos|rollstuhl)/i;
const STEP_FREE_PATTERN = /stufenlos|niederflur|barrierefrei|behindertengerecht|einstiegshilfe/i;

export function readVehicleAccess(remarks: readonly string[]): VehicleAccess | undefined {
  if (remarks.some((remark) => NOT_STEP_FREE_PATTERN.test(remark))) return "notStepFree";
  return remarks.some((remark) => STEP_FREE_PATTERN.test(remark)) ? "stepFree" : undefined;
}

/**
 * Remarks about how the journey is running (`Verspätung eines vorausfahrenden Zuges`), as opposed
 * to equipment (`WLAN`, `Bordrestaurant`), which shares the field and is dropped.
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

/** Two remarks about one journey read as one note; either may be missing. */
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
export function parseBayKind(word: string | undefined): BayKind | undefined {
  const stated = word?.trim().toLowerCase();
  if (stated === "gleis" || stated === "bahnsteig") return "track";
  if (stated === "bstg" || stated === "bstg." || stated === "bussteig") return "stand";
  return undefined;
}

/**
 * Strips a notice's zero padding (`007` is line `7`). Suffixes stay (`104s` is not `104`); the
 * comparison ignores their case.
 */
export function normalizeNoticeLineNumber(number: string | undefined): string | undefined {
  const trimmed = number?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^0+(?=[A-Za-z]*\d)/, "");
}

/** The notice's rich text as plain paragraphs: tags stripped, breaks become paragraphs. */
export function parseNoticeDetails(html: string | undefined): string[] {
  if (!html) return [];
  return html
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .split("\n")
    .map((line) => decodeHtmlEntities(line).replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/** The named entities the operator's text uses, plus the numeric form. */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  bull: "•",
  ndash: "–",
  mdash: "—",
  euro: "€",
  hellip: "…",
  rarr: "→",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  lsquo: "‘",
  rsquo: "’",
  deg: "°",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity] ?? match;
  });
}
