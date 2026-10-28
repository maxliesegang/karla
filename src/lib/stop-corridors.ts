import type { StopEvent, TransitLine, Call } from "../data/transit-types";
import { createLineSign, getJourneyEnds } from "../data/line-signs";
import { compareLines, getLineFamilyId, isNetworkLineIdentity } from "./line-families";
import { getLineIdentity } from "./line-identity";
import { findStopCorridorPattern, type StopCorridorPatterns } from "./stop-corridor-patterns";
import {
  getCallDirectionLabel,
  getCorridorTermini,
  getCorridorWayPlaces,
  type PlaceLineFamilies,
  type StopServiceCorridorPlace,
} from "./stop-corridor-way";
import { compareGermanNames } from "./text";
import { findFirstCallBeyondStop, getCallKey, getCommonCallPrefix } from "./calls";

/** Journeys that leave the current stop over the same first timetabled link. */
export type StopServiceCorridor = {
  id: string;
  /**
   * The place the corridor heads into (municipality or Karlsruhe district shared farthest ahead);
   * the headsign where nothing was observed or the place is the rider's own.
   */
  directionLabel: string;
  /**
   * The places along the way in route order: every end, then prominent places between, up to three
   * in all. The places between are enrichment, shown where there is width.
   */
  places: StopServiceCorridorPlace[];
  /** The journeys' headsigns, in board order. */
  destinations: string[];
  stopEvents: StopEvent[];
  hasObservedTopology: boolean;
  /**
   * Whether every journey matched a full observed route and those routes run together; a shared
   * first link alone does not show they stay together.
   */
  hasObservedSharedRoute: boolean;
};

export type StopServiceCorridorLineGroup = {
  id: string;
  line: TransitLine;
  corridors: StopServiceCorridor[];
};

/** What a corridor's journeys were observed doing, before it is named. */
type StopCorridorDraft = {
  stopEvents: StopEvent[];
  sequences: (readonly Call[])[];
  /** The call every journey leaves this stop by: the corridor's identity. */
  firstCall: Call | undefined;
  /** Journeys matched over their full remaining route. */
  fullRoutes: number;
  hasObservedTopology: boolean;
};

/**
 * A corridor with the stop its journeys part at, which distinguishes a line's corridors where the
 * place names collide. Undefined where nothing was observed.
 */
type NamedStopCorridor = StopServiceCorridor & { partingLabel: string | undefined };

type CorridorNamingKnowledge = {
  boardPlaceName: string | undefined;
  lineFamiliesByPlace: PlaceLineFamilies;
  lineFamilyId: string;
};

function nameStopCorridor(
  id: string,
  draft: StopCorridorDraft,
  knowledge: CorridorNamingKnowledge,
): NamedStopCorridor {
  const { boardPlaceName } = knowledge;
  const destinations = [
    ...new Set(draft.stopEvents.map(({ destinationText: destination }) => destination)),
  ];
  const sharedCall = getCommonCallPrefix(draft.sequences).at(-1);
  const places = getCorridorWayPlaces(draft.sequences, knowledge);
  // The nearest end names the direction.
  const nearestPlace = getCorridorTermini(places)[0]?.label;

  return {
    id,
    directionLabel:
      nearestPlace ??
      (sharedCall ? getCallDirectionLabel(sharedCall, boardPlaceName) : destinations[0]),
    places,
    partingLabel: draft.firstCall?.stopName || undefined,
    destinations,
    stopEvents: draft.stopEvents,
    hasObservedTopology: draft.hasObservedTopology,
    hasObservedSharedRoute:
      draft.fullRoutes === draft.stopEvents.length && nearestPlace !== undefined,
  };
}

/**
 * Where two corridors of a line name the same place, they fall back to the stop they part at, which
 * is unique per corridor. A row with nothing observed keeps its headsign.
 */
