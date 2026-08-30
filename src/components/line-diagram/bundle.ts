import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Departure, TransitLine, TransitNetwork, TripCall } from "../../data/transit-types";
import type { JoinedTripPortionPair } from "../../lib/joined-trip-portions";
import {
  chooseLineBundleChain,
  createLineSelection,
  getDrawableLineBundleOffers,
  getDrawableLineBundleBranches,
  getLineBundleBranchKey,
  getLineBundleTerminatingLabel,
  getLineBundleTrunk,
  type DrawableLineBundleOffer,
  type LineBundleBranch,
  type LineBundleChain,
  type LineBundleOffer,
} from "../../lib/line-bundles";
import { isSameLineFamily } from "../../lib/line-families";
import {
  buildLineDiagramStops,
  getLineDiagramVehicleDepartures,
  getLineDiagramVehicles,
  type LineDiagramVehicle,
} from "../../lib/line-diagram";

/**
 * Turning a bundled reading into a drawn diagram.
 *
 * `lib/line-bundles.ts` says what a bundle *is* — which lines share a stretch, where it ends, what
 * each of them does past it. These hooks are the rendering half of that: which calls the trunk is
 * drawn over, which legs there are to draw, and where each leg's vehicles stand. They are hooks
 * rather than plain functions because every one of those answers has to survive a clock tick that
 * only moved a mark, and because a mark handing over from the trunk to a leg is a two-frame
 * observation the panel cannot make without remembering the frame before.
 */

export const EMPTY_BRANCH_VEHICLES: readonly LineDiagramVehicle[] = [];
const EMPTY_BRANCHES: readonly LineBundleBranch[] = [];
const EMPTY_TRANSFER_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/** The drawn shape of a reading: one trunk, and what stands at either end of it. */
export type LineDiagramFork = {
  /**
   * The stretch actually drawn as one line. With no sibling in the reading it is the drawn trip
   * itself; with one it stops at the last call every bundled line has been observed making, because
   * past that the rows would belong to one line while carrying both their marks.
   */
  calls: readonly TripCall[];
  /** Legs at the end the line runs towards, and at the end it came from. Drawable ones only. */
  branchesAhead: readonly LineBundleBranch[];
  branchesBehind: readonly LineBundleBranch[];
  /** The stops the lines part at, which the legs point back to and the words are said in. */
  junctionAhead: string;
  junctionBehind: string;
  /** The lines that part here with no leg to draw, said in words. */
  terminatingAhead?: string;
  terminatingBehind?: string;
  hasFork: boolean;
};

/**
 * The stretch a bundled reading is drawn over, and the legs at its ends.
 *
 * The line is still drawn from its own trip; what the bundle changes is where that drawing stops.
 * Where nothing supports a shared stretch the line draws itself alone, which is the honest answer
 * rather than a diagram that quietly speaks for a line it has not seen.
 */
export function useLineDiagramFork({
  lineId,
  bundledLines,
  drawnCalls,
  destination,
  riderStopIds,
  stopTripDepartures,
}: {
  lineId: string;
  bundledLines: readonly TransitLine[];
  /** The drawn trip's calls in travel order: the diagram the bundle narrows. */
  drawnCalls: readonly TripCall[];
  /** The headsign the drawn trip carries, which is the word its own split is stated in. */
  destination: string | undefined;
  riderStopIds: readonly string[];
  /** This stop's whole-trip readings: where a sibling's drawn trip is chosen from. */
  stopTripDepartures: readonly Departure[];
}): LineDiagramFork {
  return useMemo(() => {
    const trunk =
      bundledLines.length > 0 && drawnCalls.length > 0 && destination !== undefined
        ? getBundleTrunk({
            primary: { lineId, calls: drawnCalls, destination },
            bundledLineIds: bundledLines.map(({ id }) => id),
            riderStopIds,
            stopTripDepartures,
          })
        : undefined;
    const calls = trunk?.calls ?? drawnCalls;
    const branches = trunk?.branches ?? EMPTY_BRANCHES;
    const junctionAhead = calls[calls.length - 1]?.stopName ?? "";
    const junctionBehind = calls[0]?.stopName ?? "";
    const branchesAhead = getDrawableLineBundleBranches(branches, "ahead");
    const branchesBehind = getDrawableLineBundleBranches(branches, "behind");
    return {
      calls,
      branchesAhead,
      branchesBehind,
      junctionAhead,
      junctionBehind,
      terminatingAhead: getLineBundleTerminatingLabel(branches, "ahead", junctionAhead),
      terminatingBehind: getLineBundleTerminatingLabel(branches, "behind", junctionBehind),
      hasFork: branchesAhead.length > 0 || branchesBehind.length > 0,
    };
  }, [bundledLines, destination, drawnCalls, lineId, riderStopIds, stopTripDepartures]);
}

