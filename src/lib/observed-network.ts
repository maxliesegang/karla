import type { StopEvent, StopEventBoard, TransitLine, PtMode, Call } from "../data/transit-types";
import { createLineSign } from "../data/line-signs";
import { compareLineIds, getLineFamilyId } from "./line-families";
import { isZentrumStop } from "../data/zentrum-stops";
import { getFarthestLineDatedJourneyTermini } from "./stop-services";
import { addOnce, getDistinctByFrequency } from "./collections";

/**
 * The network as the live feed shows it: journeys read at a few boards spell out which stops have
 * service today and which lines call there, so lines appear and disappear on their own. Only the
 * Zentrum's membership (`zentrum-stops.ts`) is authored.
 */

/**
 * The observation posts, in two tiers on two cadences: Zentrum posts feed the list a rider sees;
 * reach posts describe the rest of the network, which changes slowly.
 *
 * Chosen by measurement: candidate posts read at six service patterns (Mon 08:00, 12:00, 17:00,
 * Sat 18:00, Sun 11:00, Sun 03:00), scored on the worst-case share of the whole network's
 * stop-and-line pairs seen:
 *
 *     worst-case share of the network seen   stop*line   stops   lines
 *     the five Zentrum posts                     51%      57%     48%
 *     these nine                                 81%      82%     78%
 *
 * The nine also see 85% of the Zentrum's own pairs against 65%.
 */

/** Zentrum posts. A fifth (Kronenplatz, Ettlinger Tor) added nothing at the worst reading. */
export const ZENTRUM_OBSERVATION_POST_STOP_IDS = [
  "europaplatz",
  "karlstor",
  "hauptbahnhof",
  "albtalbahnhof",
] as const;

/**
 * Reach posts: where tram-trains change system (Durlach, Rheinbergstraße; Albtalbahnhof is a
 * Zentrum post) and bus hubs. What each alone sees, across the six readings:
 *
 *     durlach-bahnhof    RE1 RE45 RE73, S3 S31 S32, 21 31, MX17a, NL12 NL13
 *     rheinbergstrasse   S51, 74, 75
 *     entenfang          2 60 62 70, NL15 NL16 NL17
 *     zuendhuetle        1 24 44 47
 *     turmberg           23 26
 *
 * Turmberg is marginal (stops seen 82% → 86%) and the first to drop.
 */
export const REACH_OBSERVATION_POST_STOP_IDS = [
  "durlach-bahnhof",
  "knielingen-rheinbergstrasse",
  "entenfang",
  "durlach-zuendhuetle",
  "durlach-turmberg",
] as const;

export type ObservedStop = {
  id: string;
  name: string;
  /** Line ids seen calling here, in order of first sighting. */
  lineIds: string[];
  /** Journeys that called here, for ordering the list. */
  callCount: number;
};

export type ObservedLine = {
  id: string;
  ptMode: PtMode;
  /** A line ref the line's journeys stated, for its identity. */
  lineRef?: string;
  /** Destinations seen on this line, most frequent first — what a rider reads on the front. */
  destinations: string[];
  /**
   * The farthest observed dated journey's ends (`getFarthestLineDatedJourneyTermini`), which name
   * the line's extent.
   */
  farthestDatedJourneyTermini?: readonly string[];
};

export type ObservedNetwork = {
  stops: ObservedStop[];
  lines: ObservedLine[];
  /** Journeys the view was built from. */
  journeyCount: number;
};

/**
 * The timeless part of a journey: route topology without countdown, prediction, status or clocks.
 */
export type ObservedJourneyTopology = Pick<
  StopEvent,
  "id" | "journeyRef" | "lineId" | "lineRef" | "ptMode" | "destinationText" | "calls"
>;

/** Where named stops are, from every journey's calls: a few posts locate hundreds of stops. */
export type ObservedStopPosition = {
  id: string;
  name: string;
  placeName?: string;
  latitude: number;
  longitude: number;
};

