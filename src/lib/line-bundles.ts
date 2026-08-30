import type { Departure, TransportMode, TripCall } from "../data/transit-types";
import { compareLineIds, getLineFamilyId, isSameLineFamily } from "./line-families";
import { findStopCorridorPattern, type StopCorridorPatterns } from "./stop-corridor-patterns";
import { getCallSequenceKey, getCallsPastIndex, getCommonCallPrefix } from "./trip-calls";

/**
 * Reading two lines as one along the stretch they share.
 *
 * From Hochstetten a rider heading for Busenbach is served by S1 and S11 alike, and reading them
 * on separate boards makes each one look half as frequent as the corridor really is. That is not a
 * reason to merge the lines: S1 and S11 keep their signs, their notices, their addresses and their
 * own ends — see `line-families.ts`, which stays the statement of line identity and is deliberately
 * untouched by any of this.
 *
 * So a bundle is not a property of a line. It is a property of **a corridor at one stop**, it is
 * chosen by the rider rather than asserted, and it is a view: the lines are drawn together only as
 * far as they have been *observed* running together, and the diagram says where they part rather
 * than drawing one line's branch under both their names.
 */
export type LineSelection = {
  /** The line the address names: the one the diagram is drawn from and the sign colour taken from. */
  lineId: string;
  /** Sibling lines the rider added to the view. Empty for the ordinary single-line reading. */
  bundledLineIds: readonly string[];
};

/**
 * `#/stop/hochstetten/line/S1+S11`. A line id is alphanumeric and a `+` in a fragment path is the
 * literal character rather than a space, so the bundle needs no escaping to survive a shared link.
 */
export const LINE_BUNDLE_SEPARATOR = "+";

/**
 * How many siblings one line may be read with.
 *
 * Two, because the offer has to stay a decision a rider makes at a glance: past that the board is
 * no longer a corridor but a stop board with extra steps, and that view already exists.
 */
export const MAX_BUNDLED_LINES = 2;

/**
 * How far two lines must have been seen running together before either is offered beside the other.
 *
 * One shared link is evidence that trips leave together, never that they stay together — the same
 * distinction `StopServiceCorridor.hasObservedSharedRoute` draws — and a bundle is a promise about
 * a stretch. Three calls is the shortest stretch a rider would call a common way.
 */
export const MIN_BUNDLE_SHARED_CALLS = 3;

export const createLineSelection = (
  lineId: string,
  bundledLineIds: readonly string[] = [],
): LineSelection => ({ lineId, bundledLineIds });

/** The primary first, which is the order the address states them in and the diagram is drawn in. */
export function getLineSelectionIds({ lineId, bundledLineIds }: LineSelection): readonly string[] {
  return lineId ? [lineId, ...bundledLineIds] : [];
}

/** Whether a departure belongs to the lines currently being read together. */
export const isSelectedLine = (selection: LineSelection, lineId: string): boolean =>
  getLineSelectionIds(selection).some((selected) => isSameLineFamily(selected, lineId));

export const isBundledSelection = ({ bundledLineIds }: LineSelection): boolean =>
  bundledLineIds.length > 0;

/**
 * Reads a line path segment, which is one line id or a bundle of them.
 *
 * A duplicate or empty id is dropped rather than rejected: the segment is hand-editable, and a
 * malformed bundle should read as the line it names rather than as a dead end.
 */
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

/** A sibling line worth offering beside this one, and the stretches the offer could reach over. */
export type LineBundleOffer = {
  lineId: string;
  /**
   * Every stretch the two lines have been observed running together past this stop, in travel
   * order, longest first.
   *
   * The offer's whole evidence, kept as calls rather than as a count of them, because it is also
   * what says which way the corridor runs: the trip the diagram happens to be drawing has to be
   * heading along this stretch for the offer to mean anything, and nothing but the stretch itself
   * can answer that. Nothing of the sibling's own *trips* is in hand at this point — the board is
   * asked for the lines the address names, so a line is only fetched once it has been added — and
   * an offer that waited for them would never be made.
   *
   * Several of them, and not the longest alone, because a stop is served in more than one
   * direction and two lines may share a stretch out of each end of it. At Ettlingen Neuwiesenreben
   * S1 and S11 run together for thirty-nine calls north to Hochstetten and for six south to
   * Busenbach; kept as one stretch the northbound corridor wins, and a rider reading a southbound
   * trip is offered nothing at all — on the very stretch the two lines part at, which is the whole
   * reason to read them together.
   */
  sharedRoutes: readonly (readonly TripCall[])[];
};

