import type { Departure, ServingLine, TransitLine } from "../data/transit-types";
import { getLineFamilyId, isSameLineFamily } from "./line-families";
import { addOnce, toSortedIds } from "./collections";
import { getLineSelectionIds, type LineSelection } from "./line-bundles";

/**
 * What one line's own boards are asked for: where to read them, and which line-directions to ask
 * each one for.
 *
 * Both are *learned*. Nothing here is authored, and neither question can be answered once: a line's
 * route is only as long as the trips seen so far describe it, and the provider's per-direction ids
 * are only as complete as the boards that have named them. So this is a crawl — every board read
 * teaches the next round which stops to read and which ids to name — and the two facts grow
 * together because they are learned from the same rows.
 *
 * The failure both rules below exist to prevent is the same one: a reading that is *narrower* than
 * the line, held in place by its own narrowness. A stop never read discloses no trip that would
 * have added it, and a direction never named is filtered out of every board that would have named
 * it. Neither corrects itself, so each is widened deliberately rather than left to the next
 * observation.
 */

/** One line as the visit has observed it. Empty until a board has been read for it. */
export type LineObservation = {
  /** Every stop a trip of this line has been seen calling at, in the order they were discovered. */
  stopIds: readonly string[];
  /**
   * Every provider line-direction id (`routeDirectionId`) seen departing on this line, plus each
   * one's opposite where a board that describes a stop has confirmed the opposite exists.
   */
  directionIds: readonly string[];
};

export type LineObservations = ReadonlyMap<string, LineObservation>;

export const EMPTY_LINE_OBSERVATION: LineObservation = { stopIds: [], directionIds: [] };

/**
 * A board as this crawl reads it: the rows it returned, and — only where the board describes the
 * whole stop — the lines the monitor knows there, with their direction ids.
 *
 * A filtered board's `servingLines` is absent by construction (see `transit-source.ts`): it saw
 * only what was asked for, so it cannot say what else calls there, and it must never be read as
 * evidence that nothing does.
 */
export type LineObservationBoard = {
  departures: readonly Departure[];
  servingLines?: readonly ServingLine[];
};

/**
 * The stops a line's vehicles are read from, beside the rider's own board.
 *
 * These are read filtered to the line, which is what changed the arithmetic: an unfiltered board
 * spends its rows on every line at the stop and reaches about twenty minutes, so a vehicle still
 * out at the end of its run appeared on none of them. Filtered, the whole row budget goes to this
 * line.
 *
 * Observation posts are no longer excluded. They were, because the shell passed their loaded boards
 * straight to the diagram — but those boards are unfiltered and answer a different question, so a
 * post that sits on this line is now as worth reading as any other stop.
 *
 * A bounded sample cannot be complete. A short working may begin and end between two samples, and
 * a branch may be absent from the one full-length trip used to place them. Every known calling
 * point is therefore read, and what is known is not thrown away between readings of the line: the
 * trips running this hour describe less of the line than the line, and off-peak they may all turn
 * back short of a stretch that is served — and observed — an hour either side. These are still
 * line-filtered boards wherever the filter can be named in full: completeness costs more requests,
 * never more rows shared with unrelated lines.
 *
 * The rider's own board is one of these readings, not an extra beside them, so it is never requested
 * twice.
 */
export function getLineObservationStopIds(
  lineStopIds: readonly string[],
  currentStopId: string,
): string[] {
  return [...new Set(lineStopIds)].filter((stopId) => stopId !== currentStopId);
}

/**
 * How many stops a round that could not name its filter may read.
 *
 * An unfiltered board is the whole stop — every line calling there, and the trip behind every row —
 * so a line's worth of them is a different order of cost from the filtered reading this is the
 * fallback for. Bounded, it stays what it is meant to be: a round that reads enough of the line to
 * learn what it could not name, and is then replaced by the filtered reading of all of it.
 *
 * Six, because a direction is confirmed by any stop that has it, and the sample is spread along the
 * route rather than taken from one end — a handful anywhere on a line is enough to name both ways
 * of it. Where a line never yields a filter at all, six is also what it goes on reading: a sample
 * of the line, which is what an unfiltered reading of it can honestly afford to be.
 */
