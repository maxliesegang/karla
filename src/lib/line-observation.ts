import type { StopEvent, ServingLine, TransitLine } from "../data/transit-types";
import { isRowOfLine, isSameLineIdentity } from "./line-identity";
import { addOnce, toSortedIds } from "./collections";
import { getLineSelectionIds, getSelectedLineIdentity, type LineSelection } from "./line-bundles";

/**
 * Which stops a line's boards are read at, and which line-directions they are filtered to. Both are
 * learned by crawling: each board teaches the next round. Both are widened on purpose, since an
 * unread stop or an unnamed direction never reveals itself.
 */

/** One line as the visit has observed it. Empty until a board has been read for it. */
export type LineObservation = {
  /** Every stop a journey of this line was seen calling at, in discovery order. */
  stopIds: readonly string[];
  /** Every `lineRef` seen on this line, plus opposites a whole-stop board confirmed. */
  lineRefs: readonly string[];
};

export type LineObservations = ReadonlyMap<string, LineObservation>;

export const EMPTY_LINE_OBSERVATION: LineObservation = { stopIds: [], lineRefs: [] };

/**
 * A board as the crawl reads it. `servingLines` only on a whole-stop board; a filtered board's
 * absence of it says nothing.
 */
export type LineObservationBoard = {
  stopEvents: readonly StopEvent[];
  servingLines?: readonly ServingLine[];
};

/**
 * The stops a line is read at, filtered to the line so the whole row budget goes to it. Every known
 * calling point is read and none is forgotten between readings, since this hour's journeys may not
 * cover the whole line. The rider's own board is one of these, never an extra request.
 */
export function getLineObservationStopIds(
  lineStopIds: readonly string[],
  currentStopId: string,
): string[] {
  return [...new Set(lineStopIds)].filter((stopId) => stopId !== currentStopId);
}

/**
 * Stops a round may read when it cannot name its filter: unfiltered boards are a whole stop each.
 * Spread along the route, six are enough to learn both directions.
 */
export const MAX_UNFILTERED_LINE_OBSERVATION_STOPS = 6;

/**
 * Stops one filtered round may read: above every tram and Stadtbahn line (about thirty), below the
 * regional journeys (S-Bahn to Öhringen is seventy).
 */
export const MAX_LINE_OBSERVATION_STOPS = 40;

/**
 * A bounded sample spread from end to end, since discovery order starts at one end. Returns the
 * input itself when within the bound.
 */
export function sampleLineObservationStopIds(
  stopIds: readonly string[],
  limit: number,
): readonly string[] {
  if (stopIds.length <= limit || limit < 1) return stopIds;
  const step = (stopIds.length - 1) / (limit - 1);
  const sampled: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    addOnce(sampled, stopIds[Math.round(index * step)]);
  }
  return sampled;
}

/** A line-direction whose route may be asked for, and a row that addresses it. */
export type LineRouteRequest = { lineId: string; lineRef: string; rowId: string };

/** One route request per line-direction: routes are addressed by any row of it. */
export function getLineRouteRequests(
  selection: LineSelection,
  boards: readonly LineObservationBoard[],
): readonly LineRouteRequest[] {
  const requestByLineRef = new Map<string, LineRouteRequest>();
  for (const lineId of getLineSelectionIds(selection)) {
    const identity = getSelectedLineIdentity(selection, lineId);
    for (const board of boards) {
      for (const stopEvent of board.stopEvents) {
        const { lineRef, id: rowId } = stopEvent;
        if (!rowId || requestByLineRef.has(lineRef)) continue;
        if (!isRowOfLine(stopEvent, lineId, identity)) continue;
        requestByLineRef.set(lineRef, {
          lineId,
          lineRef,
          rowId,
        });
      }
    }
  }
  return [...requestByLineRef.values()];
}

/**
 * A line's observation ordered by its published route; observed stops off the route (a diversion)
 * stay, after it. Returns the input once the route is known, so the crawl settles.
 */
