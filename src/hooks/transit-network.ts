import { useMemo } from "react";
import { transitSource } from "../data/transit-source";
import type { DepartureBoard, TransitNetwork, TransitStop } from "../data/transit-types";
import {
  getObservedStopPositions,
  getObservedTransitLines,
  type ObservedNetwork,
} from "../lib/observed-network";
import { useKeyedLoad } from "./keyed-load";

/** The resolvable stops plus the lines currently running, read from the live observation. */
export function useTransitNetwork(observedNetwork: ObservedNetwork): TransitNetwork {
  return useMemo(
    () => ({ ...transitSource.getNetwork(), lines: getObservedTransitLines(observedNetwork) }),
    [observedNetwork],
  );
}

/** A provider lookup's outcome; a failed read is not "no such stop". */
type RemoteStopResolution =
  | { status: "found"; stop: TransitStop }
  | { status: "missing" }
  | { status: "failed" };

const resolveRemoteTransitStop = (stopId: string): Promise<RemoteStopResolution> =>
  transitSource.resolveStop(stopId).then(
    (stop) => (stop ? { status: "found" as const, stop } : { status: "missing" as const }),
    () => ({ status: "failed" as const }),
  );

/** Known stops at once; provider stops on demand. */
export function useTransitStop(
  stopId: string | undefined,
  { reloadNonce }: { reloadNonce?: number } = {},
): {
  stop: TransitStop | undefined;
  loading: boolean;
  /** The provider read failed, so asking again makes sense. */
  failed: boolean;
} {
  // Everything the session knows (stops met through boards and trips), so stepping along a line
  // diagram is a lookup without a loading state.
  const local = stopId ? transitSource.getKnownStop(stopId) : undefined;
  // Only asks the provider without a session answer.
  const remote = useKeyedLoad(stopId && !local ? stopId : null, resolveRemoteTransitStop, {
    reloadNonce,
  });

  if (local) return { stop: local, loading: false, failed: false };
  return {
    stop: remote?.status === "found" ? remote.stop : undefined,
    loading: Boolean(stopId) && remote === null,
    failed: remote?.status === "failed",
  };
}

/** Observed stops the nearby ranking can locate against. */
export function useLocatableStops(
  network: TransitNetwork,
  departureBoards: readonly DepartureBoard[],
): readonly TransitStop[] {
  return useMemo(() => {
    const byId = new Map<string, TransitStop>();
    for (const stop of network.stops) {
      if (stop.latitude !== undefined) byId.set(stop.id, stop);
    }
    // Authored names win; observed positions only fill gaps.
    for (const position of getObservedStopPositions(departureBoards)) {
      if (byId.has(position.id)) continue;
      byId.set(position.id, {
        id: position.id,
        name: position.name,
        alias: position.placeName,
        latitude: position.latitude,
        longitude: position.longitude,
      });
    }
    return [...byId.values()];
  }, [network, departureBoards]);
}
