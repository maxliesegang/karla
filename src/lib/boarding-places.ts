import type { Departure, PlatformKind, TripCall } from "../data/transit-types";
import { getDistanceMeters } from "./geo";
import { getBaseName } from "./stop-naming";
import { compareGermanNames } from "./text";
import { isTurnaroundPair } from "./trip-calls";

/**
 * The level between a stop and its platforms: the places at a stop a rider has to choose between
 * before they start walking.
 *
 * A stop is one place and a platform is one edge to stand on, and for most stops that is the whole
 * story. It is not the story in the Zentrum. Marktplatz is two tunnels crossing under one name, and
 * a rider sent to `Gleis 3(U)` when they are standing on `Gleis 1(U)` has two hundred metres and a
 * pair of escalators ahead of them that the board never mentioned. Europaplatz is worse: its four
 * street platforms are two stops in everything but the operator's numbering, and the same tram is
 * published at both, a minute apart, under one stop point id.
 *
 * Neither is visible in a platform code, and neither can be turned off in the request — EFA answers
 * the whole complex from any of its ids. So the board is split here, where it is read.
 *
 * Nothing about this is authored. It is derived from the same trips every other reading is derived
 * from, so it follows the network rather than a note somebody wrote down about it — which matters,
 * because a diversion moves platforms and a building site moves them for months.
 */

/** One place to stand at a stop: what a rider walks to, and the platforms they find when they do. */
export type BoardingPlace = {
  /** Stable across refreshes, so a chosen place survives the board being read again. */
  id: string;
  /**
   * The operator's own name for it, where the operator brackets one into the stop point's name —
   * `Marktplatz (Pyramide U)` is the `Pyramide` half of Marktplatz, and KVV prints that word on the
   * station. `undefined` where the stop point carries no such name, and then the platforms are the
   * only name the place has.
   */
  label?: string;
  /** The platform codes standing here, in the order a board lists them. */
  platformCodes: readonly string[];
  /** The one word every platform here agrees on, or `undefined` where they do not. */
  platformKind?: PlatformKind;
  /** The EFA stop point these platforms belong to. */
  providerStopPointId: string;
};

/** Where a stop's departures leave from. Empty for a stop whose boards state no platform at all. */
export type StopBoardingPlaces = readonly BoardingPlace[];

/**
 * What a visit to one stop has learned about the places it is.
 *
 * Accumulated rather than re-derived, for the reason the corridor memory is: the boards that carry
 * calling sequences are on their own slow cadence and are never the board the rider is looking at,
 * so on any given refresh the evidence may or may not be in hand. A tram observed once calling at
 * two platforms in turn has said what it has to say, and the stop stays two places afterwards
 * whether or not that trip is still on the board.
 */
export type StopBoardingObservations = {
  stopId: string;
  /** Every platform this visit has seen published, and what it has learned about each. */
  platforms: ReadonlyMap<PlatformKey, PlatformReading>;
  /** The pairs some trip has been observed calling at in turn — the operator parting them. */
  separated: ReadonlySet<string>;
  /**
   * The pairs some reading has shown to be one vehicle turning round, which vetoes the above.
   *
   * Both facts are kept, because a pair is read from both of its ends and only one of those ends
   * can see the mark. Every board row departs from one of the stop's own platforms, so one of the
   * two calls is always the board's own — the one call the sequence omits, which arrives looking
   * like the origin of a run whether or not it is one. Turmberg's buses lay over four minutes
   * between `Bstg. A` and `Bstg. D` and say so on the reading where neither call is the row's;
   * Entenfang's 2 calls at two platforms 147 m apart and says so on both. So the marks are
   * collected wherever they can be trusted, and subtracted at the end.
   */
  turnedAround: ReadonlySet<string>;
};

const createStopBoardingObservations = (stopId: string): StopBoardingObservations => ({
  stopId,
  platforms: new Map(),
  separated: new Set(),
  turnedAround: new Set(),
});

/**
 * The same memory with whatever these departures add to it, or the very same object where they add
 * nothing — so a render that learned nothing settles rather than deriving the places again.
 */
