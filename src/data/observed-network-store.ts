import type { StopEvent, StopEventBoard, Call } from "./transit-types";
import {
  buildObservedNetworkFromJourneys,
  type ObservedNetwork,
  type ObservedJourneyTopology,
} from "../lib/observed-network";
import { findFinalCallInstant, getCallSequenceKey } from "../lib/calls";
import {
  DATED_JOURNEY_ENDED_GRACE_MS,
  DATED_JOURNEY_READING_MAX_AGE_MS,
} from "./dated-journey-reading-store";

const EMPTY_OBSERVED_NETWORK: ObservedNetwork = { stops: [], lines: [], journeyCount: 0 };

/** The topology fields of a call, without per-journey timing. */
const toTopologyCall = (call: Call): Call => ({
  stopName: call.stopName,
  ...(call.placeName ? { placeName: call.placeName } : {}),
  ...(call.bayText ? { bayText: call.bayText } : {}),
  ...(call.bay ? { bay: call.bay } : {}),
  ...(call.providerStopPointId ? { providerStopPointId: call.providerStopPointId } : {}),
  ...(call.localStopId ? { localStopId: call.localStopId } : {}),
  ...(call.latitude !== undefined ? { latitude: call.latitude } : {}),
  ...(call.longitude !== undefined ? { longitude: call.longitude } : {}),
});

const toTopology = (stopEvent: StopEvent): ObservedJourneyTopology | undefined =>
  stopEvent.status !== "cancelled" && stopEvent.calls?.length
    ? {
        id: stopEvent.id,
        ...(stopEvent.journeyRef ? { journeyRef: stopEvent.journeyRef } : {}),
        lineId: stopEvent.lineId,
        ...(stopEvent.lineRef ? { lineRef: stopEvent.lineRef } : {}),
        ptMode: stopEvent.ptMode,
        destinationText: stopEvent.destinationText,
        calls: stopEvent.calls.map(toTopologyCall),
      }
    : undefined;

/** One distinct topology of a timetable journey; a diversion counts separately. */
const getTopologyKey = (journey: ObservedJourneyTopology): string =>
  [
    journey.journeyRef ?? journey.id,
    journey.lineId,
    journey.ptMode,
    journey.destinationText,
    getCallSequenceKey(journey.calls ?? []),
  ].join("\u0000");

/**
 * When a journey stops teaching the network: when `DatedJourneyReadingStore` would retire its dated
 * journey.
 */
const getTopologyExpiry = (stopEvent: StopEvent, now: number): number =>
  (findFinalCallInstant(stopEvent.calls) ?? now + DATED_JOURNEY_READING_MAX_AGE_MS) +
  DATED_JOURNEY_ENDED_GRACE_MS;

/**
 * Topology learned from live boards and requested dated journeys, whichever view fetched them: one
 * record per distinct route, until the journey has run, so stopped lines leave by themselves. No
 * dated journey readings are kept.
 */
export class ObservedNetworkStore {
  private readonly journeysByKey = new Map<
    string,
    { topology: ObservedJourneyTopology; expiresAt: number }
  >();
  private readonly listeners = new Set<() => void>();
  private snapshot = EMPTY_OBSERVED_NETWORK;

  rememberBoard(board: StopEventBoard, now = Date.now()): void {
    if (board.dataStatus === "live") this.rememberJourneys(board.stopEvents, now);
  }

  /** Every route a dated journey's own reading states teaches the network as soon as it lands. */
  rememberJourneys(stopEvents: readonly StopEvent[], now = Date.now()): void {
    let changed = false;
    for (const stopEvent of stopEvents) {
      const topology = toTopology(stopEvent);
      if (!topology) continue;
      const key = getTopologyKey(topology);
      const expiresAt = getTopologyExpiry(stopEvent, now);
      const known = this.journeysByKey.get(key);
      if (known) {
        known.expiresAt = Math.max(known.expiresAt, expiresAt);
        continue;
      }
      if (expiresAt <= now) continue;
      this.journeysByKey.set(key, { topology, expiresAt });
      changed = true;
    }
    for (const [key, { expiresAt }] of this.journeysByKey) {
      if (expiresAt > now) continue;
      this.journeysByKey.delete(key);
      changed = true;
    }
    if (!changed) return;
    this.snapshot = buildObservedNetworkFromJourneys(
      [...this.journeysByKey.values()].map(({ topology }) => topology),
    );
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): ObservedNetwork => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
