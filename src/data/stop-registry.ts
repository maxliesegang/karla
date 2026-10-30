import type { FeedCall } from "./feed";
import { network } from "../networks/network";
import type { StopPlace, Call } from "./transit-types";
import { getQualifiedStopName } from "../lib/stop-naming";
import { getPartNames, toStopPlaceParts } from "../lib/stop-places";
import { createStopSlug } from "../lib/stop-slug";

/**
 * A dynamic stop id: the slug of its name, led by its town outside home, plus a short digest of its
 * first stop point (`stuttgart-hauptbahnhof--1a2b3c`). The slug is what resolving a link searches.
 */
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
  /**
   * Every stop point of the place met in one search answer, `stopPointId` first, by its own name;
   * its board joins them all, and their names are its parts. A call's name carries its town.
   */
  stopPoints?: readonly { stopPointId: string; name: string }[];
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
  private readonly stopPointIdsByDynamicStopId = new Map<string, readonly string[]>();
  private readonly dynamicStopIdByStopPointId = new Map<string, string>();
  /** A dynamic stop point's own name, as search answered it, for its place's parts. */
  private readonly nameByStopPointId = new Map<string, string>();

  constructor(authoredStops: readonly StopPlace[]) {
    this.authoredStopsById = new Map(authoredStops.map((stop) => [stop.id, stop]));
  }

  /** A stop the session holds, authored or dynamic. */
  findStop(stopId: string): StopPlace | undefined {
    return this.authoredStopsById.get(stopId) ?? this.dynamicStops.get(stopId);
  }

  /** The stop points a stop place's board joins; none for a stop the session has not met. */
  findStopPoints(stopId: string): readonly string[] {
    return (
      network.stopPlaces[stopId]?.stopPoints ?? this.stopPointIdsByDynamicStopId.get(stopId) ?? []
    );
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
    stopPoints: namedStopPoints,
    name,
    placeName,
    latitude,
    longitude,
    preferredId,
  }: StopRegistration): StopPlace {
    const stopPointIds = namedStopPoints?.map((stop) => stop.stopPointId) ?? [stopPointId];
    // The authored stop wins over a search hit or an old dynamic id, so page and journey calls use
    // one id.
    const authoredId = stopPointIds.map((id) => stopPlaceIdByStopPointId.get(id)).find(Boolean);
    const authored = authoredId ? this.authoredStopsById.get(authoredId) : undefined;
    if (authored) return authored;

    // Likewise a registered dynamic stop: a different spelling or a wider join enriches it rather
    // than duplicating it.
    const registeredId = stopPointIds
      .map((id) => this.dynamicStopIdByStopPointId.get(id))
      .find(Boolean);
    const registered = registeredId ? this.dynamicStops.get(registeredId) : undefined;
    for (const stop of namedStopPoints ?? [])
      this.nameByStopPointId.set(stop.stopPointId, stop.name);
    if (registered) {
      return this.withParts(this.enrich(registered, { stopPointIds, name, latitude, longitude }));
    }

    const slug = createStopSlug(
      getQualifiedStopName({ stopName: name, placeName }, network.home.placeName),
    );
    const id = preferredId ?? `${slug}--${hashStopPointId(stopPointId)}`;
    const stop: StopPlace = { id, name, placeName, latitude, longitude };
    this.dynamicStops.set(id, stop);
    this.stopPointIdsByDynamicStopId.set(id, stopPointIds);
    for (const joinedId of stopPointIds) this.dynamicStopIdByStopPointId.set(joinedId, id);
    return this.withParts(stop);
  }

  /** A dynamic place with parts for all its stop points, once search has named each of them. */
  private withParts(stop: StopPlace): StopPlace {
    const stopPointIds = this.stopPointIdsByDynamicStopId.get(stop.id) ?? [];
    if (stop.parts?.length === stopPointIds.length) return stop;
    const names = stopPointIds.map((stopPointId) => this.nameByStopPointId.get(stopPointId));
    if (!names.every((name) => name !== undefined)) return stop;
    const parts = toStopPlaceParts(stopPointIds, getPartNames(names));
    if (!parts) return stop;
    const parted = { ...stop, parts };
    this.dynamicStops.set(stop.id, parted);
    return parted;
  }

  /**
   * A registered dynamic stop with stop points newly met beside it, and its position where it had
   * none. Its id stays; a joined place takes the joined name.
   */
  private enrich(
    registered: StopPlace,
    {
      stopPointIds,
      name,
      latitude,
      longitude,
    }: Pick<StopPlace, "name" | "latitude" | "longitude"> & { stopPointIds: readonly string[] },
  ): StopPlace {
    const known = this.stopPointIdsByDynamicStopId.get(registered.id) ?? [];
    const added = stopPointIds.filter((id) => !known.includes(id));
    if (added.length > 0) {
      this.stopPointIdsByDynamicStopId.set(registered.id, [...known, ...added]);
      for (const id of added) this.dynamicStopIdByStopPointId.set(id, registered.id);
    }
    const isJoined = added.length > 0 && stopPointIds.length > 1;
    const isLocated = registered.latitude === undefined && latitude !== undefined;
    if (!isJoined && !isLocated) return registered;
    const enriched = {
      ...registered,
      ...(isJoined ? { name } : {}),
      ...(isLocated ? { latitude, longitude } : {}),
    };
    this.dynamicStops.set(registered.id, enriched);
    return enriched;
  }

  /**
   * Provider calls with every stop resolved to a local one, and located where the feed left them
   * unlocated (a board's own call; every TRIAS call).
   */
  toCalls(calls: readonly FeedCall[]): Call[] {
    return calls.map(({ stopPointId, ...journeyStop }) => {
      const stopPlaceId = stopPointId
        ? this.findCallStopPlaceId(stopPointId, journeyStop)
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

  /** A call's stop place: the network's, else one registered with, or located by, the call. */
  private findCallStopPlaceId(
    stopPointId: string,
    { stopName, placeName, latitude, longitude }: Omit<FeedCall, "stopPointId">,
  ): string {
    const authoredId = stopPlaceIdByStopPointId.get(stopPointId);
    return (
      authoredId ??
      this.register({ stopPointId, name: stopName, placeName, latitude, longitude }).id
    );
  }
}