function resolveCollidingLabels(corridors: readonly NamedStopCorridor[]): StopServiceCorridor[] {
  // Only the ends count toward a collision; the places between may be dropped.
  const getLabelKey = ({ directionLabel, places }: StopServiceCorridor) =>
    [
      directionLabel,
      ...getCorridorTermini(places)
        .slice(1)
        .map(({ label }) => label),
    ].join(">");

  // Computed once per corridor; the key walks the whole way.
  const labelKeys = corridors.map(getLabelKey);
  const countByLabel = new Map<string, number>();
  for (const key of labelKeys) countByLabel.set(key, (countByLabel.get(key) ?? 0) + 1);

  return corridors.map(({ partingLabel, ...corridor }, index) =>
    countByLabel.get(labelKeys[index]) === 1
      ? corridor
      : {
          ...corridor,
          directionLabel: partingLabel ?? corridor.directionLabel,
          places: [],
        },
  );
}

/**
 * The line order's groups: journeys by outgoing corridor rather than terminus, so a short working
 * and a through service sharing a first link group together. A journey's own route is preferred,
 * else its line's predominant route to that headsign (`StopCorridorPatterns`); unknown or contested
 * journeys group by headsign. Corridors are named by the place they head into; headsigns stay on
 * countdowns.
 */
export function getStopServiceCorridorLineGroups(
  stopEvents: readonly StopEvent[],
  patterns: StopCorridorPatterns,
): StopServiceCorridorLineGroup[] {
  const { boardPlaceName, lineFamiliesByPlace } = patterns;
  const groups = new Map<
    string,
    { line: TransitLine; corridors: Map<string, StopCorridorDraft> }
  >();

  for (const stopEvent of stopEvents) {
    const lineId = getLineFamilyId(stopEvent.lineId);
    // Another operator's line of the network's line's name is its own group.
    const identity = getLineIdentity(stopEvent.lineRef);
    const groupId = isNetworkLineIdentity(identity) ? lineId : `${lineId}@${identity}`;
    const match = findStopCorridorPattern(patterns, stopEvent);
    const firstObservedStop = match
      ? findFirstCallBeyondStop(match.calls, patterns.stopId)
      : undefined;
    // An unknown route groups by headsign, so rows do not appear and vanish as journeys resolve.
    const corridorId = firstObservedStop
      ? `observed:${getCallKey(firstObservedStop)}`
      : `unknown:${stopEvent.destinationText}`;
    const group = groups.get(groupId) ?? {
      line: {
        ...createLineSign(
          stopEvent.lineId,
          stopEvent.ptMode,
          stopEvent.lineRef,
          getJourneyEnds(stopEvent),
        ),
        id: lineId,
        name: lineId,
        destinations: [],
      },
      corridors: new Map(),
    };
    const corridor = group.corridors.get(corridorId) ?? {
      stopEvents: [],
      sequences: [],
      firstCall: firstObservedStop,
      fullRoutes: 0,
      hasObservedTopology: Boolean(firstObservedStop),
    };
    corridor.stopEvents.push(stopEvent);
    if (match?.hasFullRoute) {
      corridor.sequences.push(match.calls);
      corridor.fullRoutes += 1;
    }
    group.corridors.set(corridorId, corridor);
    groups.set(groupId, group);
  }

  return [...groups]
    .map(([id, group]) => {
      const named = [...group.corridors].map(([corridorId, draft]) =>
        nameStopCorridor(`${id}:${corridorId}`, draft, {
          boardPlaceName,
          lineFamiliesByPlace,
          lineFamilyId: group.line.id,
        }),
      );
      return {
        id,
        // The badge's ends, in board order.
        line: {
          ...group.line,
          destinations: [...new Set(named.flatMap(({ destinations }) => destinations))],
        },
        corridors: resolveCollidingLabels(named).sort((first, second) =>
          compareGermanNames(first.directionLabel, second.directionLabel),
        ),
      };
    })
    .sort((first, second) => compareLines(first.line, second.line));
}