/**
 * One offer read against the trip on screen: the stretch it promises, and the stop that ends it.
 *
 * The corridor is direction-blind and the diagram is not, so which of an offer's stretches the
 * offer is *about* is only decided once there is a drawn trip to decide it against — see
 * `getDrawableLineBundleOffers`, which is the only thing that makes one of these.
 */
export type DrawableLineBundleOffer = {
  lineId: string;
  sharedCalls: readonly TripCall[];
  /** The last of those calls: the stop the offer promises to reach, and where the lines part. */
  sharedUntilStopName: string;
};

/** The offer as it is stated once a drawn trip has picked which of its stretches it is about. */
export const toDrawableLineBundleOffer = (
  lineId: string,
  sharedCalls: readonly TripCall[],
): DrawableLineBundleOffer => ({
  lineId,
  sharedCalls,
  sharedUntilStopName: sharedCalls[sharedCalls.length - 1]?.stopName ?? "",
});

const EMPTY_DRAWABLE_OFFERS: readonly DrawableLineBundleOffer[] = [];

/**
 * The offers worth making beside one drawn trip.
 *
 * Corridor observations are direction-blind because a stop is served both ways. A diagram is not:
 * it draws one trip heading one way, so an offer is useful only when that trip follows one of the
 * observed shared stretches. The promised stretch is also capped at the calls the drawn trip
 * confirms, so a short working never claims to share a way beyond its own turn-off.
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
  return offers.flatMap((offer) => {
    const sharedCalls = findDrawnSharedCalls(offer, drawnAhead);
    return sharedCalls ? [toDrawableLineBundleOffer(offer.lineId, sharedCalls)] : [];
  });
}

/** The longest observed shared stretch that the drawn trip actually follows. */
function findDrawnSharedCalls(
  offer: LineBundleOffer,
  drawnAhead: readonly TripCall[],
): readonly TripCall[] | undefined {
  let best: readonly TripCall[] = [];
  for (const sharedRoute of offer.sharedRoutes) {
    const common = getCommonCallPrefix([drawnAhead, sharedRoute]);
    if (common.length > best.length) best = common;
  }
  return best.length >= MIN_BUNDLE_SHARED_CALLS ? best : undefined;
}

/** The distinct routes one line has been observed taking out of this stop, in full. */
type ObservedLineRoutes = {
  transportMode: TransportMode;
  routes: (readonly TripCall[])[];
};

