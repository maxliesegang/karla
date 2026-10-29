import type { StopEvent, StopEventBoard, PtMode, Call, TransitLine } from "../data/transit-types";
import { compareLines, isNetworkLineIdentity } from "./network-lines";
import { getLineIdentity, isRowOfLine, type LineNaming } from "./line-identity";
import { findStopCorridorPattern, type StopCorridorPatterns } from "./stop-corridor-patterns";
import {
  getCallSequenceKey,
  getCallsPastIndex,
  getCommonCallPrefix,
  getCommonCallPrefixAlignment,
} from "./calls";

/**
 * Reading two lines as one along the stretch they share (S1 and S11 from Hochstetten). A bundle is
 * a rider-chosen view of a corridor at one stop, drawn only as far as the lines were observed
 * together; line identity stays per line (`line-identity.ts`).
 */
export type LineSelection = {
  /** The line the address names, which draws the diagram and gives the colour. */
  lineId: string;
  /** Siblings the rider added; empty for a single line. */
  bundledLineIds: readonly string[];
  /** Each line's identity, by name, once resolved against a stop's rows (`line-identity.ts`). */
  lineIdentities?: ReadonlyMap<string, string>;
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
  lineIdentities?: ReadonlyMap<string, string>,
): LineSelection =>
  lineIdentities?.size ? { lineId, bundledLineIds, lineIdentities } : { lineId, bundledLineIds };

/** The selection of these lines, with the identities their signs carry. */
export const createLineSelectionOf = (
  line: Pick<TransitLine, "id" | "identity">,
  bundledLines: readonly Pick<TransitLine, "id" | "identity">[] = [],
): LineSelection =>
  createLineSelection(
    line.id,
    bundledLines.map(({ id }) => id),
    new Map(
      [line, ...bundledLines].flatMap(({ id, identity }) =>
        identity ? [[id, identity] as const] : [],
      ),
    ),
  );

/** Primary first, as the address and diagram order them. */
export function getLineSelectionIds({ lineId, bundledLineIds }: LineSelection): readonly string[] {
  return lineId ? [lineId, ...bundledLineIds] : [];
}

export const getSelectedLineIdentity = (
  selection: LineSelection,
  lineId: string,
): string | undefined => selection.lineIdentities?.get(lineId);

/** A row of one of the selected lines: by name, and by identity where both state one. */
export const isSelectedLine = (selection: LineSelection, row: LineNaming): boolean =>
  getLineSelectionIds(selection).some((selected) =>
    isRowOfLine(row, selected, getSelectedLineIdentity(selection, selected)),
  );

/**
 * The addressed siblings this stop answers for. The address stands until a live whole-stop board
 * arrives; then its `servingLines` decide (rows only as a fallback), since a line can serve a busy
 * stop without winning a row.
 */
export function getResolvedBundledLineIds(
  bundledLineIds: readonly string[],
  stopEventBoard: StopEventBoard | null,
): readonly string[] {
  if (stopEventBoard?.dataStatus !== "live") return bundledLineIds;

  return bundledLineIds.filter(
    (lineId) =>
      stopEventBoard.servingLines?.some((servingLine) => servingLine.lineId === lineId) ||
      stopEventBoard.stopEvents.some((stopEvent) => stopEvent.lineId === lineId),
  );
}

/** Before another operator's line identity in a line segment (`S1@ddb:920S1`). */
const LINE_IDENTITY_SEPARATOR = "@";
const LINE_IDENTITY_PATTERN = /^[a-z]+:[A-Za-z0-9]+$/;

/**
 * A line path segment. Duplicate or empty ids are dropped, since the segment is hand-editable. Only
 * the addressed line carries an identity; siblings are the network's.
 */
