import { useEffect, useMemo, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { DepartureBoard, TransitNetwork, TransitStop } from "../data/transit-types";
import {
  getObservedStopPositions,
  getObservedTransitLines,
  type ObservedNetwork,
} from "../lib/observed-network";
import { useKeyedLoad } from "./use-keyed-load";

/**
 * The stops the app can resolve, plus the lines the feed is currently running. The stops are stable
 * for the session; the lines are read from the live core observation, so the app never offers a
 * rider a line that is not running.
 */
export function useTransitNetwork(observedNetwork: ObservedNetwork): TransitNetwork | null {
  const stableNetwork = useStableTransitNetwork();
  return useMemo(
    () =>
      stableNetwork ? { ...stableNetwork, lines: getObservedTransitLines(observedNetwork) } : null,
    [stableNetwork, observedNetwork],
  );
}

function useStableTransitNetwork(): TransitNetwork | null {
  const [network, setNetwork] = useState<TransitNetwork | null>(null);

  useEffect(() => {
    let active = true;
    transitSource.getNetwork().then((loadedNetwork) => {
      if (active) setNetwork(loadedNetwork);
    });
    return () => {
      active = false;
    };
  }, []);

  return network;
}

/**
 * What asking the provider about a deep-linked stop produced.
 *
 * A read that failed is kept apart from a definite answer of "nothing": a feed that did not answer
 * is not evidence that a stop does not exist, and presenting the one as the other turns a network
 * hiccup into a dead end.
 */
type RemoteStopResolution =
  | { status: "found"; stop: TransitStop }
  | { status: "missing" }
  | { status: "failed" };

const resolveRemoteTransitStop = (stopId: string): Promise<RemoteStopResolution> =>
  transitSource.resolveStop(stopId).then(
    (stop) => (stop ? { status: "found" as const, stop } : { status: "missing" as const }),
    () => ({ status: "failed" as const }),
  );

/** Resolves local core-network stops immediately and provider-backed network stops on demand. */
export function useTransitStop(
  network: TransitNetwork | null,
  stopId: string | undefined,
  { reloadNonce }: { reloadNonce?: number } = {},
): {
  stop: TransitStop | undefined;
  loading: boolean;
  /** The provider read failed rather than answered; asking again is meaningful. */
  failed: boolean;
} {
  // Everything the session already knows, which is more than the authored network: a stop met
  // through a board or through a trip's calls is known for the rest of the session. Walking along a
  // line diagram is the case this exists for — every stop of it was read from the trip drawing it,
  // so tapping one is a lookup and the view never has to render the not-knowing.
  const local = network ? transitSource.getKnownStop(stopId ?? "") : undefined;
  // The provider is only asked once the local network is in and has no answer of its own.
  const remote = useKeyedLoad(
    network && stopId && !local ? stopId : null,
    resolveRemoteTransitStop,
    { reloadNonce },
  );

  if (local) return { stop: local, loading: false, failed: false };
  return {
    stop: remote?.status === "found" ? remote.stop : undefined,
    loading: Boolean(stopId) && remote === null,
    failed: remote?.status === "failed",
  };
}

/**
 * The observed stops a rider could be located against, as the nearby ranking wants them.
 */
export function useLocatableStops(
  network: TransitNetwork | null,
  departureBoards: readonly DepartureBoard[],
): readonly TransitStop[] {
  return useMemo(() => {
    const byId = new Map<string, TransitStop>();
    for (const stop of network?.stops ?? []) {
      if (stop.latitude !== undefined) byId.set(stop.id, stop);
    }
    // The authored stops carry the better names, so an observed position only fills a gap.
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