/** Each sibling's drawn trip beside the primary one, and the stretch they all have in common. */
function getBundleTrunk({
  primary,
  bundledLineIds,
  riderStopIds,
  stopTripDepartures,
}: {
  primary: LineBundleChain;
  bundledLineIds: readonly string[];
  riderStopIds: readonly string[];
  stopTripDepartures: readonly Departure[];
}) {
  const chains = bundledLineIds.flatMap((bundledLineId) => {
    const candidates = stopTripDepartures.flatMap((candidate) =>
      isSameLineFamily(candidate.lineId, bundledLineId) && candidate.tripCalls?.length
        ? [
            {
              lineId: bundledLineId,
              calls: candidate.tripCalls,
              destination: candidate.destination,
            },
          ]
        : [],
    );
    const chosen = chooseLineBundleChain(primary, candidates, riderStopIds);
    return chosen ? [chosen] : [];
  });
  return getLineBundleTrunk([primary, ...chains], riderStopIds);
}

/**
 * The offers worth making: the siblings the trip on screen could actually be read with.
 *
 * `findLineBundleOffers` reads the corridor from what the stop has been observed doing, which is
 * the right evidence for *whether* two lines share a way — but it is direction-blind. The diagram
 * draws one trip heading one way, and a sibling whose shared stretch lies behind it shares none of
 * what is on screen: taking that offer would leave the diagram exactly as it was, with a pressed
 * control claiming a bundle nobody can see. So every offer is tried against the drawn trip before
 * it is made.
 *
 * Tried against the *corridor*, and not against the sibling's own next trip. The stop's board is
 * asked for the lines the address names, so a sibling's trips are not in hand until it has been
 * added to the reading — testing an offer against them would fail every offer ever made, and the
 * control would never appear at all. Where the corridor holds and the sibling's trips then turn
 * out not to draw beside this one, `getLineBundleTrunk` says so by drawing the line alone, which
 * is the honest answer and the one the rider can see the reason for.
 *
 * This is also where an offer stops being about a stop and starts being about a trip: a stop is
 * served both ways and an offer carries every stretch its two lines share out of it, so the one
 * the drawn trip actually runs along is picked here, and it is that stretch the control names.
 */
export function useDrawableLineBundleOffers(options: {
  offers: readonly LineBundleOffer[];
  drawnCalls: readonly TripCall[];
  riderStopIds: readonly string[];
}): readonly DrawableLineBundleOffer[] {
  const { offers, drawnCalls, riderStopIds } = options;
  return useMemo(
    () => getDrawableLineBundleOffers({ offers, drawnCalls, riderStopIds }),
    [drawnCalls, offers, riderStopIds],
  );
}

/**
 * Where the legs' vehicles stand, and which of them have just come off the trunk.
 *
 * A fork has its own coordinate system for every leg, so the trunk's vehicle list cannot see
 * vehicles that have already continued past a junction: each leg places its own. A vehicle that
 * leaves the shared stretch is then rendered by a different layer, so its old trunk marker
 * disappears just as its branch marker appears — remembering the trunk's previous frame is what
 * lets the branch layer carry that marker across its connector instead of blinking it into place.
 */
