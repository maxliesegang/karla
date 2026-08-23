import type { Departure, PlatformKind } from "../data/transit-types";

/**
 * How a boarding place is named to a rider.
 *
 * The word is the operator's, not ours. KVV's feed states a `pointType` beside the platform code
 * and prints the same word on the stop itself: `Gleis 1(U)` and `Bstg. A` at Europaplatz, `Gleis 24`
 * and `Bstg. A` at the Hauptbahnhof. A rider matches what the screen says against what the sign
 * says, so the screen has to say the sign's word.
 *
 * `Steig` remains only where the feed states no kind — roughly one row in fifteen. It is the
 * generic term for a boarding position, correct for a bus bay and a tram platform alike, which
 * makes it the right thing to fall back to and the wrong thing to state everywhere.
 */
const wordByPlatformKind: Record<PlatformKind, string> = { track: "Gleis", stand: "Bstg." };

/** Spoken in full: `Bstg.` is an abbreviation a screen reader has no way to say. */
const spokenWordByPlatformKind: Record<PlatformKind, string> = {
  track: "Gleis",
  stand: "Bussteig",
};

const GENERIC_PLATFORM_WORD = "Steig";

/** The printed name of a platform, for example `Gleis 24`, `Bstg. A`, or `Steig 7`. */
export function formatPlatformName(
  platformName: string,
  platformKind: PlatformKind | undefined,
  unknownPlatformLabel = "?",
): string {
  const word = platformKind ? wordByPlatformKind[platformKind] : GENERIC_PLATFORM_WORD;
  return `${word} ${platformName || unknownPlatformLabel}`;
}

/** The same name spoken, with the abbreviation written out and no bare `?` to read aloud. */
export const formatSpokenPlatformName = (
  platformName: string,
  platformKind: PlatformKind | undefined,
): string =>
  `${platformKind ? spokenWordByPlatformKind[platformKind] : GENERIC_PLATFORM_WORD} ${platformName || "unbekannt"}`;

/** The word alone, for a column where the code is the glyph being read and the word is a caption. */
export const getPlatformWord = (platformKind: PlatformKind | undefined): string | undefined =>
  platformKind ? wordByPlatformKind[platformKind] : undefined;

/**
 * The one kind a set of departures agrees on, or `undefined` where they disagree or state none.
 *
 * A heading stands above several rows and may only use a word every row underneath it supports. At
 * a stop where a bus bay and a tram platform are shown under one heading there is no such word, and
 * the generic one is what is left.
 */
export function findSharedPlatformKind(departures: readonly Departure[]): PlatformKind | undefined {
  const kinds = new Set(departures.map((departure) => departure.platformKind));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/**
 * The one platform a set of departures all leave from, or `undefined` where they use several.
 *
 * A heading may only state a platform every trip under it actually leaves from. Where the trips of
 * one direction agree, the heading carries it once and the trips underneath say nothing about it;
 * where they part, the platform is a fact about each trip and belongs on the trip.
 */
export function findSharedPlatformName(departures: readonly Departure[]): string | undefined {
  const names = new Set(departures.map((departure) => departure.platformName || ""));
  const [name] = [...names];
  return names.size === 1 && name ? name : undefined;
}

/**
 * What a group heading prints: the operator's word, and the code as its own glyph.
 *
 * Split rather than formatted into one string because the heading sets the two differently — the
 * code is what a rider matches against the sign they are walking towards, and the word is its
 * caption. Where the feed named no platform there is no code and nowhere to walk to, so the group
 * says so in full instead of captioning a bare `?`.
 */
export type PlatformHeadingParts = { word?: string; code: string };

export const UNNAMED_PLATFORM_LABEL = "Ohne Steigangabe";

export function getPlatformHeadingParts(
  platformName: string,
  platformKind: PlatformKind | undefined,
): PlatformHeadingParts {
  if (!platformName) return { code: UNNAMED_PLATFORM_LABEL };
  return {
    word: platformKind ? wordByPlatformKind[platformKind] : GENERIC_PLATFORM_WORD,
    code: platformName,
  };
}

/** The same heading spoken: the abbreviation written out, and no bare `?` read aloud. */
export const formatSpokenPlatformHeading = (
  platformName: string,
  platformKind: PlatformKind | undefined,
): string =>
  platformName ? formatSpokenPlatformName(platformName, platformKind) : UNNAMED_PLATFORM_LABEL;