export function parseLineSelection(segment: string): LineSelection {
  const [primary = "", ...rest] = segment
    .split(LINE_BUNDLE_SEPARATOR)
    .map((id) => id.trim())
    .filter(Boolean);
  const [lineId = "", identity] = primary.split(LINE_IDENTITY_SEPARATOR);
  const bundledLineIds = [...new Set(rest)]
    .filter((id) => id !== lineId && !id.includes(LINE_IDENTITY_SEPARATOR))
    .slice(0, MAX_BUNDLED_LINES);
  return createLineSelection(
    lineId,
    bundledLineIds,
    identity && LINE_IDENTITY_PATTERN.test(identity) ? new Map([[lineId, identity]]) : undefined,
  );
}

/** The network's lines go by name alone; another operator's line adds its identity. */
export function formatLineSelection(selection: LineSelection): string {
  if (!selection.lineId) return "";
  const identity = getSelectedLineIdentity(selection, selection.lineId);
  const primary = isNetworkLineIdentity(identity)
    ? selection.lineId
    : `${selection.lineId}${LINE_IDENTITY_SEPARATOR}${identity}`;
  return [primary, ...selection.bundledLineIds].join(LINE_BUNDLE_SEPARATOR);
}

/** A sibling worth offering, and the stretches the offer could cover. */
export type LineBundleOffer = {
  lineId: string;
  identity?: string;
  /**
   * Every stretch both lines were observed running together past this stop, longest first. Several,
   * because two lines may share a stretch out of each end (S1/S11 at Ettlingen Neuwiesenreben: 39
   * calls north, six south), and the drawn journey picks which applies.
   */
  sharedRoutes: readonly (readonly Call[])[];
};

/** An offer read against the drawn journey: the stretch it promises and the stop that ends it. */
export type DrawableLineBundleOffer = {
  lineId: string;
  sharedCalls: readonly Call[];
  /** Where the lines part. */
  sharedUntilStopName: string;
};

const toDrawableLineBundleOffer = (
  lineId: string,
  sharedCalls: readonly Call[],
): DrawableLineBundleOffer => ({
  lineId,
  sharedCalls,
  sharedUntilStopName: sharedCalls[sharedCalls.length - 1]?.stopName ?? "",
});

const EMPTY_DRAWABLE_OFFERS: readonly DrawableLineBundleOffer[] = [];

/**
 * The offers that apply to the drawn journey. Corridors are direction-blind, so each is tried
 * against the drawn chain on both sides of the rider's stop, and capped at the calls the journey
 * confirms.
 */
