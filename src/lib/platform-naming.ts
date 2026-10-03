import type { Departure, PlatformKind } from "../data/transit-types";

/**
 * Platform names in the operator's words: the feed's `pointType` matches the signage (`Gleis 1(U)`,
 * `Bstg. A`). `Steig` is the fallback where no kind is stated (about one row in fifteen).
 */
const wordByPlatformKind: Record<PlatformKind, string> = { track: "Gleis", stand: "Bstg." };

/** Spoken in full: a screen reader cannot say `Bstg.`. */
const spokenWordByPlatformKind: Record<PlatformKind, string> = {
  track: "Gleis",
  stand: "Bussteig",
};

const GENERIC_PLATFORM_WORD = "Steig";

/** The printed name, e.g. `Gleis 24`, `Bstg. A`, `Steig 7`. */
export function formatPlatformLabel(
  platformCode: string,
  platformKind: PlatformKind | undefined,
  unknownPlatformLabel = "?",
): string {
  const word = platformKind ? wordByPlatformKind[platformKind] : GENERIC_PLATFORM_WORD;
  return `${word} ${platformCode || unknownPlatformLabel}`;
}

/** The spoken name, abbreviation expanded, no bare `?`. */
export const formatSpokenPlatformLabel = (
  platformCode: string,
  platformKind: PlatformKind | undefined,
): string =>
  `${platformKind ? spokenWordByPlatformKind[platformKind] : GENERIC_PLATFORM_WORD} ${platformCode || "unbekannt"}`;

/** The word alone, as a caption to the code. */
export const getPlatformWord = (platformKind: PlatformKind | undefined): string | undefined =>
  platformKind ? wordByPlatformKind[platformKind] : undefined;

/** The kind all departures agree on, else `undefined`. */
export function findSharedPlatformKind(departures: readonly Departure[]): PlatformKind | undefined {
  const kinds = new Set(departures.map((departure) => departure.platformKind));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/** The platform all departures share, else `undefined`. */
export function findSharedPlatformCode(departures: readonly Departure[]): string | undefined {
  const names = new Set(departures.map((departure) => departure.platformCode || ""));
  const [name] = [...names];
  return names.size === 1 && name ? name : undefined;
}

/**
 * A group heading's parts: the word as caption, the code as glyph. Without a code it says so in
 * full.
 */
export type PlatformHeadingParts = { word?: string; code: string };

const UNNAMED_PLATFORM_LABEL = "Ohne Steigangabe";

export function getPlatformHeadingParts(
  platformCode: string,
  platformKind: PlatformKind | undefined,
): PlatformHeadingParts {
  if (!platformCode) return { code: UNNAMED_PLATFORM_LABEL };
  return {
    word: platformKind ? wordByPlatformKind[platformKind] : GENERIC_PLATFORM_WORD,
    code: platformCode,
  };
}

/** The heading spoken, abbreviation expanded, no bare `?`. */
export const formatSpokenPlatformHeading = (
  platformCode: string,
  platformKind: PlatformKind | undefined,
): string =>
  platformCode ? formatSpokenPlatformLabel(platformCode, platformKind) : UNNAMED_PLATFORM_LABEL;
