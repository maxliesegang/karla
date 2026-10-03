import type { Departure, TransitLine, TripCall } from "../data/transit-types";
import { createLineSign } from "../data/line-signs";
import { compareLineIds, getLineFamilyId } from "./line-families";
import { findStopCorridorPattern, type StopCorridorPatterns } from "./stop-corridor-patterns";
import {
  getCallDirectionLabel,
  getCorridorTermini,
  getCorridorWayPlaces,
  type PlaceLineFamilies,
  type StopServiceCorridorPlace,
} from "./stop-corridor-way";
import { compareGermanNames } from "./text";
import { findFirstCallBeyondStop, getCallKey, getCommonCallPrefix } from "./trip-calls";

/** Trips that leave the current stop over the same first scheduled link. */
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
  /** The trips' headsigns, in board order. */
  destinations: string[];
  departures: Departure[];
  hasObservedTopology: boolean;
  /**
   * Whether every trip matched a full observed route and those routes run together; a shared first
   * link alone does not show they stay together.
   */
  hasObservedSharedRoute: boolean;
};

export type StopServiceCorridorLineGroup = {
  id: string;
  line: TransitLine;
  corridors: StopServiceCorridor[];
};

/** What a corridor's trips were observed doing, before it is named. */
type StopCorridorDraft = {
  departures: Departure[];
  sequences: (readonly TripCall[])[];
  /** The call every trip leaves this stop by: the corridor's identity. */
  firstCall: TripCall | undefined;
  /** Trips matched over their full remaining route. */
  fullRoutes: number;
  hasObservedTopology: boolean;
};

/**
 * A corridor with the stop its trips part at, which distinguishes a line's corridors where the
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
  const destinations = [...new Set(draft.departures.map(({ destination }) => destination))];
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
    departures: draft.departures,
    hasObservedTopology: draft.hasObservedTopology,
    hasObservedSharedRoute:
      draft.fullRoutes === draft.departures.length && nearestPlace !== undefined,
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
 * The line order's groups: trips by outgoing corridor rather than terminus, so a short working and
 * a through service sharing a first link group together. A trip's own route is preferred, else its
 * line's predominant route to that headsign (`StopCorridorPatterns`); unknown or contested trips
 * group by headsign. Corridors are named by the place they head into; headsigns stay on countdowns.
 */
export function getStopServiceCorridorLineGroups(
  departures: readonly Departure[],
  patterns: StopCorridorPatterns,
): StopServiceCorridorLineGroup[] {
  const { boardPlaceName, lineFamiliesByPlace } = patterns;
  const groups = new Map<
    string,
    { line: TransitLine; corridors: Map<string, StopCorridorDraft> }
  >();

  for (const departure of departures) {
    const lineId = getLineFamilyId(departure.lineId);
    const match = findStopCorridorPattern(patterns, departure);
    const firstObservedStop = match
      ? findFirstCallBeyondStop(match.calls, patterns.stopId)
      : undefined;
    // An unknown route groups by headsign, so rows do not appear and vanish as trips resolve.
    const corridorId = firstObservedStop
      ? `observed:${getCallKey(firstObservedStop)}`
      : `unknown:${departure.destination}`;
    const group = groups.get(lineId) ?? {
      line: {
        ...createLineSign(departure.lineId, departure.transportMode),
        id: lineId,
        name: lineId,
        destinations: [],
      },
      corridors: new Map(),
    };
    const corridor = group.corridors.get(corridorId) ?? {
      departures: [],
      sequences: [],
      firstCall: firstObservedStop,
      fullRoutes: 0,
      hasObservedTopology: Boolean(firstObservedStop),
    };
    corridor.departures.push(departure);
    if (match?.hasFullRoute) {
      corridor.sequences.push(match.calls);
      corridor.fullRoutes += 1;
    }
    group.corridors.set(corridorId, corridor);
    groups.set(lineId, group);
  }

  return [...groups]
    .map(([id, group]) => {
      const named = [...group.corridors].map(([corridorId, draft]) =>
        nameStopCorridor(`${id}:${corridorId}`, draft, {
          boardPlaceName,
          lineFamiliesByPlace,
          lineFamilyId: id,
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
    .sort((first, second) => compareLineIds(first.id, second.id));
}
