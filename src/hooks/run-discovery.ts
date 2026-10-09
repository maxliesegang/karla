import { useRef } from "react";
import { transitSource } from "../data/transit-source";
import type { DepartureBoard, RunDiscoveryPost } from "../data/transit-types";
import { getRunDiscoveryPosts } from "../lib/run-discovery";
import { getDistinctRuns } from "../lib/trips";
import { useKeyedLoad } from "./keyed-load";
import {
  LINE_OBSERVATION_REFRESH_MS,
  ZENTRUM_OBSERVATION_REFRESH_MS,
} from "./departure-board-collection";
import { LINE_RUN_READING_MAX_AGE_MS } from "./run-reading-loader";

/** Discover exits and termini from the area's live runs; periodically scan for changed routes. */
export function useRunDiscovery(
  areaStopIds: readonly string[],
  evidenceBoards: readonly DepartureBoard[],
) {
  const areaKey = areaStopIds.slice().sort().join(",");
  const knowledge = useRef<{
    areaKey: string;
    scannedAt: number;
    posts: readonly RunDiscoveryPost[];
  }>({ areaKey, scannedAt: 0, posts: [] });
  return useKeyedLoad(
    areaKey,
    async (_key, isEntryRead) => {
      const previous = knowledge.current;
      const scan =
        previous.areaKey !== areaKey ||
        isEntryRead ||
        Date.now() - previous.scannedAt >= ZENTRUM_OBSERVATION_REFRESH_MS;
      const evidenceRuns = evidenceBoards
        .filter((board) => board.dataStatus === "live")
        .flatMap((board) => board.departures);
      const evidencePosts = getRunDiscoveryPosts(areaStopIds, evidenceRuns);
      const requests = [
        ...new Map(
          [
            ...(scan
              ? areaStopIds.map((stopId): RunDiscoveryPost => ({ stopId, eventKind: "departure" }))
              : previous.posts),
            ...evidencePosts,
          ].map((post) => [`${post.stopId}:${post.eventKind}`, post]),
        ).values(),
      ];
      const options = {
        maxAgeMs: isEntryRead ? 0 : LINE_OBSERVATION_REFRESH_MS,
        runMaxAgeMs: isEntryRead ? 0 : LINE_RUN_READING_MAX_AGE_MS,
        topologyMaxAgeMs: scan ? 0 : ZENTRUM_OBSERVATION_REFRESH_MS,
        horizonMs: LINE_OBSERVATION_REFRESH_MS + 20_000,
      };
      const reading = await transitSource.getRunDiscoveryReading(requests, options);
      const posts = getRunDiscoveryPosts(areaStopIds, [...evidenceRuns, ...reading.runDepartures]);
      const requested = new Set(requests.map((post) => `${post.stopId}:${post.eventKind}`));
      const additions = posts.filter((post) => !requested.has(`${post.stopId}:${post.eventKind}`));
      const extra = additions.length
        ? await transitSource.getRunDiscoveryReading(additions, {
            ...options,
            runMaxAgeMs: LINE_RUN_READING_MAX_AGE_MS,
          })
        : undefined;
      const failedStopIds = [...reading.failedStopIds, ...(extra?.failedStopIds ?? [])];
      knowledge.current = {
        areaKey,
        scannedAt: scan && reading.failedStopIds.length === 0 ? Date.now() : previous.scannedAt,
        posts: failedStopIds.length
          ? [...requests, ...additions]
          : getRunDiscoveryPosts(areaStopIds, [
              ...evidenceRuns,
              ...reading.runDepartures,
              ...(extra?.runDepartures ?? []),
            ]),
      };
      return {
        runDepartures: getDistinctRuns([...reading.runDepartures, ...(extra?.runDepartures ?? [])]),
        clockBoard:
          extra?.clockBoard &&
          (!reading.clockBoard || extra.clockBoard.receivedAt > reading.clockBoard.receivedAt)
            ? extra.clockBoard
            : reading.clockBoard,
        failedStopIds,
      };
    },
    {
      refreshMs: LINE_OBSERVATION_REFRESH_MS,
      getFailureKind: (value) => (value.failedStopIds.length > 0 ? "unavailable" : undefined),
    },
  );
}
