/**
 * The readings the Zentrum's plan can light in colour over its quiet route traces.
 *
 * Three questions, one answer shape: which corridors a line is lit along whole, and which stretches
 * start at a moving mark and so go out behind it as it travels. The drawing paints any of them the
 * same way (`ZentrumSchematicDrawing`); what differs is only who is asking.
 *
 * - Progress: where the trams on the plan are still going.
 * - A stop's departures: the way the next trams on the plan take to the stop a rider stands at.
 * - Travel times: how soon a rider at a stop can be at every other one, without changing.
 */
import type { Departure, TripCall } from "../data/transit-types";
import { compareLineIds } from "./line-families";
import { collapseTurnaroundCalls, getTripCallInstant } from "./trip-calls";
import type { ZentrumSchematicVehicle } from "./zentrum-schematic";
import { findZentrumSchematicNodeId, getEdgeKey } from "./zentrum-schematic-plan";

/** A stretch of a mark's own path, lit from the mark to `end`, which goes out as the mark moves. */
export type ZentrumSchematicLitStretch = {
  vehicle: ZentrumSchematicVehicle;
  /** Where along the mark's path the stretch ends; 1 is the end of its link. */
  end: number;
};

export type ZentrumSchematicOverlay = {
  /** The corridors lit whole, by the line whose lane they are lit in. */
  edgeIdsByLineId: ReadonlyMap<string, ReadonlySet<string>>;
  stretches: readonly ZentrumSchematicLitStretch[];
};

const lightEdges = (
  edgeIdsByLineId: Map<string, Set<string>>,
  lineId: string,
  edgeIds: Iterable<string>,
) => {
  const lit = edgeIdsByLineId.get(lineId) ?? new Set<string>();
  edgeIdsByLineId.set(lineId, lit);
  for (const edgeId of edgeIds) lit.add(edgeId);
};

/**
 * Where the trams on the plan are still going.
 *
 * A corridor is lit whole while any tram on its line has it still ahead; the corridor a tram is on
 * is lit from the tram onwards, so it goes out behind the last tram to run it. Two trams on one
 * corridor each light their own stretch, which is what makes the corridor between them stay lit
 * for the one behind.
 */
export function getZentrumProgressOverlay(
  vehicles: readonly ZentrumSchematicVehicle[],
): ZentrumSchematicOverlay {
  const edgeIdsByLineId = new Map<string, Set<string>>();
  const stretches: ZentrumSchematicLitStretch[] = [];
  for (const vehicle of vehicles) {
    const onPath = new Set(vehicle.path.edgeRanges.map(({ edgeId }) => edgeId));
    lightEdges(
      edgeIdsByLineId,
      vehicle.lineId,
      vehicle.aheadEdgeIds.filter((edgeId) => !onPath.has(edgeId)),
    );
    if (onPath.size > 0 && vehicle.progress < 1) stretches.push({ vehicle, end: 1 });
  }
  return { edgeIdsByLineId, stretches };
}

/** One tram on the plan that will leave a stop, and when. */
export type ZentrumStopDeparture = {
  vehicle: ZentrumSchematicVehicle;
  /** The call the tram leaves the stop by, which its printed time is read from. */
  call: TripCall;
  departsAt: number;
  /** The tram is standing at the stop rather than on its way to it. */
  isAtStop: boolean;
};

/**
 * The trams on the plan a rider at a stop can take next, and the way each still has to come.
 *
 * One tram for each line and destination — the next one — because the rider's question is which of
 * the ways out comes first, and a second tram of the same line behind it would only light the same
 * lane again. A tram already standing at the stop counts while it has not left.
 */
export function getZentrumStopDepartures(
  vehicles: readonly ZentrumSchematicVehicle[],
  nodeId: string,
): { departures: readonly ZentrumStopDeparture[]; overlay: ZentrumSchematicOverlay } {
  const candidates: (ZentrumStopDeparture & { edgeIds: string[]; end?: number })[] = [];
  for (const vehicle of vehicles) {
    const { aheadStops } = vehicle;
    // The stop the link leaves is behind a tram that has started moving.
    const firstIndex = vehicle.progress === 0 ? 0 : 1;
    const index = aheadStops.findIndex(
      (stop, at) => at >= firstIndex && stop.nodeId === nodeId && stop.departsAt !== undefined,
    );
    if (index < 0) continue;
    const stop = aheadStops[index];
    if (index === 0) {
      candidates.push({
        vehicle,
        call: stop.call,
        departsAt: stop.departsAt ?? 0,
        isAtStop: true,
        edgeIds: [],
      });
      continue;
    }
    // Inside the mark's own path the stretch stops at the stop; beyond it the path is lit to its
    // end and the corridors on from there to the stop are lit whole.
    const edgeIds: string[] = [];
    let end: number | undefined = stop.pathProgress;
    if (end === undefined) {
      let lastOnPath = 0;
      for (let at = 1; at < index; at += 1) {
        if (aheadStops[at].pathProgress !== undefined) lastOnPath = at;
      }
      for (let at = lastOnPath; at < index; at += 1) {
        edgeIds.push(getEdgeKey(aheadStops[at].nodeId, aheadStops[at + 1].nodeId));
      }
      end = 1;
    }
    candidates.push({
      vehicle,
      call: stop.call,
      departsAt: stop.departsAt ?? 0,
      isAtStop: false,
      edgeIds,
      end: vehicle.path.edgeRanges.length > 0 && end > vehicle.progress ? end : undefined,
    });
  }

  const nextByWay = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const key = `${candidate.vehicle.lineId}\u0000${candidate.vehicle.destination}`;
    const known = nextByWay.get(key);
    if (!known || candidate.departsAt < known.departsAt) nextByWay.set(key, candidate);
  }
  const next = [...nextByWay.values()].sort(
    (left, right) =>
      left.departsAt - right.departsAt || compareLineIds(left.vehicle.lineId, right.vehicle.lineId),
  );

  const edgeIdsByLineId = new Map<string, Set<string>>();
  const stretches: ZentrumSchematicLitStretch[] = [];
  for (const { vehicle, edgeIds, end } of next) {
    lightEdges(edgeIdsByLineId, vehicle.lineId, edgeIds);
    if (end !== undefined) stretches.push({ vehicle, end });
  }
  return {
    departures: next.map(({ vehicle, call, departsAt, isAtStop }) => ({
      vehicle,
      call,
      departsAt,
      isAtStop,
    })),
    overlay: { edgeIdsByLineId, stretches },
  };
}