export function updateStopBoardingObservations(
  previous: StopBoardingObservations | null,
  stopId: string,
  departures: readonly Departure[],
): StopBoardingObservations {
  const base =
    previous && previous.stopId === stopId ? previous : createStopBoardingObservations(stopId);
  const platforms = new Map(base.platforms);
  const separated = new Set(base.separated);
  const turnedAround = new Set(base.turnedAround);
  let learned = false;

  for (const departure of departures) {
    if (departure.boardingLocalStopId !== stopId) continue;
    if (!departure.platformCode || !departure.boardingProviderStopPointId) continue;
    const key = getPlatformKey(departure.boardingProviderStopPointId, departure.platformCode);
    const known = platforms.get(key);
    if (!known) {
      platforms.set(key, {
        providerStopPointId: departure.boardingProviderStopPointId,
        platformCode: departure.platformCode,
        platformKind: departure.platformKind,
        providerStopPointName: departure.boardingProviderStopPointName,
      });
      learned = true;
      continue;
    }
    // A place a rider walks to has one word on its sign. Where the rows disagree there is none.
    if (known.platformKind !== undefined && known.platformKind !== departure.platformKind) {
      platforms.set(key, { ...known, platformKind: undefined });
      learned = true;
    }
  }

  for (const departure of departures) {
    learned = readPlatformPositions(platforms, stopId, departure) || learned;
    learned = readCallPairs(separated, turnedAround, stopId, departure) || learned;
  }

  return learned ? { stopId, platforms, separated, turnedAround } : base;
}

/**
 * The places this stop is, gathered out of what the visit has learned.
 *
 * One place — no choice to offer — is the answer for nearly every stop, and the one every reading
 * falls back to where nothing has been observed to part its platforms.
 */
export function getStopBoardingPlaces(observations: StopBoardingObservations): StopBoardingPlaces {
  if (observations.platforms.size === 0) return [];
  const separated = new Set(
    [...observations.separated].filter((pair) => !observations.turnedAround.has(pair)),
  );
  const clusters = clusterPlatforms([...observations.platforms.values()], separated);
  const places = clusters.map(toBoardingPlace).sort(compareBoardingPlaces);
  return disambiguateSharedLabels(places);
}

/**
 * The operator's word for a stop point only names a place while it names one place.
 *
 * At the Hauptbahnhof it does not: the Vorplatz's bus bays and its tram platforms are parted by the
 * 62 and the 50, which call at `Bstg. B` and then pull forward to `Gleis 24`, and both halves are
 * published as `Hauptbahnhof (Vorplatz)`. Two choices reading `Vorplatz` are not a choice, so
 * where a name is shared the platforms standing there are added to it — the one thing that is
 * always different, and the thing a rider is walking towards anyway.
 */
function disambiguateSharedLabels(places: readonly BoardingPlace[]): BoardingPlace[] {
  const countByLabel = new Map<string, number>();
  for (const { label } of places) {
    if (label) countByLabel.set(label, (countByLabel.get(label) ?? 0) + 1);
  }
  return places.map((place) =>
    place.label && (countByLabel.get(place.label) ?? 0) > 1
      ? { ...place, label: `${place.label} ${place.platformCodes.join(" · ")}` }
      : place,
  );
}

/** The place a departure leaves from, or `undefined` where this reading places none. */
export function findBoardingPlace(
  boardingPlaces: StopBoardingPlaces,
  departure: Departure,
): BoardingPlace | undefined {
  return boardingPlaces.find(
    (place) =>
      place.providerStopPointId === departure.boardingProviderStopPointId &&
      place.platformCodes.includes(departure.platformCode),
  );
}

/** Whether these departures all leave from one place, and which — the only time a heading may say. */
export function findSharedBoardingPlace(
  boardingPlaces: StopBoardingPlaces,
  departures: readonly Departure[],
): BoardingPlace | undefined {
  if (boardingPlaces.length < 2 || departures.length === 0) return undefined;
  const [first, ...rest] = departures.map((departure) =>
    findBoardingPlace(boardingPlaces, departure),
  );
  return first && rest.every((place) => place === first) ? first : undefined;
}