export const MAX_UNFILTERED_LINE_OBSERVATION_STOPS = 6;

/**
 * How many stops one round of the filtered reading may read.
 *
 * The filtered reading is meant to be complete, and on the lines a rider actually opens it is:
 * a Karlsruhe tram line is thirty calling points and is read whole. The cap is for the outliers —
 * an S-Bahn to Öhringen is seventy, and reading all of them every ninety seconds spends a rider's
 * connection on the half of the line nothing is drawn near.
 *
 * Forty, because it is above every tram and Stadtbahn line in the network and below the regional
 * runs, so the bound does nothing at all to the ordinary case. Past it the same end-to-end sample
 * the unfiltered round takes applies, which keeps both ends and thins the middle.
 */
export const MAX_LINE_OBSERVATION_STOPS = 40;

/**
 * A bounded sample of a route, spread from end to end rather than taken off the front.
 *
 * The stops are in discovery order, which begins at one end of the drawn trip: the first six of
 * them are six stops of one corner, and a corner answers for a corner. Spread, the same six say
 * something about the whole line — which is what a round that has to learn from them needs.
 *
 * Returns the list itself where it is already within the bound, so nothing downstream re-requests
 * a reading that did not change.
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

/** A line-direction whose route may be asked for, and the observed row that addresses it. */
export type LineRouteRequest = { lineId: string; directionId: string; departureId: string };

/**
 * The route readings worth asking for, from the boards in hand: one per line-direction, no more.
 *
 * The provider has no way to name a line's route directly — it is addressed by a run of it — so any
 * row of the direction will do, and every row of it answers the same. Taking the first therefore
 * costs one request per direction of the line and none per row, which is what makes a route
 * affordable at all beside a reading that is already a board per stop.
 */
export function getLineRouteRequests(
  selection: LineSelection,
  boards: readonly LineObservationBoard[],
): readonly LineRouteRequest[] {
  const requestByDirectionId = new Map<string, LineRouteRequest>();
  for (const lineId of getLineSelectionIds(selection)) {
    for (const board of boards) {
      for (const departure of board.departures) {
        const { routeDirectionId: directionId, id: departureId } = departure;
        if (!directionId || !departureId || requestByDirectionId.has(directionId)) continue;
        if (!isSameLineFamily(departure.lineId, lineId)) continue;
        requestByDirectionId.set(directionId, {
          lineId: getLineFamilyId(lineId),
          directionId,
          departureId,
        });
      }
    }
  }
  return [...requestByDirectionId.values()];
}

/**
 * One line's observation given the route the provider states for it.
 *
 * The route *leads* the resulting order, where the stops discovered from trips only followed the
 * one trip that was drawn first. That matters beyond tidiness: the order is what the sample above
 * is spread along, so a reading that cannot name its filter now samples the whole line rather than
 * the corner of it that happened to be running. Stops observed but absent from the route — a
 * diversion the timetable predates — keep their place behind it rather than being dropped, because
 * a vehicle was seen calling there and that outranks what is published.
 *
 * Returns the value it was given once the route is wholly known, so this settles like every other
 * step of the crawl.
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

/** Every selected line's observation given the routes read for it, keeping the map where none was. */
export function extendLineObservationRoutes(
  known: LineObservations,
  selection: LineSelection,
  routeStopIdsByLineId: ReadonlyMap<string, readonly string[]>,
): LineObservations {
  let extended: Map<string, LineObservation> | undefined;
  for (const lineId of getLineSelectionIds(selection).map(getLineFamilyId)) {
    const observation = known.get(lineId) ?? EMPTY_LINE_OBSERVATION;
    const next = extendLineObservationRoute(observation, routeStopIdsByLineId.get(lineId) ?? []);
    if (next === observation && known.has(lineId)) continue;
    extended ??= new Map(known);
    extended.set(lineId, next);
  }
  return extended ?? known;
}

/**
 * Adds the calling points newly observed for a line, preserving its existing discovery order.
 *
 * Returning the original value when nothing was learned makes this both the pure transition for
 * the line crawl and its change signal. The hook can therefore stay concerned with loading boards
 * rather than reimplementing line-route merging and array equality around them.
 */
