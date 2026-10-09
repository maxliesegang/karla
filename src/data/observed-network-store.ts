import type { Departure, DepartureBoard, TripCall } from "./transit-types";
import {
  buildObservedNetworkFromTrips,
  type ObservedNetwork,
  type ObservedTripTopology,
} from "../lib/observed-network";
import { findFinalCallInstant, getCallSequenceKey } from "../lib/trip-calls";
import { RUN_ENDED_GRACE_MS, RUN_READING_MAX_AGE_MS } from "./run-reading-store";

const EMPTY_OBSERVED_NETWORK: ObservedNetwork = { stops: [], lines: [], tripCount: 0 };

/** The topology fields of a call, without per-run timing. */
const toTopologyCall = (call: TripCall): TripCall => ({
  stopName: call.stopName,
  ...(call.placeName ? { placeName: call.placeName } : {}),
  ...(call.platformLabel ? { platformLabel: call.platformLabel } : {}),
  ...(call.platformCode ? { platformCode: call.platformCode } : {}),
  ...(call.providerStopPointId ? { providerStopPointId: call.providerStopPointId } : {}),
  ...(call.localStopId ? { localStopId: call.localStopId } : {}),
  ...(call.latitude !== undefined ? { latitude: call.latitude } : {}),
  ...(call.longitude !== undefined ? { longitude: call.longitude } : {}),
});

const toTopology = (departure: Departure): ObservedTripTopology | undefined =>
  departure.status !== "cancelled" && departure.tripCalls?.length
    ? {
        id: departure.id,
        ...(departure.tripId ? { tripId: departure.tripId } : {}),
        lineId: departure.lineId,
        transportMode: departure.transportMode,
        destination: departure.destination,
        tripCalls: departure.tripCalls.map(toTopologyCall),
      }
    : undefined;

/** One distinct topology of a timetable trip; a diversion counts separately. */
const getTopologyKey = (trip: ObservedTripTopology): string =>
  [
    trip.tripId ?? trip.id,
    trip.lineId,
    trip.transportMode,
    trip.destination,
    getCallSequenceKey(trip.tripCalls ?? []),
  ].join("\u0000");

/** When a trip stops teaching the network: when `RunReadingStore` would retire its run. */
const getTopologyExpiry = (departure: Departure, now: number): number =>
  (findFinalCallInstant(departure.tripCalls) ?? now + RUN_READING_MAX_AGE_MS) + RUN_ENDED_GRACE_MS;

/**
 * Topology learned from live boards and requested runs, whichever view fetched them: one record per
 * distinct route, until the trip has run, so stopped lines leave by themselves. No run readings are
 * kept.
 */
export class ObservedNetworkStore {
  private readonly tripsByKey = new Map<
    string,
    { topology: ObservedTripTopology; expiresAt: number }
  >();
  private readonly listeners = new Set<() => void>();
  private snapshot = EMPTY_OBSERVED_NETWORK;

  rememberBoard(board: DepartureBoard, now = Date.now()): void {
    if (board.dataStatus === "live") this.rememberTrips(board.departures, now);
  }

  /** Every route a run's own reading states teaches the network as soon as it lands. */
  rememberTrips(departures: readonly Departure[], now = Date.now()): void {
    let changed = false;
    for (const departure of departures) {
      const topology = toTopology(departure);
      if (!topology) continue;
      const key = getTopologyKey(topology);
      const expiresAt = getTopologyExpiry(departure, now);
      const known = this.tripsByKey.get(key);
      if (known) {
        known.expiresAt = Math.max(known.expiresAt, expiresAt);
        continue;
      }
      if (expiresAt <= now) continue;
      this.tripsByKey.set(key, { topology, expiresAt });
      changed = true;
    }
    for (const [key, { expiresAt }] of this.tripsByKey) {
      if (expiresAt > now) continue;
      this.tripsByKey.delete(key);
      changed = true;
    }
    if (!changed) return;
    this.snapshot = buildObservedNetworkFromTrips(
      [...this.tripsByKey.values()].map(({ topology }) => topology),
    );
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): ObservedNetwork => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
