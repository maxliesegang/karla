import { useEffect, useMemo, useRef } from "react";
import { transitSource } from "../data/transit-source";
import type { StopEvent } from "../data/transit-types";
import { getStopEventReadInstant } from "../lib/journeys";
import { STOP_EVENT_BOARD_REFRESH_MS } from "./stop-event-board";
import { useDeviceNow } from "./clock";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
import { useHeldDatedJourney } from "./dated-journey-reading-store";
import {
  findActiveRideObservation,
  forgetActiveRideObservation,
  rememberActiveRideObservation,
} from "../lib/active-ride";

/**
 * The ride's dated journey, kept for the whole ride. Boards drop it soon after boarding, so the
 * ride holds its id, reads the dated journey from the store, mirrors the observation to storage for
 * reloads, and re-reads it itself on the board cadence while no board does.
 */
export type RetainedDatedJourney = {
  stopEvent: StopEvent | undefined;
  /** When the observation was read; meaningful while `isRetained`. */
  observedAt: number;
  /** Boards no longer list the dated journey; this is its last reading. */
  isRetained: boolean;
};

const RETAINED_DATED_JOURNEY_LOAD_OPTIONS: KeyedLoadOptions<StopEvent | undefined> = {
  refreshMs: STOP_EVENT_BOARD_REFRESH_MS,
  // An evicted dated journey backs off; the stored observation answers meanwhile.
  getFailureKind: (reading) => (reading === undefined ? "unavailable" : undefined),
};

/** Re-reads the ride's dated journey on the board cadence while no board does. */
function useRetainedDatedJourneyRead(rowId: string | undefined): void {
  useKeyedLoad(
    rowId ?? null,
    (key) => transitSource.getDatedJourney(key, STOP_EVENT_BOARD_REFRESH_MS),
    RETAINED_DATED_JOURNEY_LOAD_OPTIONS,
  );
}

export function useRetainedDatedJourney(
  addressId: string | undefined,
  stopEvent: StopEvent | undefined,
): RetainedDatedJourney {
  // Ticking, so a quiet board starts the re-reading by itself.
  const now = useDeviceNow();
  // Read once per ride: the fallback after a reload.
  const storedObservation = useMemo(
    () => (addressId ? findActiveRideObservation(addressId) : null),
    [addressId],
  );

  // Held by id while boards drop it.
  const reading = useHeldDatedJourney(addressId, stopEvent);
  const rowId = reading?.id;

  // Only while nothing fresher than the board cadence exists; a slow post's listing is not a
  // re-read.
  const stopEventReadAt = (stopEvent && getStopEventReadInstant(stopEvent)) ?? 0;
  const isReadingCurrent =
    Boolean(stopEvent) && now - stopEventReadAt < STOP_EVENT_BOARD_REFRESH_MS;
  useRetainedDatedJourneyRead(!addressId || isReadingCurrent ? undefined : rowId);

  // Mirrored to storage for reloads, cleared with the ride; only newer readings overwrite.
  const mirroredAt = useRef<{ rideId: string; observedAt: number } | null>(null);
  useEffect(() => {
    if (!addressId) {
      mirroredAt.current = null;
      forgetActiveRideObservation();
      return;
    }
    if (!reading) return;
    const observedAt = getStopEventReadInstant(reading) ?? 0;
    const written = mirroredAt.current;
    if (written?.rideId === addressId && observedAt <= written.observedAt) return;
    rememberActiveRideObservation(addressId, reading, observedAt);
    mirroredAt.current = { rideId: addressId, observedAt };
  }, [addressId, reading]);

  // The stored observation only answers where the source has nothing.
  const shown = reading ?? storedObservation?.stopEvent;
  const observedAt = (shown && getStopEventReadInstant(shown)) ?? 0;
  const isRetained = Boolean(addressId && shown && !stopEvent);
  return { stopEvent: shown, observedAt, isRetained };
}