export function extendLineCallStopIds(
  knownStopIds: readonly string[],
  trips: readonly Departure[],
): readonly string[] {
  const known = new Set(knownStopIds);
  let expanded: string[] | undefined;
  for (const { tripCalls } of trips) {
    for (const { localStopId } of tripCalls ?? []) {
      if (!localStopId || known.has(localStopId)) continue;
      known.add(localStopId);
      if (!expanded) expanded = [...knownStopIds];
      expanded.push(localStopId);
    }
  }
  return expanded ?? knownStopIds;
}

/**
 * The provider's per-direction ids for one line, which is what a filtered board is asked for.
 *
 * A line is two of these — `:H:` and `:R:` — and a board filtered to one of them shows one
 * direction, so both have to be named. They are read off the departures rather than authored: the
 * feed already states one on every row as `routeDirectionId`.
 */
export function getLineDirectionIds(lineId: string, departures: readonly Departure[]): string[] {
  return toSortedIds(
    departures.flatMap((departure) =>
      departure.routeDirectionId && isSameLineFamily(departure.lineId, lineId)
        ? [departure.routeDirectionId]
        : [],
    ),
  );
}

/** The direction field of a provider id, which is the second-to-last of its colon-separated parts. */
const OPPOSITE_DIRECTION_FIELD: Record<string, string> = { H: "R", R: "H" };

/**
 * The same route the other way: `kvv:21003:E:H:s26` ⇄ `kvv:21003:E:R:s26`.
 *
 * Nothing is ever *learned* from this — every id in a reading was stated by the feed. It answers
 * only whether the two ids in hand are the two halves of one line, which is what decides that a
 * filter naming them is whole rather than half (`hasBothLineDirections`).
 */
export function getOppositeDirectionId(routeDirectionId: string): string | undefined {
  const fields = routeDirectionId.split(":");
  const directionIndex = fields.length - 2;
  if (directionIndex < 1) return undefined;
  const opposite = OPPOSITE_DIRECTION_FIELD[fields[directionIndex]];
  return opposite
    ? [...fields.slice(0, directionIndex), opposite, ...fields.slice(directionIndex + 1)].join(":")
    : undefined;
}

/** Whether both ways of a line have been named, which is when a filtered board may be asked for. */
export const hasBothLineDirections = ({ directionIds }: LineObservation): boolean =>
  directionIds.some((directionId) => {
    const opposite = getOppositeDirectionId(directionId);
    return Boolean(opposite && directionIds.includes(opposite));
  });

/**
 * The `line` filter every board of this reading is asked for — or none at all.
 *
 * All of the selection's directions or none of them, because a filter is a whitelist the provider
 * applies exactly: a board asked for one direction of a line answers with that direction and is
 * silent about the other, and nothing in the answer says a direction is missing. Half a filter is
 * therefore not half a reading but a reading with a hole in it, held open by itself — the ids are
 * learned from departures, and the departures that would name the missing direction are the ones
 * the filter drops.
 *
 * A line at whose end the rider is standing is exactly this case: their board lists the outbound
 * trips, so the inbound id is nowhere in hand, and every board along the line would go on being
 * asked for one direction while every inbound vehicle on it stayed invisible.
 *
 * Reading unfiltered instead costs the horizon — a shared board reaches minutes where a filtered
 * one reaches most of an hour — and that is the right way round: a shorter reading of the whole
 * line beats a long reading of half of it. It is also self-correcting, which the alternative is
 * not: an unfiltered board names both directions, and the next round is filtered again.
 */
export function getLineFilterDirectionIds(
  observations: LineObservations,
  selection: LineSelection,
): readonly string[] {
  const lineIds = getLineSelectionIds(selection);
  if (lineIds.length === 0) return [];
  const observed = lineIds.map((lineId) => observations.get(getLineFamilyId(lineId)));
  if (!observed.every((observation) => observation && hasBothLineDirections(observation)))
    return [];
  // Each line is asked for its own two directions and the answers pooled: one filtered board then
  // carries the whole corridor, so reading two lines together still costs one request.
  return toSortedIds(observed.flatMap((observation) => [...(observation?.directionIds ?? [])]));
}

