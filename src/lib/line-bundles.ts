import type { Departure, DepartureBoard, TransportMode, TripCall } from "../data/transit-types";
import { compareLineIds, getLineFamilyId, isSameLineFamily } from "./line-families";
import { findStopCorridorPattern, type StopCorridorPatterns } from "./stop-corridor-patterns";
import {
  getCallSequenceKey,
  getCallsPastIndex,
  getCommonCallPrefix,
  getCommonCallPrefixAlignment,
} from "./trip-calls";

/**
 * Reading two lines as one along the stretch they share (S1 and S11 from Hochstetten). A bundle is
 * a rider-chosen view of a corridor at one stop, drawn only as far as the lines were observed
 * together; line identity stays per line (`line-families.ts`).
 */
export type LineSelection = {
  /** The line the address names, which draws the diagram and gives the colour. */
  lineId: string;
  /** Siblings the rider added; empty for a single line. */
  bundledLineIds: readonly string[];
};

/** `+` is literal in a fragment path and line ids are alphanumeric, so no escaping is needed. */
const LINE_BUNDLE_SEPARATOR = "+";

/** Siblings one line may be read with, kept small so the offer is a glance-sized decision. */
export const MAX_BUNDLED_LINES = 2;

/**
 * Shared calls needed before a sibling is offered: one shared link says nothing about a stretch.
 */
const MIN_LINE_BUNDLE_SHARED_CALLS = 3;

export const createLineSelection = (
  lineId: string,
  bundledLineIds: readonly string[] = [],
): LineSelection => ({ lineId, bundledLineIds });

/** Primary first, as the address and diagram order them. */
export function getLineSelectionIds({ lineId, bundledLineIds }: LineSelection): readonly string[] {
  return lineId ? [lineId, ...bundledLineIds] : [];
}

export const isSelectedLine = (selection: LineSelection, lineId: string): boolean =>
  getLineSelectionIds(selection).some((selected) => isSameLineFamily(selected, lineId));

/**
 * The addressed siblings this stop answers for. The address stands until a live whole-stop board
 * arrives; then its `servingLines` decide (rows only as a fallback), since a line can serve a busy
 * stop without winning a row.
 */
export function getResolvedBundledLineIds(
  bundledLineIds: readonly string[],
  departureBoard: DepartureBoard | null,
): readonly string[] {
  if (departureBoard?.dataStatus !== "live") return bundledLineIds;

  return bundledLineIds.filter(
    (lineId) =>
      departureBoard.servingLines?.some(
        (servingLine) => servingLine.lineId && isSameLineFamily(servingLine.lineId, lineId),
      ) ||
      departureBoard.departures.some((departure) => isSameLineFamily(departure.lineId, lineId)),
  );
}

/** A line path segment. Duplicate or empty ids are dropped, since the segment is hand-editable. */
export function parseLineSelection(segment: string): LineSelection {
  const [lineId = "", ...rest] = segment
    .split(LINE_BUNDLE_SEPARATOR)
    .map((id) => getLineFamilyId(id.trim()))
    .filter(Boolean);
  const bundledLineIds = [...new Set(rest)]
    .filter((id) => !isSameLineFamily(id, lineId))
    .slice(0, MAX_BUNDLED_LINES);
  return { lineId, bundledLineIds };
}

export const formatLineSelection = (selection: LineSelection): string =>
  getLineSelectionIds(selection).join(LINE_BUNDLE_SEPARATOR);

/** A sibling worth offering, and the stretches the offer could cover. */
export type LineBundleOffer = {
  lineId: string;
  /**
   * Every stretch both lines were observed running together past this stop, longest first. Several,
   * because two lines may share a stretch out of each end (S1/S11 at Ettlingen Neuwiesenreben: 39
   * calls north, six south), and the drawn trip picks which applies.
   */
  sharedRoutes: readonly (readonly TripCall[])[];
};

/** An offer read against the drawn trip: the stretch it promises and the stop that ends it. */
export type DrawableLineBundleOffer = {
  lineId: string;
  sharedCalls: readonly TripCall[];
  /** Where the lines part. */
  sharedUntilStopName: string;
};

const toDrawableLineBundleOffer = (
  lineId: string,
  sharedCalls: readonly TripCall[],
): DrawableLineBundleOffer => ({
  lineId,
  sharedCalls,
  sharedUntilStopName: sharedCalls[sharedCalls.length - 1]?.stopName ?? "",
});

