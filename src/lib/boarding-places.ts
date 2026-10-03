import type { Departure, PlatformKind, TripCall } from "../data/transit-types";
import { getDistanceMeters } from "./geo";
import { getBaseName } from "./stop-naming";
import { compareGermanNames } from "./text";
import { isTurnaroundPair } from "./trip-calls";

/**
 * Boarding places: the parts of a stop a rider chooses between before walking (Marktplatz's two
 * tunnels; Europaplatz's street platforms, two stops under one stop point id). EFA answers for the
 * whole complex, so the board is split here, derived from observed trips rather than authored.
 */

/** One place to stand at a stop, and the platforms there. */
export type BoardingPlace = {
  /** Stable across refreshes, so a chosen place survives. */
  id: string;
  /**
   * The operator's name for it, bracketed into the stop point's name (`Marktplatz (Pyramide U)`).
   * Without one, the platforms are the name.
   */
  label?: string;
  /** The platform codes standing here, in the order a board lists them. */
  platformCodes: readonly string[];
  /** The platform kind all platforms here share, if they do. */
  platformKind?: PlatformKind;
  providerStopPointId: string;
};

/** Where a stop's departures leave from; empty where no platform is stated. */
export type StopBoardingPlaces = readonly BoardingPlace[];

/**
 * What a visit has learned about a stop's places. Accumulated, because the boards carrying calling
 * sequences arrive on their own cadence, and a separation once observed stays true.
 */
export type StopBoardingObservations = {
  stopId: string;
  /** Every platform seen, and what is known about each. */
  platforms: ReadonlyMap<PlatformKey, PlatformReading>;
  /** Pairs some trip called at in turn: the operator parting them. */
  separated: ReadonlySet<string>;
  /**
   * Pairs some reading showed to be a vehicle turning, which vetoes a separation. Kept apart
   * because only readings where neither call is the board's own carry the mark (Turmberg's buses
   * lay over between `Bstg. A` and `Bstg. D`).
   */
  turnedAround: ReadonlySet<string>;
};

const createStopBoardingObservations = (stopId: string): StopBoardingObservations => ({
  stopId,
  platforms: new Map(),
  separated: new Set(),
  turnedAround: new Set(),
});

/** The memory updated by these departures; the same object when nothing was added. */
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
    // A place has one word on its sign; disagreeing rows give none.
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

/** The stop's places from what the visit learned; one place unless platforms were seen parted. */
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
 * Adds platform codes to labels shared by several places: `Hauptbahnhof (Vorplatz)` covers both the
 * bus bays and the tram platforms, which buses 62 and 50 part.
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

/** The place a departure leaves from, if this reading places it. */
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

/** The one place all these departures leave from, if they share one. */
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

/** A place's heading: the operator's word, else its platforms. */
export const getBoardingPlaceLabel = (place: BoardingPlace): string =>
  place.label ?? place.platformCodes.join(" · ");

/** One platform of one stop point; places are built from these. */
type PlatformKey = string;
const getPlatformKey = (providerStopPointId: string, platformCode: string): PlatformKey =>
  `${providerStopPointId}\u0000${platformCode}`;

type PlatformReading = {
  providerStopPointId: string;
  platformCode: string;
  platformKind?: PlatformKind;
  providerStopPointName: string;
  latitude?: number;
  longitude?: number;
};

/** Each platform's position, from the departure's calls (rows state none). */
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
 * Consecutive calls at one stop: either travel between platforms, the only statement separating
 * Europaplatz's `Gleis 3` and `Gleis 5` (110 m apart, one stop point), or a turnaround, which the
 * feed marks only where neither call is the board's own.
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
    // The same platform twice is a restated call.
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

/** Order-free key for a pair. */
const getSeparationKey = (left: PlatformKey, right: PlatformKey): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

/**
 * Platforms clustered into places: the nearest clusters merge until every remaining merge is
 * forbidden by an observed separation, a different stop point (levels never merge), or a different
 * platform kind. Distance only orders merges, so platforms are parted only by evidence.
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
        // Merge even unmeasured platforms: positions arrive only with the slower sequence-carrying
        // boards.
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

/** Distance between the nearest members; unplaced platforms are infinitely far, so merge last. */
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
 * The operator's name for one part of a place, from the bracketed aside (`Marktplatz (Pyramide U)`,
 * `Europaplatz (U)`). `getBaseName` reads the other half.
 */
function findStopPointLabel(providerStopPointName: string): string | undefined {
  const bracketed = /\(([^)]+)\)\s*$/.exec(providerStopPointName)?.[1]?.trim();
  return bracketed && getBaseName(providerStopPointName) !== providerStopPointName
    ? bracketed
    : undefined;
}

/** Platform order, matching the platform signposts; board order would reshuffle every refresh. */
function compareBoardingPlaces(left: BoardingPlace, right: BoardingPlace): number {
  return compareGermanNames(left.platformCodes[0], right.platformCodes[0]);
}
