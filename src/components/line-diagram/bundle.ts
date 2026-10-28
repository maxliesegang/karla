import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StopEvent, TransitLine, TransitNetwork, Call } from "../../data/transit-types";
import type { JoinedDatedJourneyPortionPair } from "../../lib/joined-dated-journey-portions";
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
import type { TurnaroundIndex } from "../../lib/line-turnarounds";
import type { DatedJourneyMotions } from "../../lib/vehicle-positioning";
import {
  buildLineDiagramStops,
  getLineDiagramDatedJourneyStopEvents,
  getLineDiagramVehicles,
  getShownLineDiagramVehicles,
  type LineDiagramVehicle,
} from "../../lib/line-diagram";

/**
 * Rendering a bundle (`lib/line-bundles.ts`): the trunk's calls, the legs, and each leg's vehicles.
 * Hooks, so answers survive ticks and a mark handing over from trunk to leg can be seen across two
 * frames.
 */

export const EMPTY_LINE_BUNDLE_BRANCH_VEHICLES: readonly LineDiagramVehicle[] = [];
const EMPTY_BRANCHES: readonly LineBundleBranch[] = [];
const EMPTY_TRANSFER_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/** The drawn shape of a reading: one trunk, and what stands at either end of it. */
export type LineDiagramFork = {
  /**
   * The stretch drawn as one line: the drawn journey, or with a sibling, up to the last call every
   * bundled line was observed making.
   */
  calls: readonly Call[];
  /** Drawable legs at the end the line runs towards, and at the end it came from. */
  branchesAhead: readonly LineBundleBranch[];
  branchesBehind: readonly LineBundleBranch[];
  /** The stop the lines part at. */
  junctionAhead: string;
  junctionBehind: string;
  /** The lines that part here with no leg to draw, said in words. */
  terminatingAhead?: string;
  terminatingBehind?: string;
  hasFork: boolean;
};

/** The bundle's trunk and legs; where nothing supports a shared stretch, the line alone. */
export function useLineDiagramFork({
  lineId,
  bundledLines,
  drawnCalls,
  destination,
  riderStopIds,
  candidateStopEvents,
}: {
  lineId: string;
  bundledLines: readonly TransitLine[];
  /** The drawn journey's calls in travel order: the diagram the bundle narrows. */
  drawnCalls: readonly Call[];
  /** The drawn journey's headsign, which its split is worded in. */
  destination: string | undefined;
  riderStopIds: readonly string[];
  /** Whole-journey readings each sibling's chain is chosen from. */
  candidateStopEvents: readonly StopEvent[];
}): LineDiagramFork {
  return useMemo(() => {
    const trunk =
      bundledLines.length > 0 && drawnCalls.length > 0 && destination !== undefined
        ? getObservedLineBundleTrunk({
            primary: { lineId, calls: drawnCalls, destination },
            bundledLineIds: bundledLines.map(({ id }) => id),
            riderStopIds,
            candidateStopEvents,
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
  }, [bundledLines, candidateStopEvents, destination, drawnCalls, lineId, riderStopIds]);
}

/** Each sibling's drawn journey and the stretch they all share. */
function getObservedLineBundleTrunk({
  primary,
  bundledLineIds,
  riderStopIds,
  candidateStopEvents,
}: {
  primary: LineBundleChain;
  bundledLineIds: readonly string[];
  riderStopIds: readonly string[];
  candidateStopEvents: readonly StopEvent[];
}) {
  const chains = bundledLineIds.flatMap((bundledLineId) => {
    const candidates = candidateStopEvents.flatMap((candidate) =>
      candidate.lineId === bundledLineId && candidate.calls?.length
        ? [
            {
              lineId: bundledLineId,
              calls: candidate.calls,
              destination: candidate.destinationText,
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
 * The offers that apply to the drawn journey: corridors are direction-blind, so each is tried
 * against the drawn chain on both sides of the rider's stop, and the matching stretch is named.
 * Tested against the corridor, not the sibling's journeys, which are not loaded until it is added;
 * if they do not draw beside this journey, `getLineBundleTrunk` draws the line alone.
 */
export function useDrawableLineBundleOffers(options: {
  offers: readonly LineBundleOffer[];
  drawnCalls: readonly Call[];
  riderStopIds: readonly string[];
}): readonly DrawableLineBundleOffer[] {
  const { offers, drawnCalls, riderStopIds } = options;
  return useMemo(
    () => getDrawableLineBundleOffers({ offers, drawnCalls, riderStopIds }),
    [drawnCalls, offers, riderStopIds],
  );
}

/**
 * Each leg places its own vehicles in its own coordinates. Remembering the trunk's previous frame
 * lets a leg carry a mark across its connector instead of blinking it in.
 */
export function useLineBundleBranchVehicles({
  branches,
  lineById,
  network,
  datedJourneyStopEvents,
  joinedPortionPairs,
  selectedStopEvent,
  feedNow,
  motions,
  turnaroundIndex,
  showWaitingVehicles = true,
  areOtherDatedJourneysShown = true,
  trunkVehicles,
}: {
  branches: readonly LineBundleBranch[];
  lineById: ReadonlyMap<string, TransitLine>;
  network: TransitNetwork;
  datedJourneyStopEvents: readonly StopEvent[];
  joinedPortionPairs: readonly JoinedDatedJourneyPortionPair[];
  selectedStopEvent: StopEvent | undefined;
  feedNow: number;
  /** The diagram's motion record; legs place the same dated journeys as the trunk. */
  motions: DatedJourneyMotions;
  turnaroundIndex: TurnaroundIndex;
  /** See `getLineDiagramVehicles`. */
  showWaitingVehicles?: boolean;
  /** See `getShownLineDiagramVehicles`. */
  areOtherDatedJourneysShown?: boolean;
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
      const branchStops = buildLineDiagramStops(network, [...branch.calls].reverse());
      // Past the junction only this line runs.
      const branchStopEvents = getLineDiagramDatedJourneyStopEvents(
        createLineSelection(branch.lineId),
        datedJourneyStopEvents,
      );
      byKey.set(
        getLineBundleBranchKey(branch),
        getShownLineDiagramVehicles(
          getLineDiagramVehicles(
            branchStops,
            branchStopEvents,
            joinedPortionPairs,
            selectedStopEvent,
            feedNow,
            { motions, turnaroundIndex, showWaitingVehicles },
          ),
          areOtherDatedJourneysShown,
        ),
      );
    }
    return byKey;
  }, [
    areOtherDatedJourneysShown,
    branches,
    feedNow,
    joinedPortionPairs,
    lineById,
    motions,
    network,
    selectedStopEvent,
    turnaroundIndex,
    showWaitingVehicles,
    datedJourneyStopEvents,
  ]);

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
    // Only a hand-over is worth a render; a fresh empty map would re-render every frame.
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