/**
 * Reads the routes out of this stop that the visit has already learned, by line.
 *
 * Only complete routes count. A match that knows the outgoing link alone (`hasFullRoute: false`)
 * says which way a trip leaves and nothing about where it goes, and a bundle drawn from that would
 * promise a shared way nobody has seen.
 */
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
 * The lines that could be read together with this one at this stop.
 *
 * Derived from what the visit has already observed rather than from an authored list of bundles:
 * the network here is observed, and an authored `S1/S11` would go on claiming a shared corridor
 * through the diversion that ends it. Nothing is fetched for this — the routes are the ones
 * `StopCorridorPatterns` accumulated for the board the rider is already reading — so an offer
 * appears exactly when the evidence for it is in hand, and no offer costs a request.
 *
 * Same mode only. A tram sharing a stretch with an S-Bahn is a genuine corridor, but not one this
 * view can draw honestly yet: the two run to different platforms and the diagram would have to say
 * so before it merged their vehicles onto one line.
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

    // Every stretch a pair of their observed routes runs in common: a line's short workings, its
    // through service and each direction it is read in are separate routes here, and each pairing
    // of them is a corridor the two lines might be read over.
    const shared: (readonly TripCall[])[] = [];
    for (const primaryRoute of primary.routes) {
      for (const candidateRoute of candidate.routes) {
        const common = getCommonCallPrefix([primaryRoute, candidateRoute]);
        if (common.length >= MIN_BUNDLE_SHARED_CALLS) shared.push(common);
      }
    }
    const sharedRoutes = keepLongestSharedRoutes(shared);
    if (sharedRoutes.length === 0) continue;

    offers.push({ lineId: candidateId, sharedRoutes });
  }

  // Every sibling the corridor supports, longest shared stretch first. Not capped here: which of
  // them can actually be drawn beside the trip on screen is not known yet, and a cap taken before
  // that question is asked spends the two places on siblings that may not survive it.
  return offers.sort(
    (first, second) =>
      second.sharedRoutes[0].length - first.sharedRoutes[0].length ||
      compareLineIds(first.lineId, second.lineId),
  );
}

/**
 * The corridors worth keeping out of every pairing of two lines' routes, longest first.
 *
 * A short working's route is a prefix of the through service's, so pairing them off yields the
 * same corridor at several lengths. Only the longest of each says anything the shorter ones do not:
 * a drawn trip is matched against these by how far it runs along one, so a prefix of a kept stretch
 * can never be the answer, and carrying it would only offer the same corridor twice.
 */
function keepLongestSharedRoutes(
  routes: readonly (readonly TripCall[])[],
): readonly (readonly TripCall[])[] {
  const kept: (readonly TripCall[])[] = [];
  for (const route of [...routes].sort((first, second) => second.length - first.length)) {
    if (kept.some((existing) => getCommonCallPrefix([route, existing]).length === route.length)) {
      continue;
    }
    kept.push(route);
  }
  return kept;
}

/** One bundled line's drawn trip: the chain the diagram would follow if that line stood alone. */
export type LineBundleChain = {
  lineId: string;
  /** The trip's calls in travel order, exactly as the diagram would take them. */
  calls: readonly TripCall[];
  /** The headsign that trip carries, which is the word the split is stated in. */
  destination: string;
};

/** Where one bundled line goes on to past the stretch they are drawn together over. */
export type LineBundleBranch = {
  lineId: string;
  /** `ahead` is past the last shared call in travel order; `behind` is before the first. */
  direction: "ahead" | "behind";
  /** The end this line runs to that way. */
  destination: string;
  /** False where this line's own run ends at the shared stretch — the short working of the pair. */
  continues: boolean;
  /**
   * The branch as a chain of its own, in travel order, with the call the lines part at kept at its
   * trunk end.
   *
   * That shared call is what makes the branch drawable: a vehicle is placed on the link between two
   * calls, and the first link of a branch has one end on the trunk. It is drawn as the junction the
   * legs meet at rather than as a stop of its own — the trunk already names it once, and naming it
   * again on every leg would make one stop look like three.
   *
   * Empty where this line does not run past the stretch at all. That branch has nothing to draw and
   * is stated in words instead.
   */
  calls: readonly TripCall[];
};