const EMPTY_DRAWABLE_OFFERS: readonly DrawableLineBundleOffer[] = [];

/**
 * The offers that apply to the drawn trip. Corridors are direction-blind, so each is tried against
 * the drawn chain on both sides of the rider's stop, and capped at the calls the trip confirms.
 */
export function getDrawableLineBundleOffers({
  offers,
  drawnCalls,
  riderStopIds,
}: {
  offers: readonly LineBundleOffer[];
  drawnCalls: readonly TripCall[];
  riderStopIds: readonly string[];
}): readonly DrawableLineBundleOffer[] {
  if (offers.length === 0) return EMPTY_DRAWABLE_OFFERS;
  const riderStopIndex = drawnCalls.findIndex(
    (call) => call.localStopId && riderStopIds.includes(call.localStopId),
  );
  const drawnAhead = getCallsPastIndex(drawnCalls, riderStopIndex);
  // The calls behind the stop, reversed into travel order out of it.
  const drawnBehind = getCallsPastIndex(
    [...drawnCalls].reverse(),
    drawnCalls.length - 1 - riderStopIndex,
  );
  return offers.flatMap((offer) => {
    const sharedCalls = findDrawnSharedCalls(offer, drawnAhead, drawnBehind);
    return sharedCalls ? [toDrawableLineBundleOffer(offer.lineId, sharedCalls)] : [];
  });
}

/** The longest shared stretch the drawn trip follows; ahead wins a tie. */
function findDrawnSharedCalls(
  offer: LineBundleOffer,
  drawnAhead: readonly TripCall[],
  drawnBehind: readonly TripCall[],
): readonly TripCall[] | undefined {
  let best: readonly TripCall[] = [];
  for (const drawn of [drawnAhead, drawnBehind]) {
    for (const sharedRoute of offer.sharedRoutes) {
      const common = getCommonCallPrefix([drawn, sharedRoute]);
      if (common.length > best.length) best = common;
    }
  }
  return best.length >= MIN_LINE_BUNDLE_SHARED_CALLS ? best : undefined;
}

type ObservedLineRoutes = {
  transportMode: TransportMode;
  routes: (readonly TripCall[])[];
};

/** The routes out of this stop observed so far, by line. Only full routes count. */
function collectObservedLineRoutes(
  departures: readonly Departure[],
  patterns: StopCorridorPatterns,
): Map<string, ObservedLineRoutes> {
  const byLine = new Map<string, ObservedLineRoutes>();
  const seenSequences = new Map<string, Set<string>>();

  for (const departure of departures) {
    const match = findStopCorridorPattern(patterns, departure);
    if (!match?.hasFullRoute || match.calls.length === 0) continue;

    const lineId = getLineFamilyId(departure.lineId);
    const sequenceKey = getCallSequenceKey(match.calls);
    const seen = seenSequences.get(lineId) ?? new Set<string>();
    if (seen.has(sequenceKey)) continue;
    seen.add(sequenceKey);
    seenSequences.set(lineId, seen);

    const entry = byLine.get(lineId) ?? { transportMode: departure.transportMode, routes: [] };
    entry.routes.push(match.calls);
    byLine.set(lineId, entry);
  }

  return byLine;
}

/**
 * The lines this one could be read with here, from routes already observed for this board (no
 * fetches, no authored bundles). Same mode only, since tram and S-Bahn use different platforms.
 */
export function findLineBundleOffers({
  lineId,
  departures,
  patterns,
}: {
  lineId: string;
  departures: readonly Departure[];
  patterns: StopCorridorPatterns;
}): readonly LineBundleOffer[] {
  if (!lineId) return [];
  const byLine = collectObservedLineRoutes(departures, patterns);
  const primary = byLine.get(getLineFamilyId(lineId));
  if (!primary) return [];

  const offers: LineBundleOffer[] = [];
  for (const [candidateId, candidate] of byLine) {
    if (isSameLineFamily(candidateId, lineId)) continue;
    if (candidate.transportMode !== primary.transportMode) continue;

    // Each pairing of the two lines' routes (short workings, through services, directions) is a
    // candidate corridor.
    const shared: (readonly TripCall[])[] = [];
    for (const primaryRoute of primary.routes) {
      for (const candidateRoute of candidate.routes) {
        const common = getCommonCallPrefix([primaryRoute, candidateRoute]);
        if (common.length >= MIN_LINE_BUNDLE_SHARED_CALLS) shared.push(common);
      }
    }
    const sharedRoutes = keepLongestSharedRoutes(shared);
    if (sharedRoutes.length === 0) continue;

    offers.push({ lineId: candidateId, sharedRoutes });
  }

  // Not capped here: which siblings can be drawn beside the trip is not known yet.
  return offers.sort(
    (first, second) =>
      second.sharedRoutes[0].length - first.sharedRoutes[0].length ||
      compareLineIds(first.lineId, second.lineId),
  );
}