/** The soonest a rider leaving one stop now is at another, and the tram that gets them there. */
export type ZentrumTravelTime = {
  arrivesAt: number;
  lineId: string;
  /** When that tram leaves the stop the rider is at. */
  departsAt: number;
};

/**
 * How soon a rider at a stop can be at every other stop of the plan, riding one tram.
 *
 * Read from every run the posts have named, not only the ones on the plan yet: the wait for a tram
 * that is still outside the Zentrum is part of how soon the rider gets anywhere. Only direct rides
 * count — a change is a platform and a wait the feed says nothing reliable about. A ride is read
 * until its trip leaves the plan, and each stop it reaches lights the corridors it took to get
 * there, in its line's lane, so the plan shows which tram the minutes are for.
 */
export function getZentrumTravelTimes(
  departures: readonly Departure[],
  nodeId: string,
  feedNow: number,
): {
  travelTimesByNodeId: ReadonlyMap<string, ZentrumTravelTime>;
  overlay: ZentrumSchematicOverlay;
} {
  const bestByNodeId = new Map<string, ZentrumTravelTime & { edgeIds: readonly string[] }>();
  for (const departure of departures) {
    if (departure.status === "cancelled") continue;
    if (departure.transportMode !== "tram" && departure.transportMode !== "lightRail") continue;
    const calls = collapseTurnaroundCalls(departure.tripCalls ?? []);
    const nodeIds = calls.map((call) => findZentrumSchematicNodeId(call));
    // The rider boards at the stop's last call of a complex, which is when the tram leaves it.
    let boardIndex = -1;
    for (const [index, call] of calls.entries()) {
      if (nodeIds[index] !== nodeId || nodeIds[index + 1] === nodeId) continue;
      const leaves = getTripCallInstant(call);
      if (leaves !== undefined && leaves >= feedNow) {
        boardIndex = index;
        break;
      }
    }
    if (boardIndex < 0) continue;
    const departsAt = getTripCallInstant(calls[boardIndex]) ?? feedNow;

    const edgeIds: string[] = [];
    let previous = nodeId;
    for (let index = boardIndex + 1; index < calls.length; index += 1) {
      const node = nodeIds[index];
      if (!node) break;
      if (node === previous) continue;
      edgeIds.push(getEdgeKey(previous, node));
      previous = node;
      const arrivesAt = getTripCallInstant(calls[index], "arrival");
      if (arrivesAt === undefined || node === nodeId) continue;
      const known = bestByNodeId.get(node);
      const isBetter =
        !known ||
        arrivesAt < known.arrivesAt ||
        (arrivesAt === known.arrivesAt && compareLineIds(departure.lineId, known.lineId) < 0);
      if (isBetter) {
        bestByNodeId.set(node, {
          arrivesAt,
          lineId: departure.lineId,
          departsAt,
          edgeIds: [...edgeIds],
        });
      }
    }
  }

  const edgeIdsByLineId = new Map<string, Set<string>>();
  for (const { lineId, edgeIds } of bestByNodeId.values()) {
    lightEdges(edgeIdsByLineId, lineId, edgeIds);
  }
  return {
    travelTimesByNodeId: new Map(
      [...bestByNodeId].map(([id, { arrivesAt, lineId, departsAt }]) => [
        id,
        { arrivesAt, lineId, departsAt },
      ]),
    ),
    overlay: { edgeIdsByLineId, stretches: [] },
  };
}

/** Whole minutes until a tram leaves, counted the way a departure board counts them. */
export const getMinutesUntilDeparture = (departsAt: number, feedNow: number): number =>
  Math.max(0, Math.floor((departsAt - Math.floor(feedNow / 60_000) * 60_000) / 60_000));

/** Whole minutes until a rider arrives, rounded up: being there a minute early is no promise. */
export const getMinutesUntilArrival = (arrivesAt: number, feedNow: number): number =>
  Math.max(0, Math.ceil((arrivesAt - feedNow) / 60_000));
