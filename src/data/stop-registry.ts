import type { FeedCall } from "./feed";
import { network } from "../networks/network";
import type { StopPlace, Call } from "./transit-types";
import { createStopSlug } from "../lib/stop-slug";

/** A dynamic stop id: name slug plus a short digest of its stop point (`hbf--1a2b3c`). */
export const DYNAMIC_STOP_ID_PATTERN = /^(.*?)--([a-z0-9]+)$/;

/** Every stop point of an authored place maps to it, so a journey resolves from whichever it calls at. */
const stopPlaceIdByStopPointId: ReadonlyMap<string, string> = new Map(
  Object.entries(network.stopPlaces).flatMap(([localId, { stopPoints }]) =>
    stopPoints.map((stopPointId) => [stopPointId, localId] as const),
  ),
);

/** The digest a dynamic id carries, so a deep link names one stop point. */
export function hashStopPointId(stopPointId: string): string {
  let hash = 2166136261;
  for (const character of stopPointId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export type StopRegistration = {
  stopPointId: string;
  name: string;
  placeName?: string;
  latitude?: number;
  longitude?: number;
  /** The id a deep link already used, so resolving it does not mint a second. */
  preferredId?: string;
};

/**
 * Stop point to stop place and back, for the session. The network's stop places first; others are
 * met through searches or journey calls and keep the same id thereafter.
 */
export class StopRegistry {
  private readonly authoredStopsById: ReadonlyMap<string, StopPlace>;
  private readonly dynamicStops = new Map<string, StopPlace>();
  /** Both directions of the dynamic-id pairing. */
  private readonly stopPointIdByDynamicStopId = new Map<string, string>();
  private readonly dynamicStopIdByStopPointId = new Map<string, string>();

  constructor(authoredStops: readonly StopPlace[]) {
    this.authoredStopsById = new Map(authoredStops.map((stop) => [stop.id, stop]));
  }

  /** A stop the session holds, authored or dynamic. */
  findStop(stopId: string): StopPlace | undefined {
    return this.authoredStopsById.get(stopId) ?? this.dynamicStops.get(stopId);
  }

  /** The stop points a stop place's board joins; none for a stop the session has not met. */
  findStopPoints(stopId: string): readonly string[] {
    const dynamic = this.stopPointIdByDynamicStopId.get(stopId);
    return network.stopPlaces[stopId]?.stopPoints ?? (dynamic ? [dynamic] : []);
  }

  /** The stop place a stop point belongs to, the network's before a dynamic one. */
  findStopPlaceId(stopPointId: string): string | undefined {
    return (
      stopPlaceIdByStopPointId.get(stopPointId) ?? this.dynamicStopIdByStopPointId.get(stopPointId)
    );
  }

  /** Registers a stop the authored network lacks, once per session. */
  register({
    stopPointId,
    name,
    placeName,
    latitude,
    longitude,
    preferredId,
  }: StopRegistration): StopPlace {
    // The authored stop wins over a search hit or an old dynamic id, so page and journey calls use
    // one id.
    const authoredId = stopPlaceIdByStopPointId.get(stopPointId);
    const authored = authoredId ? this.authoredStopsById.get(authoredId) : undefined;
    if (authored) return authored;

    // Likewise a registered dynamic stop: a different spelling enriches it rather than duplicating
    // it.
    const registeredId = this.dynamicStopIdByStopPointId.get(stopPointId);
    const registered = registeredId ? this.dynamicStops.get(registeredId) : undefined;
    if (registered) {
      if (registered.latitude === undefined && latitude !== undefined) {
        const enriched = { ...registered, latitude, longitude };
        this.dynamicStops.set(registered.id, enriched);
        return enriched;
      }
      return registered;
    }

    const id = preferredId ?? `${createStopSlug(name)}--${hashStopPointId(stopPointId)}`;
    const stop: StopPlace = { id, name, placeName, latitude, longitude };
    this.dynamicStops.set(id, stop);
    this.stopPointIdByDynamicStopId.set(id, stopPointId);
    this.dynamicStopIdByStopPointId.set(stopPointId, id);
    return stop;
  }

  /**
   * Provider calls with every stop resolved to a local one, and located where the feed left them
   * unlocated (a board's own call; every TRIAS call).
   */
  toCalls(calls: readonly FeedCall[]): Call[] {
    return calls.map(({ stopPointId, ...journeyStop }) => {
      const stopPlaceId = stopPointId
        ? this.resolveCallStopPlaceId(stopPointId, journeyStop)
        : createStopSlug(journeyStop.stopName);
      return {
        ...journeyStop,
        ...(stopPointId && journeyStop.latitude === undefined
          ? this.findPosition(stopPointId, journeyStop.bay)
          : {}),
        // Kept beside the stop place: which part of the page the rider is sent to.
        stopPointId,
        stopPlaceId,
      };
    });
  }

  /**
   * A city rail bay's position, else the catalog's for its stop, else the one its stop was
   * registered with.
   */
  private findPosition(
    stopPointId: string,
    bay: string | undefined,
  ): { latitude?: number; longitude?: number } {
    const bayPosition = network.bayPositionByKey.get(`${stopPointId}|${bay ?? ""}`);
    if (bayPosition) return { latitude: bayPosition.latitude, longitude: bayPosition.longitude };
    const catalogStop = network.findCatalogStop(stopPointId);
    if (catalogStop) return { latitude: catalogStop.latitude, longitude: catalogStop.longitude };
    const stopId = this.dynamicStopIdByStopPointId.get(stopPointId);
    const stop = stopId === undefined ? undefined : this.dynamicStops.get(stopId);
    return stop?.latitude === undefined
      ? {}
      : { latitude: stop.latitude, longitude: stop.longitude };
  }

  /**
   * The stop place for a journey call, registering it with its position; fills in a position missing
   * from a search-registered stop.
   */
  private resolveCallStopPlaceId(
    stopPointId: string,
    journeyStop: Omit<FeedCall, "stopPointId">,
  ): string {
    const knownId = this.findStopPlaceId(stopPointId);
    if (!knownId) {
      return this.register({
        stopPointId,
        name: journeyStop.stopName,
        placeName: journeyStop.placeName,
        latitude: journeyStop.latitude,
        longitude: journeyStop.longitude,
      }).id;
    }

    const known = this.dynamicStops.get(knownId);
    if (known && known.latitude === undefined && journeyStop.latitude !== undefined) {
      this.dynamicStops.set(knownId, {
        ...known,
        latitude: journeyStop.latitude,
        longitude: journeyStop.longitude,
      });
    }
    return knownId;
  }
}
