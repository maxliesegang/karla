import { network } from "../networks/network";
import type { TransitNetwork, StopPlace } from "./transit-types";

/**
 * The stops the app resolves without asking: the network's stop places, placed at their busiest
 * stop point in the catalog.
 */
export const transitNetwork: TransitNetwork = {
  // A stop place whose stop point left the catalog is dropped; `tests/stop-catalog.test.ts` fails
  // the build on it.
  stops: Object.entries(network.stopPlaces).flatMap(([id, place]): StopPlace[] => {
    const catalogStop = network.findCatalogStop(place.stopPoints[0]);
    if (!catalogStop) return [];
    // A stop outside the home municipality is qualified by its district; a former name otherwise.
    const alias = place.placeName ?? place.formerName;
    return [
      {
        id,
        name: place.name,
        latitude: catalogStop.latitude,
        longitude: catalogStop.longitude,
        ...(alias ? { alias } : {}),
      },
    ];
  }),
  // Lines come from the live feed (`lib/observed-network.ts`).
  lines: [],
};