export function useLineBundleBranchVehicles({
  branches,
  lineById,
  network,
  vehicleDepartures,
  joinedTripPairs,
  selectedDeparture,
  feedNow,
  trunkVehicles,
}: {
  branches: readonly LineBundleBranch[];
  lineById: ReadonlyMap<string, TransitLine>;
  network: TransitNetwork;
  vehicleDepartures: readonly Departure[];
  joinedTripPairs: readonly JoinedTripPortionPair[];
  selectedDeparture: Departure | undefined;
  feedNow: number;
  trunkVehicles: readonly LineDiagramVehicle[];
}): {
  vehiclesByBranchKey: ReadonlyMap<string, readonly LineDiagramVehicle[]>;
  transferKeysByBranchKey: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const vehiclesByBranchKey = useMemo(() => {
    const byKey = new Map<string, readonly LineDiagramVehicle[]>();
    for (const branch of branches) {
      const branchLine = lineById.get(branch.lineId);
      if (!branchLine) continue;
      const branchStops = buildLineDiagramStops(
        network,
        branchLine,
        [...branch.calls].reverse(),
        null,
      );
      // Past the junction only this line runs, so the leg carries its vehicles alone.
      const branchDepartures = getLineDiagramVehicleDepartures(
        createLineSelection(branch.lineId),
        vehicleDepartures,
      );
      byKey.set(
        getLineBundleBranchKey(branch),
        getLineDiagramVehicles(
          branchStops,
          branchDepartures,
          joinedTripPairs,
          selectedDeparture,
          feedNow,
        ),
      );
    }
    return byKey;
  }, [branches, feedNow, joinedTripPairs, lineById, network, selectedDeparture, vehicleDepartures]);

  const previousTrunkMarkerKeysRef = useRef<ReadonlySet<string>>(new Set());
  const [transferKeysByBranchKey, setTransferKeysByBranchKey] =
    useState<ReadonlyMap<string, ReadonlySet<string>>>(EMPTY_TRANSFER_KEYS);
  useLayoutEffect(() => {
    const previousTrunkMarkerKeys = previousTrunkMarkerKeysRef.current;
    const currentTrunkMarkerKeys = new Set(trunkVehicles.map(({ markerKey }) => markerKey));
    previousTrunkMarkerKeysRef.current = currentTrunkMarkerKeys;
    const transfers = new Map<string, ReadonlySet<string>>();
    for (const [branchKey, branchVehicles] of vehiclesByBranchKey) {
      const transferKeys = new Set(
        branchVehicles
          .map(({ markerKey }) => markerKey)
          .filter(
            (markerKey) =>
              previousTrunkMarkerKeys.has(markerKey) && !currentTrunkMarkerKeys.has(markerKey),
          ),
      );
      if (transferKeys.size > 0) transfers.set(branchKey, transferKeys);
    }
    // Only a hand-over is worth a render. Without this the diagram would re-render itself on every
    // frame it drew no fork at all, since a fresh empty map is never the state it replaces.
    const update = window.setTimeout(
      () =>
        setTransferKeysByBranchKey((current) =>
          isSameTransferKeys(current, transfers) ? current : transfers,
        ),
      0,
    );
    return () => window.clearTimeout(update);
  }, [trunkVehicles, vehiclesByBranchKey]);

  return { vehiclesByBranchKey, transferKeysByBranchKey };
}

const isSameTransferKeys = (
  first: ReadonlyMap<string, ReadonlySet<string>>,
  second: ReadonlyMap<string, ReadonlySet<string>>,
): boolean =>
  first.size === second.size &&
  [...first].every(([key, keys]) => {
    const other = second.get(key);
    return other?.size === keys.size && [...keys].every((markerKey) => other.has(markerKey));
  });