/** What a heading prints for a place: the operator's word where there is one, else its platforms. */
export const getBoardingPlaceLabel = (place: BoardingPlace): string =>
  place.label ?? place.platformCodes.join(" · ");

/** One platform of one stop point, which is the unit the places are built out of. */
type PlatformKey = string;
const getPlatformKey = (providerStopPointId: string, platformCode: string): PlatformKey =>
  `${providerStopPointId}\u0000${platformCode}`;

type PlatformReading = {
  providerStopPointId: string;
  platformCode: string;
  platformKind?: PlatformKind;
  /** The stop point's published name, which is where a label comes from. */
  providerStopPointName: string;
  latitude?: number;
  longitude?: number;
};

/**
 * Where each platform stands, read off the calls this departure carries.
 *
 * A departure row states no position — only a calling sequence does, and it states it for every
 * platform of the stop its trips pass through, which is the same set of platforms.
 */
function readPlatformPositions(
  platforms: Map<PlatformKey, PlatformReading>,
  stopId: string,
  departure: Departure,
): boolean {
  let learned = false;
  for (const call of departure.tripCalls ?? []) {
    if (call.localStopId !== stopId || !call.providerStopPointId || !call.platformCode) continue;
    const key = getPlatformKey(call.providerStopPointId, call.platformCode);
    const platform = platforms.get(key);
    if (!platform || platform.latitude !== undefined) continue;
    if (call.latitude === undefined || call.longitude === undefined) continue;
    platforms.set(key, { ...platform, latitude: call.latitude, longitude: call.longitude });
    learned = true;
  }
  return learned;
}

/**
 * The two things a pair of consecutive calls at one stop can be, both collected.
 *
 * A trip that calls at two platforms of one stop in turn has driven between them, and a rider on
 * board has watched it happen. That is the only statement in the whole feed that separates
 * Europaplatz's `Gleis 3` from its `Gleis 5`, which are 110 m apart under one stop point id, one
 * name, and one set of lines in one set of directions.
 *
 * The same shape is also how a vehicle turning round is reported, and there it is no walk at all.
 * The feed marks which it is — but only on the readings where neither call is the board's own, so
 * the mark is recorded when it appears rather than demanded of every reading.
 */
function readCallPairs(
  separated: Set<string>,
  turnedAround: Set<string>,
  stopId: string,
  departure: Departure,
): boolean {
  const calls = departure.tripCalls ?? [];
  let learned = false;
  for (let index = 1; index < calls.length; index += 1) {
    const previous = calls[index - 1];
    const call = calls[index];
    if (previous.localStopId !== stopId || call.localStopId !== stopId) continue;
    const left = toCallPlatformKey(previous);
    const right = toCallPlatformKey(call);
    // A trip reported twice at one platform is the feed restating a call, not a walk.
    if (!left || !right || left === right) continue;
    const key = getSeparationKey(left, right);
    const gathered = isTurnaroundPair(previous, call) ? turnedAround : separated;
    if (gathered.has(key)) continue;
    gathered.add(key);
    learned = true;
  }
  return learned;
}

const toCallPlatformKey = (call: TripCall): PlatformKey | undefined =>
  call.providerStopPointId && call.platformCode
    ? getPlatformKey(call.providerStopPointId, call.platformCode)
    : undefined;

/** Order-free, because "these are different places" is a statement about a pair. */
const getSeparationKey = (left: PlatformKey, right: PlatformKey): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

/**
 * The platforms gathered into the places they stand at.
 *
 * Agglomerative and constrained: the two nearest clusters merge, then the next two, until every
 * remaining merge is forbidden. What forbids one is the operator's own evidence — a trip calling at
 * both — and two rules that hold before any trip has been observed at all: a stop point is a level,
 * and levels do not merge (Europaplatz's `Gleis 5` is three metres from the tunnel's `Gleis 1(U)`,
 * and neither the feed nor GTFS states a height); and the operator's own word for a platform is
 * part of what a rider is walking towards, so a `Bstg.` never joins a `Gleis`.
 *
 * There is deliberately no distance limit. Distance decides which merge happens first, never
 * whether one may: a stop nothing has been observed to separate is one place, which is the reading
 * every ordinary stop wants and the conservative one everywhere else. Two platforms are only ever
 * parted by evidence.
 */
