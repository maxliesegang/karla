import type { StopEvent, BayKind, Call } from "../data/transit-types";
import { getDistanceMeters } from "./geo";
import { getBaseName } from "./stop-naming";
import { compareGermanNames } from "./text";
import { isTurnaroundPair } from "./calls";

/**
 * Boarding places: the parts of a stop a rider chooses between before walking (Marktplatz's two
 * tunnels; Europaplatz's street bays, two stops under one stop point id). EFA answers for the
 * whole complex, so the board is split here, derived from observed journeys rather than authored.
 */

/** One place to stand at a stop, and the bays there. */
export type BoardingPlace = {
  /** Stable across refreshes, so a chosen place survives. */
  id: string;
  /**
   * The operator's name for it, bracketed into the stop point's name (`Marktplatz (Pyramide U)`).
   * Without one, the bays are the name.
   */
  label?: string;
  /** The bay codes standing here, in the order a board lists them. */
  bays: readonly string[];
  /** The bay kind all bays here share, if they do. */
  bayKind?: BayKind;
  providerStopPointId: string;
};

/** Where a stop's departures leave from; empty where no bay is stated. */
export type StopBoardingPlaces = readonly BoardingPlace[];

/**
 * What a visit has learned about a stop's places. Accumulated, because the boards carrying calling
 * sequences arrive on their own cadence, and a separation once observed stays true.
 */
export type StopBoardingObservations = {
  stopId: string;
  /** Every bay seen, and what is known about each. */
  bays: ReadonlyMap<BayKey, BayReading>;
  /** Pairs some journey called at in turn: the operator parting them. */
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
  bays: new Map(),
  separated: new Set(),
  turnedAround: new Set(),
});

/** The memory updated by these departures; the same object when nothing was added. */
export function updateStopBoardingObservations(
  previous: StopBoardingObservations | null,
  stopId: string,
  stopEvents: readonly StopEvent[],
): StopBoardingObservations {
  const base =
    previous && previous.stopId === stopId ? previous : createStopBoardingObservations(stopId);
  const bays = new Map(base.bays);
  const separated = new Set(base.separated);
  const turnedAround = new Set(base.turnedAround);
  let learned = false;

  for (const stopEvent of stopEvents) {
    if (stopEvent.boardingLocalStopId !== stopId) continue;
    if (!stopEvent.bay || !stopEvent.boardingProviderStopPointId) continue;
    const key = getBayKey(stopEvent.boardingProviderStopPointId, stopEvent.bay);
    const known = bays.get(key);
    if (!known) {
      bays.set(key, {
        providerStopPointId: stopEvent.boardingProviderStopPointId,
        bay: stopEvent.bay,
        bayKind: stopEvent.bayKind,
        providerStopPointName: stopEvent.boardingProviderStopPointName,
      });
      learned = true;
      continue;
    }
    // A place has one word on its sign; disagreeing rows give none.
    if (known.bayKind !== undefined && known.bayKind !== stopEvent.bayKind) {
      bays.set(key, { ...known, bayKind: undefined });
      learned = true;
    }
  }

  for (const stopEvent of stopEvents) {
    learned = readBayPositions(bays, stopId, stopEvent) || learned;
    learned = readCallPairs(separated, turnedAround, stopId, stopEvent) || learned;
  }

  return learned ? { stopId, bays, separated, turnedAround } : base;
}

/** The stop's places from what the visit learned; one place unless bays were seen parted. */
export function getStopBoardingPlaces(observations: StopBoardingObservations): StopBoardingPlaces {
  if (observations.bays.size === 0) return [];
  const separated = new Set(
    [...observations.separated].filter((pair) => !observations.turnedAround.has(pair)),
  );
  const clusters = clusterBays([...observations.bays.values()], separated);
  const places = clusters.map(toBoardingPlace).sort(compareBoardingPlaces);
  return disambiguateSharedLabels(places);
}

/**
 * Adds bay codes to labels shared by several places: `Hauptbahnhof (Vorplatz)` covers both the
 * bus bays and the tram bays, which buses 62 and 50 part.
 */
function disambiguateSharedLabels(places: readonly BoardingPlace[]): BoardingPlace[] {
  const countByLabel = new Map<string, number>();
  for (const { label } of places) {
    if (label) countByLabel.set(label, (countByLabel.get(label) ?? 0) + 1);
  }
  return places.map((place) =>
    place.label && (countByLabel.get(place.label) ?? 0) > 1
      ? { ...place, label: `${place.label} ${place.bays.join(" · ")}` }
      : place,
  );
}

/** The place a departure leaves from, if this reading places it. */
export function findBoardingPlace(
  boardingPlaces: StopBoardingPlaces,
  stopEvent: StopEvent,
): BoardingPlace | undefined {
  return boardingPlaces.find(
    (place) =>
      place.providerStopPointId === stopEvent.boardingProviderStopPointId &&
      place.bays.includes(stopEvent.bay),
  );
}

/** The one place all these departures leave from, if they share one. */
export function findSharedBoardingPlace(
  boardingPlaces: StopBoardingPlaces,
  stopEvents: readonly StopEvent[],
): BoardingPlace | undefined {
  if (boardingPlaces.length < 2 || stopEvents.length === 0) return undefined;
  const [first, ...rest] = stopEvents.map((stopEvent) =>
    findBoardingPlace(boardingPlaces, stopEvent),
  );
  return first && rest.every((place) => place === first) ? first : undefined;
}