export function extendLineObservationRoute(
  known: LineObservation,
  routeStopIds: readonly string[],
): LineObservation {
  if (routeStopIds.length === 0) return known;
  const inRoute = new Set(routeStopIds);
  const knownStopIds = new Set(known.stopIds);
  if (routeStopIds.every((stopId) => knownStopIds.has(stopId))) return known;
  return {
    ...known,
    stopIds: [...routeStopIds, ...known.stopIds.filter((stopId) => !inRoute.has(stopId))],
  };
}

/** Every selected line extended by its route; the same map where nothing changed. */
export function extendLineObservationRoutes(
  known: LineObservations,
  selection: LineSelection,
  routeStopIdsByLineId: ReadonlyMap<string, readonly string[]>,
): LineObservations {
  return mapSelectedLineObservations(known, selection, (observation, lineId) =>
    extendLineObservationRoute(observation, routeStopIdsByLineId.get(lineId) ?? []),
  );
}

/** Each selected line's observation passed through `extend`; the same map where nothing changed. */
function mapSelectedLineObservations(
  known: LineObservations,
  selection: LineSelection,
  extend: (observation: LineObservation, lineId: string) => LineObservation,
): LineObservations {
  let extended: Map<string, LineObservation> | undefined;
  for (const lineId of getLineSelectionIds(selection)) {
    const observation = known.get(lineId) ?? EMPTY_LINE_OBSERVATION;
    const next = extend(observation, lineId);
    if (next === observation && known.has(lineId)) continue;
    extended ??= new Map(known);
    extended.set(lineId, next);
  }
  return extended ?? known;
}

/** Adds newly observed stops in discovery order; returns the input when nothing was learned. */
export function extendLineCallStopIds(
  knownStopIds: readonly string[],
  journeys: readonly StopEvent[],
): readonly string[] {
  const known = new Set(knownStopIds);
  let expanded: string[] | undefined;
  for (const { calls } of journeys) {
    for (const { stopPlaceId } of calls ?? []) {
      if (!stopPlaceId || known.has(stopPlaceId)) continue;
      known.add(stopPlaceId);
      if (!expanded) expanded = [...knownStopIds];
      expanded.push(stopPlaceId);
    }
  }
  return expanded ?? knownStopIds;
}

/** The provider direction ids (`:H:`, `:R:`) a line's departures state. */
export function getLineRefs(
  lineId: string,
  stopEvents: readonly StopEvent[],
  identity?: string,
): string[] {
  return toSortedIds(
    stopEvents.flatMap((stopEvent) =>
      isRowOfLine(stopEvent, lineId, identity) ? [stopEvent.lineRef] : [],
    ),
  );
}

/** The direction field of a provider id is the second-to-last colon-separated part. */
const OPPOSITE_DIRECTION_FIELD: Record<string, string> = { H: "R", R: "H" };

/**
 * The opposite direction: `kvv:21003:E:H:s26` ⇄ `kvv:21003:E:R:s26`. Only used to check whether two
 * stated ids make a whole filter (`hasBothLineDirections`), never to learn an id.
 */
export function getOppositeLineRef(lineRef: string): string | undefined {
  const fields = lineRef.split(":");
  const directionIndex = fields.length - 2;
  if (directionIndex < 1) return undefined;
  const opposite = OPPOSITE_DIRECTION_FIELD[fields[directionIndex]];
  return opposite
    ? [...fields.slice(0, directionIndex), opposite, ...fields.slice(directionIndex + 1)].join(":")
    : undefined;
}

/** Whether both directions are named, the condition for asking a filtered board. */
const hasBothLineDirections = ({ lineRefs }: LineObservation): boolean =>
  lineRefs.some((lineRef) => {
    const opposite = getOppositeLineRef(lineRef);
    return Boolean(opposite && lineRefs.includes(opposite));
  });

/**
 * The `line` filter for every board of this reading: all directions or none. A one-direction filter
 * hides the other direction, which is then never learned (a rider at a terminus sees only
 * outbound rows). Unfiltered boards reach less far but name both directions, so the next round is
 * filtered again.
 */