function clusterPlatforms(
  platforms: readonly PlatformReading[],
  separated: ReadonlySet<string>,
): PlatformReading[][] {
  const clusters = platforms.map((platform) => [platform]);

  for (;;) {
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestPair: [number, number] | undefined;
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        if (!canMerge(clusters[left], clusters[right], separated)) continue;
        const distance = getClusterDistance(clusters[left], clusters[right]);
        // A legal merge is taken even where nothing could be measured — every board states its
        // platforms, only the slower one that carries calling sequences states where they are, and
        // an unplaced platform must not be left standing alone until it arrives.
        if (bestPair === undefined || distance < bestDistance) {
          bestDistance = distance;
          bestPair = [left, right];
        }
      }
    }
    if (!bestPair) return clusters;
    const [left, right] = bestPair;
    clusters[left] = [...clusters[left], ...clusters[right]];
    clusters.splice(right, 1);
  }
}

function canMerge(
  left: readonly PlatformReading[],
  right: readonly PlatformReading[],
  separated: ReadonlySet<string>,
): boolean {
  for (const here of left) {
    for (const there of right) {
      if (here.providerStopPointId !== there.providerStopPointId) return false;
      if (here.platformKind !== there.platformKind) return false;
      const key = getSeparationKey(
        getPlatformKey(here.providerStopPointId, here.platformCode),
        getPlatformKey(there.providerStopPointId, there.platformCode),
      );
      if (separated.has(key)) return false;
    }
  }
  return true;
}

/**
 * How far apart two clusters are, taken from their nearest members — the walk a rider would
 * actually make. Unplaced platforms sit at infinity, so they merge only once everything measurable
 * has, and never in preference to a platform whose position is known.
 */
function getClusterDistance(
  left: readonly PlatformReading[],
  right: readonly PlatformReading[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const here of left) {
    if (here.latitude === undefined || here.longitude === undefined) continue;
    for (const there of right) {
      nearest = Math.min(nearest, getDistanceMeters(here.latitude, here.longitude, there));
    }
  }
  return nearest;
}

function toBoardingPlace(cluster: readonly PlatformReading[]): BoardingPlace {
  const platforms = [...cluster].sort((left, right) =>
    compareGermanNames(left.platformCode, right.platformCode),
  );
  const [first] = platforms;
  const kinds = new Set(platforms.map((platform) => platform.platformKind));
  return {
    id: `${first.providerStopPointId}-${platforms.map(({ platformCode }) => platformCode).join("-")}`,
    label: findStopPointLabel(first.providerStopPointName),
    platformCodes: platforms.map(({ platformCode }) => platformCode),
    platformKind: kinds.size === 1 ? [...kinds][0] : undefined,
    providerStopPointId: first.providerStopPointId,
  };
}

/**
 * The operator's own name for one part of a place, out of the aside it brackets into the stop
 * point's name: `Marktplatz (Pyramide U)` is the Pyramide, `Europaplatz (U)` is the level below.
 * `getBaseName` already reads the other half of the same convention.
 */
function findStopPointLabel(providerStopPointName: string): string | undefined {
  const bracketed = /\(([^)]+)\)\s*$/.exec(providerStopPointName)?.[1]?.trim();
  return bracketed && getBaseName(providerStopPointName) !== providerStopPointName
    ? bracketed
    : undefined;
}

/**
 * Platform order, which is the order the platform signposts under them are already in — so the two
 * headings a rider reads never disagree about which way the board runs.
 *
 * Not the board's own order: that is the order the next few trips happen to leave in, and it would
 * have the choices at the top of the board swap places every thirty seconds.
 */
function compareBoardingPlaces(left: BoardingPlace, right: BoardingPlace): number {
  return compareGermanNames(left.platformCodes[0], right.platformCodes[0]);
}