export function getObservedStopPositions(
  boards: readonly StopEventBoard[],
): ObservedStopPosition[] {
  const positionById = new Map<string, ObservedStopPosition>();

  for (const board of boards) {
    if (board.dataStatus !== "live") continue;
    for (const stopEvent of board.stopEvents) {
      for (const call of stopEvent.calls ?? []) {
        const { stopPlaceId, latitude, longitude } = call;
        if (!stopPlaceId || latitude === undefined || longitude === undefined) continue;
        if (positionById.has(stopPlaceId)) continue;
        positionById.set(stopPlaceId, {
          id: stopPlaceId,
          name: call.stopName,
          placeName: call.placeName,
          latitude,
          longitude,
        });
      }
    }
  }

  return [...positionById.values()];
}

type IdentifiedCall = Call & { stopPlaceId: string };

function isIdentifiedCall(call: Call): call is IdentifiedCall {
  return Boolean(call.stopPlaceId);
}

export function buildObservedNetworkFromJourneys(
  journeys: readonly ObservedJourneyTopology[],
): ObservedNetwork {
  const stops = new Map<string, ObservedStop>();
  const lines = new Map<
    string,
    {
      ptMode: PtMode;
      lineRef?: string;
      destinations: string[];
      journeys: ObservedJourneyTopology[];
    }
  >();

  for (const journey of journeys) {
    const line = lines.get(journey.lineId) ?? {
      ptMode: journey.ptMode,
      destinations: [],
      journeys: [],
    };
    line.lineRef ??= journey.lineRef;
    line.destinations.push(journey.destinationText);
    line.journeys.push(journey);
    lines.set(journey.lineId, line);

    for (const call of (journey.calls ?? []).filter(isIdentifiedCall)) {
      if (!isZentrumStop(call.stopPlaceId)) continue;
      const stop = stops.get(call.stopPlaceId) ?? {
        id: call.stopPlaceId,
        name: call.stopName,
        lineIds: [],
        callCount: 0,
      };
      addOnce(stop.lineIds, journey.lineId);
      stop.callCount += 1;
      stops.set(call.stopPlaceId, stop);
    }
  }

  return {
    stops: [...stops.values()],
    lines: [...lines.entries()].map(([id, line]) => ({
      id,
      ptMode: line.ptMode,
      ...(line.lineRef ? { lineRef: line.lineRef } : {}),
      destinations: getDistinctByFrequency(line.destinations),
      farthestDatedJourneyTermini: getFarthestLineDatedJourneyTermini(id, line.journeys),
    })),
    journeyCount: journeys.length,
  };
}

/**
 * Observed lines as views expect them: official sign or neutral, and the ends seen, at the farthest
 * dated journey where known. A line not running is not offered.
 */
type ObservedLineFamily = {
  sign: TransitLine;
  destinations: string[];
  zentrumCalls: string[];
  farthestDatedJourneyTermini?: readonly string[];
};

export function getObservedTransitLines(network: ObservedNetwork): TransitLine[] {
  const familyById = new Map<string, ObservedLineFamily>();

  const getFamily = (lineId: string, ptMode: PtMode, lineRef?: string): ObservedLineFamily => {
    const familyId = getLineFamilyId(lineId);
    const existing = familyById.get(familyId);
    if (existing) return existing;
    const sign = { ...createLineSign(lineId, ptMode, lineRef), id: familyId, name: familyId };
    const created: ObservedLineFamily = { sign, destinations: [], zentrumCalls: [] };
    familyById.set(familyId, created);
    return created;
  };

  for (const observed of network.lines) {
    const family = getFamily(observed.id, observed.ptMode, observed.lineRef);
    for (const destination of observed.destinations) addOnce(family.destinations, destination);
    // The family's first observation stands; merged raw lines are not one extent.
    if (!family.farthestDatedJourneyTermini)
      family.farthestDatedJourneyTermini = observed.farthestDatedJourneyTermini;
  }

  // One pass over stops, which already list their lines.
  for (const stop of network.stops) {
    for (const lineId of stop.lineIds) {
      const family = familyById.get(getLineFamilyId(lineId));
      if (family) addOnce(family.zentrumCalls, stop.id);
    }
  }

  return [...familyById.values()]
    .map(({ sign, destinations, zentrumCalls, farthestDatedJourneyTermini }) => ({
      ...sign,
      destinations,
      zentrumCalls,
      ...(farthestDatedJourneyTermini ? { farthestDatedJourneyTermini } : {}),
    }))
    .sort((a, b) => compareLineIds(a.id, b.id));
}