/**
 * The longest corridor of each pairing, longest first; a short working yields prefixes of the
 * through service's corridor, which add nothing.
 */
function keepLongestSharedRoutes(
  routes: readonly (readonly TripCall[])[],
): readonly (readonly TripCall[])[] {
  const kept: (readonly TripCall[])[] = [];
  for (const route of [...routes].sort((first, second) => second.length - first.length)) {
    if (
      kept.some(
        (existing) =>
          getCommonCallPrefixAlignment([route, existing]).consumedCallCounts[0] === route.length,
      )
    ) {
      continue;
    }
    kept.push(route);
  }
  return kept;
}

export type LineBundleChain = {
  lineId: string;
  calls: readonly TripCall[];
  /** The headsign, which the split is worded in. */
  destination: string;
};

/** Where one bundled line goes past the shared stretch. */
export type LineBundleBranch = {
  lineId: string;
  /** `ahead` is past the last shared call in travel order; `behind` is before the first. */
  direction: "ahead" | "behind";
  /** The end this line runs to that way. */
  destination: string;
  /** False where this line ends at the shared stretch: the pair's short working. */
  continues: boolean;
  /**
   * The branch in travel order, keeping the parting call at its trunk end so its first link can
   * carry a vehicle. Empty where the line does not run past the stretch; that is stated in words.
   */
  calls: readonly TripCall[];
};

/**
 * The stretch the bundled lines share, measured outwards from the rider's stop (the one point all
 * share), and what happens at each end. Nothing where the trunk would be one stop or misses the
 * stop.
 */
export function getLineBundleTrunk(
  chains: readonly LineBundleChain[],
  riderStopIds: readonly string[],
): { calls: readonly TripCall[]; branches: readonly LineBundleBranch[] } | undefined {
  if (chains.length < 2) return undefined;

  const riderIndexes = chains.map(({ calls }) =>
    calls.findIndex((call) => call.localStopId && riderStopIds.includes(call.localStopId)),
  );
  if (riderIndexes.some((index) => index < 0)) return undefined;

  // Align consecutive platforms of one stop as a run, so they do not shift later stops into a false
  // fork.
  const ahead = getCommonCallPrefixAlignment(
    chains.map(({ calls }, index) => calls.slice(riderIndexes[index] + 1)),
  );
  const behind = getCommonCallPrefixAlignment(
    chains.map(({ calls }, index) => [...calls.slice(0, riderIndexes[index])].reverse()),
  );
  const calls = [...[...behind.calls].reverse(), chains[0].calls[riderIndexes[0]], ...ahead.calls];
  if (calls.length < 2) return undefined;

  // Whether a line is the short working is known only after every chain is measured.
  const continuesAhead = chains.map(
    (chain, index) =>
      chain.calls.length - riderIndexes[index] - 1 > ahead.consumedCallCounts[index],
  );
  const continuesBehind = riderIndexes.map(
    (riderIndex, index) => riderIndex > behind.consumedCallCounts[index],
  );
  const junctionAhead = calls[calls.length - 1];
  const junctionBehind = calls[0];
  const branches: LineBundleBranch[] = [];
  if (continuesAhead.some(Boolean)) {
    branches.push(
      ...chains.map((chain, index) => ({
        lineId: chain.lineId,
        direction: "ahead" as const,
        destination: chain.destination,
        continues: continuesAhead[index],
        calls: continuesAhead[index]
          ? [
              junctionAhead,
              ...chain.calls.slice(riderIndexes[index] + 1 + ahead.consumedCallCounts[index]),
            ]
          : [],
      })),
    );
  }
  if (continuesBehind.some(Boolean)) {
    branches.push(
      ...chains.map((chain, index) => ({
        lineId: chain.lineId,
        direction: "behind" as const,
        destination: chain.calls[0].stopName,
        continues: continuesBehind[index],
        calls: continuesBehind[index]
          ? [
              ...chain.calls.slice(0, riderIndexes[index] - behind.consumedCallCounts[index]),
              junctionBehind,
            ]
          : [],
      })),
    );
  }

  return { calls, branches };
}