/** The stops every line of the reading is known to call at, in discovery order and without repeats. */
export function getLineObservationsStopIds(
  observations: LineObservations,
  selection: LineSelection,
): readonly string[] {
  const stopIds: string[] = [];
  for (const lineId of getLineSelectionIds(selection)) {
    for (const stopId of observations.get(getLineFamilyId(lineId))?.stopIds ?? []) {
      addOnce(stopIds, stopId);
    }
  }
  return stopIds;
}

/**
 * One line's observation grown by everything the boards in hand say about it.
 *
 * Returns the value it was given where nothing was learned, so a caller can use identity as the
 * change signal and the crawl settles instead of asking again for what it already knows.
 */
export function extendLineObservation(
  known: LineObservation,
  lineId: string,
  boards: readonly LineObservationBoard[],
): LineObservation {
  const trips = boards.flatMap((board) =>
    board.departures.filter((departure) => isSameLineFamily(departure.lineId, lineId)),
  );
  const stopIds = extendLineCallStopIds(known.stopIds, trips);

  const directionIds = new Set(known.directionIds);
  for (const directionId of getLineDirectionIds(lineId, trips)) directionIds.add(directionId);
  // What the stops themselves say. A departure names its own direction and nothing else, so a line
  // with no row among a busy stop's few — and the direction that only ever arrives at a terminus —
  // could be named by no reading at all. The stop names every line calling there whether or not one
  // is due, which is the same fact stated where a rider is not waiting for it.
  for (const board of boards) {
    for (const servingLine of board.servingLines ?? []) {
      const servedLineId = servingLine.lineId;
      if (servedLineId && isSameLineFamily(servedLineId, lineId)) {
        directionIds.add(servingLine.directionId);
      }
    }
  }

  const hasNewStops = stopIds !== known.stopIds;
  const hasNewDirections = directionIds.size !== known.directionIds.length;
  if (!hasNewStops && !hasNewDirections) return known;
  return {
    stopIds,
    directionIds: hasNewDirections ? toSortedIds([...directionIds]) : known.directionIds,
  };
}

/**
 * Every selected line's observation grown by the boards in hand, keeping the map itself where none
 * of them learned anything.
 *
 * Per line rather than per reading, because a line's route and its directions belong to the line:
 * a stretch learned while two lines were read together is still that line's stretch when it is
 * next read alone, and a bundle is only ever the union of what its lines are known to do.
 */
export function extendLineObservations(
  known: LineObservations,
  selection: LineSelection,
  boards: readonly LineObservationBoard[],
): LineObservations {
  let extended: Map<string, LineObservation> | undefined;
  for (const lineId of getLineSelectionIds(selection).map(getLineFamilyId)) {
    const observation = known.get(lineId) ?? EMPTY_LINE_OBSERVATION;
    const next = extendLineObservation(observation, lineId, boards);
    if (next === observation && known.has(lineId)) continue;
    extended ??= new Map(known);
    extended.set(lineId, next);
  }
  return extended ?? known;
}

/**
 * Where a line's crawl starts before any board has been read for it.
 *
 * The core stops are a seed and never an answer: they are the stretch of the line that runs through
 * the Zentrum, which is the one part every observation post already sees. What the crawl is for
 * lies past them.
 */
export function seedLineObservations(
  selection: LineSelection,
  lines: readonly TransitLine[],
  recall: (lineId: string) => LineObservation | undefined,
): LineObservations {
  const seeded = new Map<string, LineObservation>();
  for (const lineId of getLineSelectionIds(selection).map(getLineFamilyId)) {
    const remembered = recall(lineId);
    if (remembered) {
      seeded.set(lineId, remembered);
      continue;
    }
    const zentrumStopIds = lines.find((line) => isSameLineFamily(line.id, lineId))?.zentrumStopIds;
    seeded.set(
      lineId,
      zentrumStopIds?.length
        ? { stopIds: zentrumStopIds, directionIds: [] }
        : EMPTY_LINE_OBSERVATION,
    );
  }
  return seeded;
}
