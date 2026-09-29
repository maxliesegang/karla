import { useEffect, useMemo, useRef, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure } from "../data/transit-types";
import { getDepartureReadInstant } from "../lib/trips";
import { DEPARTURE_BOARD_REFRESH_MS } from "./departure-board";
import { useDeviceNow } from "./clock";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
import { useRuns } from "./run-reading-store";
import {
  findActiveRideObservation,
  forgetActiveRideObservation,
  rememberActiveRideObservation,
} from "../lib/active-ride";

/**
 * The run a rider is on, kept for as long as the ride lasts.
 *
 * Boards only list what has not left yet, so a few minutes after boarding no board mentions the
 * run the rider is sitting on. The ride keeps its *id* and reads the run from the store; the only
 * copy it owns is the observation mirrored to storage, which answers after a reload until the
 * source can. While no board is reading the run fresh, the ride asks for it itself, on the board's
 * cadence. Readings are dated by the source, never on arrival here.
 */
export type RetainedRun = {
  departure: Departure | undefined;
  /** When this observation of the run was read; only meaningful while `isRetained`. */
  observedAt: number;
  /** The boards no longer list this run, and what is in view is the last reading of it. */
  isRetained: boolean;
};

const EMPTY_IDS: readonly string[] = [];

const loadRetainedRun = (rowId: string): Promise<Departure | undefined> =>
  transitSource.getRun(rowId, DEPARTURE_BOARD_REFRESH_MS);

const RETAINED_RUN_LOAD_OPTIONS: KeyedLoadOptions<Departure | undefined> = {
  refreshMs: DEPARTURE_BOARD_REFRESH_MS,
  // A run the source can no longer name was evicted, not ended: back off, and let the stored
  // observation answer meanwhile.
  isFailure: (reading) => reading === undefined,
};

/** Keeps the ride's own run being read while no board is reading it, on the board's own cadence. */
function useRetainedRunRead(rowId: string | undefined): void {
  useKeyedLoad(rowId ?? null, loadRetainedRun, RETAINED_RUN_LOAD_OPTIONS);
}

export function useRetainedRun(
  addressId: string | undefined,
  departure: Departure | undefined,
): RetainedRun {
  // Ticking, so a board that goes quiet starts the ride's own re-reading by itself.
  const now = useDeviceNow();
  // Read once per ride: seeds the id after a reload, and is the answer of last resort.
  const storedObservation = useMemo(
    () => (addressId ? findActiveRideObservation(addressId) : null),
    [addressId],
  );

  // The id of the run to go on reading, stated once per ride.
  const [anchor, setAnchor] = useState<{ rideId: string; rowId: string } | null>(null);
  const anchored = anchor?.rideId === addressId ? anchor : null;
  const rowId = departure?.id ?? anchored?.rowId ?? storedObservation?.departure.id;
  if (addressId && rowId && rowId !== anchored?.rowId) {
    setAnchor({ rideId: addressId, rowId });
  }

  // Asked for only while no reading is fresher than the board cadence: being listed on a slow
  // observation post's board is not being re-read.
  const departureReadAt = (departure && getDepartureReadInstant(departure)) ?? 0;
  const isReadingCurrent = Boolean(departure) && now - departureReadAt < DEPARTURE_BOARD_REFRESH_MS;
  useRetainedRunRead(!addressId || isReadingCurrent ? undefined : rowId);
  const readRowIds = useMemo(() => (rowId ? [rowId] : EMPTY_IDS), [rowId]);
  const [live] = useRuns(readRowIds);

  const reading = live ?? departure;

  // Mirrored to storage for the next reload, and forgotten with the ride. Only a newer reading
  // overwrites the mirror.
  const mirroredAt = useRef<{ rideId: string; observedAt: number } | null>(null);
  useEffect(() => {
    if (!addressId) {
      mirroredAt.current = null;
      forgetActiveRideObservation();
      return;
    }
    if (!reading) return;
    const observedAt = getDepartureReadInstant(reading) ?? 0;
    const written = mirroredAt.current;
    if (written?.rideId === addressId && observedAt <= written.observedAt) return;
    rememberActiveRideObservation(addressId, reading, observedAt);
    mirroredAt.current = { rideId: addressId, observedAt };
  }, [addressId, reading]);

  // The stored observation answers only where the source has nothing; `observedAt` states its age.
  const shown = reading ?? storedObservation?.departure;
  const observedAt = (shown && getDepartureReadInstant(shown)) ?? 0;
  const isRetained = Boolean(addressId && shown && !departure);
  return { departure: shown, observedAt, isRetained };
}
