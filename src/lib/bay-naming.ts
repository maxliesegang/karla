import type { StopEvent, BayKind } from "../data/transit-types";

/**
 * Bay names in the operator's words: the feed's `pointType` matches the signage (`Gleis 1(U)`,
 * `Bstg. A`). `Steig` is the fallback where no kind is stated (about one row in fifteen).
 */
const wordByBayKind: Record<BayKind, string> = { track: "Gleis", stand: "Bstg." };

/** Spoken in full: a screen reader cannot say `Bstg.`. */
const spokenWordByBayKind: Record<BayKind, string> = {
  track: "Gleis",
  stand: "Bussteig",
};

const GENERIC_BAY_WORD = "Steig";

/** The printed name, e.g. `Gleis 24`, `Bstg. A`, `Steig 7`. */
export function formatBayText(
  bay: string,
  bayKind: BayKind | undefined,
  unknownBayText = "?",
): string {
  const word = bayKind ? wordByBayKind[bayKind] : GENERIC_BAY_WORD;
  return `${word} ${bay || unknownBayText}`;
}

/** The spoken name, abbreviation expanded, no bare `?`. */
export const formatSpokenBayText = (bay: string, bayKind: BayKind | undefined): string =>
  `${bayKind ? spokenWordByBayKind[bayKind] : GENERIC_BAY_WORD} ${bay || "unbekannt"}`;

/** The word alone, as a caption to the code. */
export const getBayWord = (bayKind: BayKind | undefined): string | undefined =>
  bayKind ? wordByBayKind[bayKind] : undefined;

/** The kind all departures agree on, else `undefined`. */
export function findSharedBayKind(stopEvents: readonly StopEvent[]): BayKind | undefined {
  const kinds = new Set(stopEvents.map((stopEvent) => stopEvent.bayKind));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/** The bay all departures share, else `undefined`. */
export function findSharedBay(stopEvents: readonly StopEvent[]): string | undefined {
  const names = new Set(stopEvents.map((stopEvent) => stopEvent.bay || ""));
  const [name] = [...names];
  return names.size === 1 && name ? name : undefined;
}

/**
 * A group heading's parts: the word as caption, the code as glyph. Without a code it says so in
 * full.
 */
export type BayHeadingParts = { word?: string; code: string };

const UNNAMED_BAY_TEXT = "Ohne Steigangabe";

export function getBayHeadingParts(bay: string, bayKind: BayKind | undefined): BayHeadingParts {
  if (!bay) return { code: UNNAMED_BAY_TEXT };
  return {
    word: bayKind ? wordByBayKind[bayKind] : GENERIC_BAY_WORD,
    code: bay,
  };
}

/** The heading spoken, abbreviation expanded, no bare `?`. */
export const formatSpokenBayHeading = (bay: string, bayKind: BayKind | undefined): string =>
  bay ? formatSpokenBayText(bay, bayKind) : UNNAMED_BAY_TEXT;
