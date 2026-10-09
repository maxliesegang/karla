import { useEffect, useMemo, useRef } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure } from "../data/transit-types";
import { getDepartureReadInstant } from "../lib/trips";
import { DEPARTURE_BOARD_REFRESH_MS } from "./departure-board";
import { useDeviceNow } from "./clock";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
import { useHeldRun } from "./run-reading-store";
import {
  findActiveRideObservation,
  forgetActiveRideObservation,
  rememberActiveRideObservation,
} from "../lib/active-ride";

/**
 * The ride's run, kept for the whole ride. Boards drop it soon after boarding, so the ride holds
 * its id, reads the run from the store, mirrors the observation to storage for reloads, and
 * re-reads it itself on the board cadence while no board does.
 */
export type RetainedRun = {
  departure: Departure | undefined;
  /** When the observation was read; meaningful while `isRetained`. */
  observedAt: number;
  /** Boards no longer list the run; this is its last reading. */
  isRetained: boolean;
};

const RETAINED_RUN_LOAD_OPTIONS: KeyedLoadOptions<Departure | undefined> = {
  refreshMs: DEPARTURE_BOARD_REFRESH_MS,
  // An evicted run backs off; the stored observation answers meanwhile.
  getFailureKind: (reading) => (reading === undefined ? "unavailable" : undefined),
};

/** Re-reads the ride's run on the board cadence while no board does. */
function useRetainedRunRead(rowId: string | undefined): void {
  useKeyedLoad(
    rowId ?? null,
    (key) => transitSource.getRun(key, DEPARTURE_BOARD_REFRESH_MS),
    RETAINED_RUN_LOAD_OPTIONS,
  );
}

export function useRetainedRun(
  addressId: string | undefined,
  departure: Departure | undefined,
): RetainedRun {
  // Ticking, so a quiet board starts the re-reading by itself.
  const now = useDeviceNow();
  // Read once per ride: the fallback after a reload.
  const storedObservation = useMemo(
    () => (addressId ? findActiveRideObservation(addressId) : null),
    [addressId],
  );

  // Held by id while boards drop it.
  const reading = useHeldRun(addressId, departure);
  const rowId = reading?.id;

  // Only while nothing fresher than the board cadence exists; a slow post's listing is not a
  // re-read.
  const departureReadAt = (departure && getDepartureReadInstant(departure)) ?? 0;
  const isReadingCurrent = Boolean(departure) && now - departureReadAt < DEPARTURE_BOARD_REFRESH_MS;
  useRetainedRunRead(!addressId || isReadingCurrent ? undefined : rowId);

  // Mirrored to storage for reloads, cleared with the ride; only newer readings overwrite.
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

  // The stored observation only answers where the source has nothing.
  const shown = reading ?? storedObservation?.departure;
  const observedAt = (shown && getDepartureReadInstant(shown)) ?? 0;
  const isRetained = Boolean(addressId && shown && !departure);
  return { departure: shown, observedAt, isRetained };
}