export function getDrawableLineBundleOffers({
  offers,
  drawnCalls,
  riderStopIds,
}: {
  offers: readonly LineBundleOffer[];
  drawnCalls: readonly Call[];
  riderStopIds: readonly string[];
}): readonly DrawableLineBundleOffer[] {
  if (offers.length === 0) return EMPTY_DRAWABLE_OFFERS;
  const riderStopIndex = drawnCalls.findIndex(
    (call) => call.stopPlaceId && riderStopIds.includes(call.stopPlaceId),
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

/** The longest shared stretch the drawn journey follows; ahead wins a tie. */
function findDrawnSharedCalls(
  offer: LineBundleOffer,
  drawnAhead: readonly Call[],
  drawnBehind: readonly Call[],
): readonly Call[] | undefined {
  let best: readonly Call[] = [];
  for (const drawn of [drawnAhead, drawnBehind]) {
    for (const sharedRoute of offer.sharedRoutes) {
      const common = getCommonCallPrefix([drawn, sharedRoute]);
      if (common.length > best.length) best = common;
    }
  }
  return best.length >= MIN_LINE_BUNDLE_SHARED_CALLS ? best : undefined;
}

type ObservedLineRoutes = {
  ptMode: PtMode;
  identity?: string;
  routes: (readonly Call[])[];
};

/** The routes out of this stop observed so far, by line. Only full routes count. */
function collectObservedLineRoutes(
  stopEvents: readonly StopEvent[],
  patterns: StopCorridorPatterns,
  primaryLineId: string,
  primaryIdentity: string | undefined,
): Map<string, ObservedLineRoutes> {
  const byLine = new Map<string, ObservedLineRoutes>();
  const seenSequences = new Map<string, Set<string>>();

  for (const stopEvent of stopEvents) {
    // Another network's line of the same name is neither the line nor a sibling.
    if (
      stopEvent.lineId === primaryLineId &&
      !isRowOfLine(stopEvent, primaryLineId, primaryIdentity)
    )
      continue;
    const match = findStopCorridorPattern(patterns, stopEvent);
    if (!match?.hasFullRoute || match.calls.length === 0) continue;

    const lineId = stopEvent.lineId;
    const sequenceKey = getCallSequenceKey(match.calls);
    const seen = seenSequences.get(lineId) ?? new Set<string>();
    if (seen.has(sequenceKey)) continue;
    seen.add(sequenceKey);
    seenSequences.set(lineId, seen);

    const identity = getLineIdentity(stopEvent.lineRef);
    const entry = byLine.get(lineId) ?? {
      ptMode: stopEvent.ptMode,
      ...(identity ? { identity } : {}),
      routes: [],
    };
    entry.routes.push(match.calls);
    byLine.set(lineId, entry);
  }

  return byLine;
}

/**
 * The lines this one could be read with here, from routes already observed for this board (no
 * fetches, no authored bundles). Same mode only, since tram and S-Bahn use different bays.
 */
export function findLineBundleOffers({
  lineId,
  identity,
  stopEvents,
  patterns,
}: {
  lineId: string;
  /** The line's identity, where resolved. */
  identity?: string;
  stopEvents: readonly StopEvent[];
  patterns: StopCorridorPatterns;
}): readonly LineBundleOffer[] {
  if (!lineId) return [];
  const byLine = collectObservedLineRoutes(stopEvents, patterns, lineId, identity);
  const primary = byLine.get(lineId);
  if (!primary) return [];

  const offers: LineBundleOffer[] = [];
  for (const [candidateId, candidate] of byLine) {
    if (candidateId === lineId) continue;
    if (candidate.ptMode !== primary.ptMode) continue;

    // Each pairing of the two lines' routes (short workings, through services, directions) is a
    // candidate corridor.
    const shared: (readonly Call[])[] = [];
    for (const primaryRoute of primary.routes) {
      for (const candidateRoute of candidate.routes) {
        const common = getCommonCallPrefix([primaryRoute, candidateRoute]);
        if (common.length >= MIN_LINE_BUNDLE_SHARED_CALLS) shared.push(common);
      }
    }
    const sharedRoutes = keepLongestSharedRoutes(shared);
    if (sharedRoutes.length === 0) continue;

    offers.push({ lineId: candidateId, identity: candidate.identity, sharedRoutes });
  }

  // Not capped here: which siblings can be drawn beside the journey is not known yet.
  return offers.sort(
    (first, second) =>
      second.sharedRoutes[0].length - first.sharedRoutes[0].length ||
      compareLines(
        { id: first.lineId, identity: first.identity },
        { id: second.lineId, identity: second.identity },
      ),
  );
}

/**
 * The longest corridor of each pairing, longest first; a short working yields prefixes of the
 * through service's corridor, which add nothing.
 */
function keepLongestSharedRoutes(
  routes: readonly (readonly Call[])[],
): readonly (readonly Call[])[] {
  const kept: (readonly Call[])[] = [];
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
  calls: readonly Call[];
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
  calls: readonly Call[];
};

/**
 * The stretch the bundled lines share, measured outwards from the rider's stop (the one point all
 * share), and what happens at each end. Nothing where the trunk would be one stop or misses the
 * stop.
 */
export function getLineBundleTrunk(
  chains: readonly LineBundleChain[],
  riderStopIds: readonly string[],
): { calls: readonly Call[]; branches: readonly LineBundleBranch[] } | undefined {
  if (chains.length < 2) return undefined;

  const riderIndexes = chains.map(({ calls }) =>
    calls.findIndex((call) => call.stopPlaceId && riderStopIds.includes(call.stopPlaceId)),
  );
  if (riderIndexes.some((index) => index < 0)) return undefined;

  // Align consecutive bays of one stop as a dated journey, so they do not shift later stops into a
  // false fork.
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
 * The sibling's journey that runs with the primary farthest; the opposite direction scores nothing.
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