/**
 * The sibling's trip that runs with the primary farthest; the opposite direction scores nothing.
 */
export function chooseLineBundleChain(
  primary: LineBundleChain,
  candidates: readonly LineBundleChain[],
  riderStopIds: readonly string[],
): LineBundleChain | undefined {
  let best: { chain: LineBundleChain; trunkLength: number; chainLength: number } | undefined;
  for (const candidate of candidates) {
    const trunk = getLineBundleTrunk([primary, candidate], riderStopIds);
    if (!trunk) continue;
    if (
      !best ||
      trunk.calls.length > best.trunkLength ||
      (trunk.calls.length === best.trunkLength && candidate.calls.length > best.chainLength)
    ) {
      best = {
        chain: candidate,
        trunkLength: trunk.calls.length,
        chainLength: candidate.calls.length,
      };
    }
  }
  return best?.chain;
}

/**
 * The lines that end at the junction, in words: boarding the short working believing it runs the
 * corridor is the mistake the bundle exists to prevent.
 */
export function getLineBundleTerminatingLabel(
  branches: readonly LineBundleBranch[],
  direction: "ahead" | "behind",
  junctionStopName: string,
): string | undefined {
  const terminating = branches.filter(
    (branch) => branch.direction === direction && !branch.continues,
  );
  if (terminating.length === 0) return undefined;
  const lineIds = terminating.map(({ lineId }) => lineId).join(", ");
  return direction === "ahead"
    ? `${lineIds} endet in ${junctionStopName}`
    : `${lineIds} beginnt in ${junctionStopName}`;
}

/** A line runs at most one way out of each end of the shared stretch. */
export const getLineBundleBranchKey = ({ direction, lineId }: LineBundleBranch): string =>
  `${direction}-${lineId}`;

/** Legs with a chain to draw; a line ending at the junction has none. */
export const getDrawableLineBundleBranches = (
  branches: readonly LineBundleBranch[],
  direction: "ahead" | "behind",
): readonly LineBundleBranch[] =>
  branches.filter((branch) => branch.direction === direction && branch.calls.length > 1);

/**
 * The distinct destinations leaving one end of the corridor, in line order; the trunk's end where
 * it does not fork.
 */
export function getLineBundleTermini(
  branches: readonly LineBundleBranch[],
  direction: "ahead" | "behind",
  fallback: string,
): readonly string[] {
  const names = branches
    .filter((branch) => branch.direction === direction)
    .map(({ destination }) => destination.trim())
    .filter(Boolean);
  const distinctNames = [...new Set(names)];
  return distinctNames.length > 0 ? distinctNames : fallback ? [fallback] : [];
}

export type LineBundleControl = {
  lineId: string;
  /** Whether this line is already read along. */
  isActive: boolean;
  /** The bundle the control navigates to. */
  next: readonly string[];
  label: string;
  /** The stop the offer reaches; not repeated once taken, since the diagram then names it. */
  sharedUntilStopName?: string;
};

/**
 * The bundle controls: active siblings, then offers with room left under `MAX_BUNDLED_LINES`. An
 * offer for an active line is dropped.
 */
export function getLineBundleControls(
  bundledLineIds: readonly string[],
  offers: readonly DrawableLineBundleOffer[],
): readonly LineBundleControl[] {
  const room = MAX_BUNDLED_LINES - bundledLineIds.length;
  return [
    ...bundledLineIds.map((lineId) => ({
      lineId,
      isActive: true,
      next: bundledLineIds.filter((candidate) => candidate !== lineId),
      label: `${lineId} nicht mehr bündeln`,
    })),
    ...(room > 0 ? offers : [])
      .filter(({ lineId }) => !bundledLineIds.includes(lineId))
      .slice(0, room)
      .map(({ lineId, sharedUntilStopName }) => ({
        lineId,
        isActive: false,
        next: [...bundledLineIds, lineId],
        label: `Mit ${lineId} bündeln, gleicher Weg bis ${sharedUntilStopName}`,
        sharedUntilStopName,
      })),
  ];
}