/**
 * The stretch the bundled lines are drawn over, and what happens at each of its ends.
 *
 * Measured outwards from the rider's own stop rather than from the start of the chains, because
 * that is the only point every bundled line is known to have in common: two lines may share a
 * middle stretch and part at both ends, and a prefix taken from the terminus would find nothing
 * shared at all there.
 *
 * Returns nothing where the trunk would not be a diagram — a chain that does not call at the
 * rider's stop, or a shared stretch of one stop. The line then draws itself alone, which is the
 * honest answer: the evidence for reading them together is not in hand.
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

  const ahead = getCommonCallPrefix(
    chains.map(({ calls }, index) => calls.slice(riderIndexes[index] + 1)),
  );
  const behind = getCommonCallPrefix(
    chains.map(({ calls }, index) => [...calls.slice(0, riderIndexes[index])].reverse()),
  );
  const calls = [...[...behind].reverse(), chains[0].calls[riderIndexes[0]], ...ahead];
  if (calls.length < 2) return undefined;

  // Two passes rather than one: whether a line is the pair's short working is only knowable once
  // every chain has been measured, and it is the statement a rider most needs at this end.
  const continuesAhead = chains.map(
    (chain, index) => chain.calls.length - riderIndexes[index] - 1 > ahead.length,
  );
  const continuesBehind = riderIndexes.map((riderIndex) => riderIndex > behind.length);
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
          ? [junctionAhead, ...chain.calls.slice(riderIndexes[index] + 1 + ahead.length)]
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
          ? [...chain.calls.slice(0, riderIndexes[index] - behind.length), junctionBehind]
          : [],
      })),
    );
  }

  return { calls, branches };
}

/**
 * Which of a sibling line's trips is drawn beside the primary one.
 *
 * The trip that runs with it furthest, not the one that leaves first: a bundled diagram is a
 * statement about a corridor, and the sibling's opposite direction shares none of it. A trip
 * heading the other way therefore scores nothing and is never chosen over one heading this way.
 */
export function chooseLineBundleChain(
  primary: LineBundleChain,
  candidates: readonly LineBundleChain[],
  riderStopIds: readonly string[],
): LineBundleChain | undefined {
  let best: { chain: LineBundleChain; trunkLength: number } | undefined;
  for (const candidate of candidates) {
    const trunk = getLineBundleTrunk([primary, candidate], riderStopIds);
    if (!trunk) continue;
    if (!best || trunk.calls.length > best.trunkLength) {
      best = { chain: candidate, trunkLength: trunk.calls.length };
    }
  }
  return best?.chain;
}

/**
 * The lines that part here without a leg to draw — said in words, because there is nothing to draw.
 *
 * The legs themselves are the statement of where the lines go; this is the other half of it, and
 * the half a rider must not miss: a train of the pair that terminates at the junction is the short
 * working the whole bundled reading exists to make visible, and boarding it believing it runs the
 * corridor is exactly the mistake this view is meant to prevent.
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

/** One leg's identity: a line runs at most one way out of each end of the shared stretch. */
export const getLineBundleBranchKey = ({ direction, lineId }: LineBundleBranch): string =>
  `${direction}-${lineId}`;

/**
 * A leg is drawn only where it has a chain to draw. A line that terminates at the junction has
 * none — there is nothing past it — and `getLineBundleTerminatingLabel` states it in words instead.
 */
export const getDrawableLineBundleBranches = (
  branches: readonly LineBundleBranch[],
  direction: "ahead" | "behind",
): readonly LineBundleBranch[] =>
  branches.filter((branch) => branch.direction === direction && branch.calls.length > 1);

/** Adding or dropping one sibling: the reading it leads to, and what the control says it does. */
export type LineBundleControl = {
  lineId: string;
  /** Whether this line is currently being read along, which is what the control would undo. */
  isActive: boolean;
  /** The bundle the control navigates to. */
  next: readonly string[];
  label: string;
  /**
   * How far the offer reaches: the stop the two lines have been observed running together until.
   * Carried on the offer and not on the reading it leads to, because it is the evidence that makes
   * the offer worth taking — once taken, the diagram itself names that stop, at the junction where
   * the legs part, and a control repeating it there would be saying twice what is already drawn.
   */
  sharedUntilStopName?: string;
};

/**
 * What the diagram offers: the siblings already being read, and the ones this stop's corridor could
 * still be read with.
 *
 * An offer for a line already in the bundle would be the same control twice under two words, so
 * the active reading wins and the offer is dropped.
 *
 * This is also where the reading's size is held to `MAX_BUNDLED_LINES`: a full bundle is offered
 * nothing further, and what is offered is only ever what there is still room to take. A control
 * leading to a bundle the address would silently trim on the way back in is not an offer.
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
