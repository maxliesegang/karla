/**
 * Stop search text: a rider's spelling folded to the operator's (`muhlburg`, `muehlburg` and
 * `Mühlburg`; `strasse` and `Straße`; `Hbf` and `Hauptbahnhof`), and how well a stop matches.
 */

/** A stop as search reads it; `placeName` is its municipality or district. */
export type SearchableStop = { name: string; placeName?: string; formerName?: string };

/**
 * How well a stop matches, best first: the whole name, the name's start, every word's start,
 * every word somewhere.
 */
export const STOP_MATCH_RANKS = { exact: 0, nameStart: 1, wordStarts: 2, contained: 3 } as const;
export type StopMatchRank = (typeof STOP_MATCH_RANKS)[keyof typeof STOP_MATCH_RANKS];

/** Short forms the operators and riders both use, as one word each. */
const fullWordByShortWord: Readonly<Record<string, string>> = {
  hbf: "hauptbahnhof",
  bhf: "bahnhof",
  bf: "bahnhof",
};

/**
 * Lower case without accents, `ß` as `ss` and `ae`, `oe`, `ue` as their vowel, so both spellings
 * of an umlaut meet. Short forms are spelled out; `str.` only with its dot, since `str` may be a
 * name being typed.
 */
export function foldSearchText(text: string): string {
  const words = text
    .toLocaleLowerCase("de-DE")
    .replace(/ß/g, "ss")
    .replace(/\bstr\./g, "strasse ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([aou])e/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.map((word) => fullWordByShortWord[word] ?? word).join(" ");
}

/** A typed query's matcher: the stop's rank, or `undefined` where it does not match. */
export function createStopMatcher(
  query: string,
): (stop: SearchableStop) => StopMatchRank | undefined {
  const folded = foldSearchText(query);
  const queryWords = folded.split(" ").filter(Boolean);
  return ({ name, placeName, formerName }) => {
    const names = [name, formerName].flatMap((text) => (text ? [foldSearchText(text)] : []));
    const place = placeName ? foldSearchText(placeName) : undefined;
    // With its place, so `Stuttgart Hauptbahnhof` is that stop's whole name too.
    const fullNames = place ? [...names, ...names.map((text) => `${place} ${text}`)] : names;
    if (fullNames.includes(folded)) return STOP_MATCH_RANKS.exact;
    if (names.some((text) => text.startsWith(folded))) return STOP_MATCH_RANKS.nameStart;

    const fields = place ? [...names, place] : names;
    const words = fields.flatMap((text) => text.split(" "));
    if (queryWords.every((queryWord) => words.some((word) => word.startsWith(queryWord))))
      return STOP_MATCH_RANKS.wordStarts;
    if (queryWords.every((queryWord) => fields.some((text) => text.includes(queryWord))))
      return STOP_MATCH_RANKS.contained;
    return undefined;
  };
}

/** A stop of the network's own that a query matched, with its calls for ties. */
export type LocalStopMatch<T> = { stop: T; rank: StopMatchRank; callCount: number };
/** A stop the provider matched; `rank` is none where the text does not explain the match. */
export type ProviderStopMatch<T> = {
  stop: T;
  rank: StopMatchRank | undefined;
  /** Inside the network's area. */
  isNear: boolean;
};

/** A provider match the text does not explain (its own fuzzy match): after every other. */
const PROVIDER_ONLY_MATCH_RANK = STOP_MATCH_RANKS.contained + 1;
/** Kept for provider matches however many local ones there are: stops beyond the catalog. */
const PROVIDER_MATCH_SLOTS = 3;

/**
 * Local and provider matches as one list of at most `limit`, best match first. Equal local matches
 * rank by calls, equal provider ones near first, and a local match leads a provider one of its rank.
 */
export function mergeStopMatches<T extends { id: string; name: string }>(
  local: readonly LocalStopMatch<T>[],
  provider: readonly ProviderStopMatch<T>[],
  limit: number,
): T[] {
  const sortedLocal = [...local].sort(
    (a, b) =>
      a.rank - b.rank || b.callCount - a.callCount || a.stop.name.localeCompare(b.stop.name, "de"),
  );
  const listedIds = new Set(local.map(({ stop }) => stop.id));
  const sortedProvider = provider
    .flatMap(({ stop, rank, isNear }) => {
      if (listedIds.has(stop.id)) return [];
      listedIds.add(stop.id);
      return [{ stop, rank: rank ?? PROVIDER_ONLY_MATCH_RANK, isNear }];
    })
    .sort((a, b) => a.rank - b.rank || Number(b.isNear) - Number(a.isNear));

  const shownProvider = sortedProvider.slice(
    0,
    Math.min(limit, Math.max(limit - local.length, PROVIDER_MATCH_SLOTS)),
  );
  const shownLocal = sortedLocal.slice(0, limit - shownProvider.length);
  // Stable, so a local match leads a provider one of the same rank.
  return [...shownLocal, ...shownProvider].sort((a, b) => a.rank - b.rank).map(({ stop }) => stop);
}
