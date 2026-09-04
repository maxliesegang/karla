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
   * The place the corridor heads into — the municipality or Karlsruhe district the trips share
   * furthest ahead. The headsign stands in where no sequence was observed, or where the place is
   * the one the rider is already standing in.
   */
  directionLabel: string;
  /**
   * The places along the corridor's way, in the order the route visits them: the ends a rider
   * picks between, and — woven between them — the prominent places, the ones other lines offer a
   * connection at or the route calls repeatedly. Three places in all, which the ends fill first:
   * they are always stated, however many of them a corridor has, and only the room they leave goes
   * to the way's own places. Those are enrichment the row shows where it has the width, and reads
   * as the ends alone where it has not.
   */
  places: StopServiceCorridorPlace[];
  /** The headsigns of the trips gathered here, in the order the board listed them. */
  destinations: string[];
  departures: Departure[];
  hasObservedTopology: boolean;
  /**
   * Whether every trip gathered here was matched over a full observed route, and those routes run
   * together. A first link is evidence that trips leave together, never that they stay together,
   * so a claim that this corridor's destinations name one shared way waits for this.
   */
  hasObservedSharedRoute: boolean;
};

export type StopServiceCorridorLineGroup = {
  id: string;
  line: TransitLine;
  corridors: StopServiceCorridor[];
};

/** What the trips gathered under one corridor id have been observed doing, before it is named. */
type StopCorridorDraft = {
  departures: Departure[];
  sequences: (readonly TripCall[])[];
  /** The call every trip of the corridor leaves this stop by — the corridor's identity. */
  firstCall: TripCall | undefined;
  /** How many of the gathered trips were matched over their full remaining route. */
  fullRoutes: number;
  hasObservedTopology: boolean;
};

/**
 * A corridor and the one stop that can still name it: where its trips leave the stop, which is
 * different for every corridor of a line and so tells colliding rows apart where the place they
 * head into cannot. Undefined where nothing was observed — a row whose headsign is the only name
 * it has.
 */
type NamedStopCorridor = StopServiceCorridor & { partingLabel: string | undefined };

/** What naming a corridor reads its direction and the prominence of its way's places from. */
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
  // The place the corridor heads into: its nearest end, the first terminus the way passes.
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
 * Two corridors of one line that head into the same place are not told apart by naming it twice,
 * so where a place collides the rows fall back to the stops the trips actually part at — every
 * corridor of a line leaves by its own stop, so that name is always free. A row nothing was
 * observed about has no stop to fall back to: its headsign stays, and is the only name it has.
 */
function resolveCollidingLabels(corridors: readonly NamedStopCorridor[]): StopServiceCorridor[] {
  // The ends are what two rows have to be told apart by; the way's own places are enrichment a
  // row may drop, so they do not count towards a collision.
  const getLabelKey = ({ directionLabel, places }: StopServiceCorridor) =>
    [
      directionLabel,
      ...getCorridorTermini(places)
        .slice(1)
        .map(({ label }) => label),
    ].join(">");

  // Keyed once per corridor: the key walks the whole way, and a row is asked for it twice here.
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
 * The line-first directory grouped by a trip's outgoing corridor rather than its terminus.
 *
 * A short working and a through service belong together when EFA has shown that they take the same
 * first link from this stop. Their individual headsigns remain attached to their countdowns. The
 * trip's own reading is preferred; otherwise the route its line predominantly runs towards that
 * headsign stands in. Trips whose route is genuinely contested, and those nothing is known about
 * yet, group by headsign instead — see `StopCorridorPatterns` for why that is remembered rather
 * than recomputed from whichever detailed boards a refresh happens to have in hand.
 *
 * A corridor is named by the place it heads into rather than by a headsign, so the two ends of a
 * line read as the two places a rider picks between; each trip's own headsign stays on its
 * countdown, where it belongs to that trip alone.
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
    // A trip whose route is not known yet joins the other trips showing the same headsign rather
    // than standing alone: keyed by the departure, one unresolved trip was one row of its own, and
    // a row that appears and disappears as trips resolve is worse than a row named by a headsign.
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
        // The ends a rider sees on the line's badge, in the order the board listed them rather than
        // in the order the rows happen to be sorted into.
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