export function getLineFilterLineRefs(
  observations: LineObservations,
  selection: LineSelection,
): readonly string[] {
  const lineIds = getLineSelectionIds(selection);
  if (lineIds.length === 0) return [];
  const observed = lineIds.map((lineId) => observations.get(lineId));
  if (!observed.every((observation) => observation && hasBothLineDirections(observation)))
    return [];
  // Pooled across lines, so a bundle still costs one request per stop.
  return toSortedIds(observed.flatMap((observation) => [...(observation?.lineRefs ?? [])]));
}

/** Every stop the reading's lines are known to call at, in discovery order, without repeats. */
export function getLineObservationsStopIds(
  observations: LineObservations,
  selection: LineSelection,
): readonly string[] {
  const stopIds: string[] = [];
  for (const lineId of getLineSelectionIds(selection)) {
    for (const stopId of observations.get(lineId)?.stopIds ?? []) {
      addOnce(stopIds, stopId);
    }
  }
  return stopIds;
}

/**
 * One line's observation grown by the boards in hand; the input itself when nothing was learned.
 */
export function extendLineObservation(
  known: LineObservation,
  lineId: string,
  boards: readonly LineObservationBoard[],
  identity?: string,
): LineObservation {
  const journeys = boards.flatMap((board) =>
    board.stopEvents.filter((stopEvent) => isRowOfLine(stopEvent, lineId, identity)),
  );
  const stopIds = extendLineCallStopIds(known.stopIds, journeys);

  const lineRefs = new Set(known.lineRefs);
  for (const lineRef of getLineRefs(lineId, journeys, identity)) lineRefs.add(lineRef);
  // A whole-stop board names every line calling there, due or not: the only way to learn a
  // direction that only arrives at a terminus, or a line without a row on a busy board.
  for (const board of boards) {
    for (const servingLine of board.servingLines ?? []) {
      const servedLineId = servingLine.lineId;
      if (servedLineId && isRowOfLine({ ...servingLine, lineId: servedLineId }, lineId, identity)) {
        lineRefs.add(servingLine.lineRef);
      }
    }
  }

  const hasNewStops = stopIds !== known.stopIds;
  const hasNewDirections = lineRefs.size !== known.lineRefs.length;
  if (!hasNewStops && !hasNewDirections) return known;
  return {
    stopIds,
    lineRefs: hasNewDirections ? toSortedIds([...lineRefs]) : known.lineRefs,
  };
}

/**
 * Every selected line's observation grown by the boards; per line, so what a bundle learns stays
 * with each line. The same map where nothing changed.
 */
export function extendLineObservations(
  known: LineObservations,
  selection: LineSelection,
  boards: readonly LineObservationBoard[],
): LineObservations {
  return mapSelectedLineObservations(known, selection, (observation, lineId) =>
    extendLineObservation(observation, lineId, boards, getSelectedLineIdentity(selection, lineId)),
  );
}

/**
 * Where a line's crawl starts: what an earlier visit learned, else its Zentrum calls, else nothing,
 * when the rider's board and the line's route start it. A seed, never the answer.
 */
export function seedLineObservations(
  selection: LineSelection,
  lines: readonly TransitLine[],
  recall: (lineId: string, identity?: string) => LineObservation | undefined,
): LineObservations {
  const seeded = new Map<string, LineObservation>();
  for (const lineId of getLineSelectionIds(selection)) {
    const identity = getSelectedLineIdentity(selection, lineId);
    const remembered = recall(lineId, identity);
    if (remembered) {
      seeded.set(lineId, remembered);
      continue;
    }
    const zentrumCalls = lines.find(
      (line) => line.id === lineId && isSameLineIdentity(line.identity, identity),
    )?.zentrumCalls;
    seeded.set(
      lineId,
      zentrumCalls?.length ? { stopIds: zentrumCalls, lineRefs: [] } : EMPTY_LINE_OBSERVATION,
    );
  }
  return seeded;
}
