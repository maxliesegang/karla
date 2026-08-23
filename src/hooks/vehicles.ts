import { useEffect, useState } from "react";
import type { Departure, DepartureBoard } from "../data/transit-types";
import {
  getCurrentLineVehicleDepartures,
  updateLineVehicleObservations,
  type LineVehicleObservation,
} from "../lib/line-vehicle-observations";
import { useVehicleFeedNow } from "./clock";

/**
 * Vehicles observed for one line, retained until their complete call sequence says the run ended.
 *
 * Boards only list trips that have not left their stop. Retaining a bounded observation lets the
 * diagram keep placing a vehicle after it passes an observation stop without asking that stop for
 * historical departures. Current board entries always replace the retained copy, so a new delay
 * reaches the marker on the same refresh.
 */
export function useLineVehicleDepartures(
  lineId: string,
  observedDepartures: readonly Departure[],
  /**
   * A lookup rather than one instant, because the boards behind these departures are on different
   * cadences: stamping a five-minute-old board's trip with the freshest board's time would have the
   * diagram dead-reckon it from an instant it was never read at. Memoize it — it is an effect dep.
   */
  observedAt: number | ((departure: Departure) => number),
  departureBoard: DepartureBoard | null,
  isRide: boolean,
): { vehicleDepartures: readonly Departure[]; feedNow: number } {
  const [retention, setRetention] = useState<{
    lineId: string;
    observations: readonly LineVehicleObservation[];
  }>({ lineId, observations: [] });
  const retained = retention.lineId === lineId ? retention.observations : [];
  const feedNow = useVehicleFeedNow(
    observedDepartures.length > 0 || retained.length > 0 || isRide,
    departureBoard,
  );

  useEffect(() => {
    // Retention is an accumulator over successive boards, not state derivable from this render:
    // the previous observations are the input. Kept in an effect deliberately.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRetention((current) => ({
      lineId,
      observations: updateLineVehicleObservations(
        current.lineId === lineId ? current.observations : [],
        observedDepartures,
        observedAt,
        feedNow,
      ),
    }));
    // A feed tick only expires observations below; it must not make the same board a new observation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId, observedDepartures, observedAt]);

  useEffect(() => {
    // Expiring observations on a feed tick is the same accumulator as above; it returns `current`
    // unchanged when nothing expired, so it cannot cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRetention((current) => {
      if (current.lineId !== lineId) return current;
      const observations = updateLineVehicleObservations(current.observations, [], 0, feedNow);
      return observations.length === current.observations.length
        ? current
        : { ...current, observations };
    });
  }, [feedNow, lineId]);

  return {
    vehicleDepartures: getCurrentLineVehicleDepartures(retained, observedDepartures, feedNow),
    feedNow,
  };
}