/** A place's heading: the operator's word, else its bays. */
export const getBoardingPlaceLabel = (place: BoardingPlace): string =>
  place.label ?? place.bays.join(" · ");

/** One bay of one stop point; places are built from these. */
type BayKey = string;
const getBayKey = (providerStopPointId: string, bay: string): BayKey =>
  `${providerStopPointId}\u0000${bay}`;

type BayReading = {
  providerStopPointId: string;
  bay: string;
  bayKind?: BayKind;
  providerStopPointName: string;
  latitude?: number;
  longitude?: number;
};

/** Each bay's position, from the departure's calls (rows state none). */
function readBayPositions(
  bays: Map<BayKey, BayReading>,
  stopId: string,
  stopEvent: StopEvent,
): boolean {
  let learned = false;
  for (const call of stopEvent.calls ?? []) {
    if (call.localStopId !== stopId || !call.providerStopPointId || !call.bay) continue;
    const key = getBayKey(call.providerStopPointId, call.bay);
    const bay = bays.get(key);
    if (!bay || bay.latitude !== undefined) continue;
    if (call.latitude === undefined || call.longitude === undefined) continue;
    bays.set(key, { ...bay, latitude: call.latitude, longitude: call.longitude });
    learned = true;
  }
  return learned;
}

/**
 * Consecutive calls at one stop: either travel between bays, the only statement separating
 * Europaplatz's `Gleis 3` and `Gleis 5` (110 m apart, one stop point), or a turnaround, which the
 * feed marks only where neither call is the board's own.
 */
function readCallPairs(
  separated: Set<string>,
  turnedAround: Set<string>,
  stopId: string,
  stopEvent: StopEvent,
): boolean {
  const calls = stopEvent.calls ?? [];
  let learned = false;
  for (let index = 1; index < calls.length; index += 1) {
    const previous = calls[index - 1];
    const call = calls[index];
    if (previous.localStopId !== stopId || call.localStopId !== stopId) continue;
    const left = toCallBayKey(previous);
    const right = toCallBayKey(call);
    // The same bay twice is a restated call.
    if (!left || !right || left === right) continue;
    const key = getSeparationKey(left, right);
    const gathered = isTurnaroundPair(previous, call) ? turnedAround : separated;
    if (gathered.has(key)) continue;
    gathered.add(key);
    learned = true;
  }
  return learned;
}

const toCallBayKey = (call: Call): BayKey | undefined =>
  call.providerStopPointId && call.bay ? getBayKey(call.providerStopPointId, call.bay) : undefined;

/** Order-free key for a pair. */
const getSeparationKey = (left: BayKey, right: BayKey): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

/**
 * Bays clustered into places: the nearest clusters merge until every remaining merge is
 * forbidden by an observed separation, a different stop point (levels never merge), or a different
 * bay kind. Distance only orders merges, so bays are parted only by evidence.
 */
function clusterBays(bays: readonly BayReading[], separated: ReadonlySet<string>): BayReading[][] {
  const clusters = bays.map((bay) => [bay]);

  for (;;) {
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestPair: [number, number] | undefined;
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        if (!canMerge(clusters[left], clusters[right], separated)) continue;
        const distance = getClusterDistance(clusters[left], clusters[right]);
        // Merge even unmeasured bays: positions arrive only with the slower sequence-carrying
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
  left: readonly BayReading[],
  right: readonly BayReading[],
  separated: ReadonlySet<string>,
): boolean {
  for (const here of left) {
    for (const there of right) {
      if (here.providerStopPointId !== there.providerStopPointId) return false;
      if (here.bayKind !== there.bayKind) return false;
      const key = getSeparationKey(
        getBayKey(here.providerStopPointId, here.bay),
        getBayKey(there.providerStopPointId, there.bay),
      );
      if (separated.has(key)) return false;
    }
  }
  return true;
}

/** Distance between the nearest members; unplaced bays are infinitely far, so merge last. */
function getClusterDistance(left: readonly BayReading[], right: readonly BayReading[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const here of left) {
    if (here.latitude === undefined || here.longitude === undefined) continue;
    for (const there of right) {
      nearest = Math.min(nearest, getDistanceMeters(here.latitude, here.longitude, there));
    }
  }
  return nearest;
}

function toBoardingPlace(cluster: readonly BayReading[]): BoardingPlace {
  const bays = [...cluster].sort((left, right) => compareGermanNames(left.bay, right.bay));
  const [first] = bays;
  const kinds = new Set(bays.map((bay) => bay.bayKind));
  return {
    id: `${first.providerStopPointId}-${bays.map(({ bay }) => bay).join("-")}`,
    label: findStopPointLabel(first.providerStopPointName),
    bays: bays.map(({ bay }) => bay),
    bayKind: kinds.size === 1 ? [...kinds][0] : undefined,
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

/** Bay order, matching the bay signposts; board order would reshuffle every refresh. */
function compareBoardingPlaces(left: BoardingPlace, right: BoardingPlace): number {
  return compareGermanNames(left.bays[0], right.bays[0]);
}
