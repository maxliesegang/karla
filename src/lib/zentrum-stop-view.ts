/** An opened Zentrum stop's rows, destinations and map annotations from one reading. */
import type { Departure, DepartureBoard } from "../data/transit-types";
import type { ZentrumSchematicVehicle } from "./zentrum-schematic";
import { zentrumSchematicNodeById } from "./zentrum-schematic-plan";
import {
  type ZentrumSchematicOverlay,
  type ZentrumStopBoardRow,
  type ZentrumTravelMeasure,
  type ZentrumTravelTime,
  getMinutesUntilArrival,
  getMinutesUntilDeparture,
  getRideMinutes,
  getZentrumStopBoard,
  getZentrumTravelTimes,
} from "./zentrum-schematic-overlays";
import { getZentrumTravelSourceLabel } from "./zentrum-presentation";

/** The two questions an opened stop answers on the plan. */
export type ZentrumStopReading = "destinations" | "departures";

/** A directly reachable stop and the chosen ride. */
export type ZentrumReachableStop = ZentrumTravelTime & {
  nodeId: string;
  label: string;
  minutes: number;
  /** Minutes until the ride leaves, read apart under the "split" measure. */
  waitMinutes?: number;
};

/** Travel time and line printed at a reached stop. */
export type ZentrumStopTravelTag = {
  minutes: number;
  waitMinutes?: number;
  lineId: string;
  measure: ZentrumTravelMeasure;
  sourceLabel: string;
};

/** What an opened stop lights, and its readings. */
export type ZentrumStopView = {
  overlay: ZentrumSchematicOverlay;
  /** The stop's board, or nothing while it has not answered. */
  rows?: readonly ZentrumStopBoardRow[];
  reachableStops: readonly ZentrumReachableStop[];
  /** The countdown on each tram the stop waits for. */
  vehicleMinutesById?: ReadonlyMap<string, number>;
  /** Minutes and line printed at each reached stop. */
  stopMinutesByNodeId?: ReadonlyMap<string, ZentrumStopTravelTag>;
};

export const getZentrumStopView = (
  reading: ZentrumStopReading,
  stopId: string,
  board: DepartureBoard | null,
  vehicles: readonly ZentrumSchematicVehicle[],
  runDepartures: readonly Departure[],
  feedNow: number,
  travelMeasure: ZentrumTravelMeasure,
): ZentrumStopView => {
  if (reading === "departures") {
    const { rows, overlay, vehicleMinutesById } = getZentrumStopBoard(
      board?.departures ?? [],
      vehicles,
      stopId,
      feedNow,
    );
    return { overlay, rows: board ? rows : undefined, reachableStops: [], vehicleMinutesById };
  }
  const { travelTimesByNodeId, overlay } = getZentrumTravelTimes(
    runDepartures,
    stopId,
    feedNow,
    travelMeasure,
  );
  const getMinutes = (time: ZentrumTravelTime) =>
    travelMeasure === "arrival"
      ? getMinutesUntilArrival(time.arrivesAt, feedNow)
      : getRideMinutes(time);
  const reachableStops = [...travelTimesByNodeId]
    .flatMap(([nodeId, time]): ZentrumReachableStop[] => {
      const node = zentrumSchematicNodeById.get(nodeId);
      if (!node) return [];
      const reachable = { ...time, nodeId, label: node.label, minutes: getMinutes(time) };
      return [
        travelMeasure === "split"
          ? { ...reachable, waitMinutes: getMinutesUntilDeparture(time.departsAt, feedNow) }
          : reachable,
      ];
    })
    .sort(
      (left, right) =>
        (travelMeasure === "ride"
          ? left.minutes - right.minutes
          : left.arrivesAt - right.arrivesAt) ||
        left.arrivesAt - right.arrivesAt ||
        left.label.localeCompare(right.label),
    );
  return {
    overlay,
    reachableStops,
    stopMinutesByNodeId: new Map(
      reachableStops.map((time) => [
        time.nodeId,
        {
          minutes: time.minutes,
          ...(time.waitMinutes === undefined ? {} : { waitMinutes: time.waitMinutes }),
          lineId: time.lineId,
          measure: travelMeasure,
          sourceLabel: getZentrumTravelSourceLabel(time),
        },
      ]),
    ),
  };
};
