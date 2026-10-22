import { useRef } from "react";
import { transitSource } from "../data/transit-source";
import type { StopEventBoard, DatedJourneyDiscoveryPost } from "../data/transit-types";
import { getDatedJourneyDiscoveryPosts } from "../lib/dated-journey-discovery";
import { getDistinctDatedJourneys } from "../lib/journeys";
import { useKeyedLoad } from "./keyed-load";
import {
  LINE_OBSERVATION_REFRESH_MS,
  ZENTRUM_OBSERVATION_REFRESH_MS,
} from "./stop-event-board-collection";
import { LINE_DATED_JOURNEY_READING_MAX_AGE_MS } from "./dated-journey-reading-loader";

/**
 * Discover exits and termini from the area's live dated journeys; periodically scan for changed
 * routes.
 */
export function useDatedJourneyDiscovery(
  areaStopIds: readonly string[],
  evidenceBoards: readonly StopEventBoard[],
) {
  const areaKey = areaStopIds.slice().sort().join(",");
  const knowledge = useRef<{
    areaKey: string;
    scannedAt: number;
    posts: readonly DatedJourneyDiscoveryPost[];
  }>({ areaKey, scannedAt: 0, posts: [] });
  return useKeyedLoad(
    areaKey,
    async (_key, isEntryRead) => {
      const previous = knowledge.current;
      const scan =
        previous.areaKey !== areaKey ||
        isEntryRead ||
        Date.now() - previous.scannedAt >= ZENTRUM_OBSERVATION_REFRESH_MS;
      const evidenceDatedJourneys = evidenceBoards
        .filter((board) => board.dataStatus === "live")
        .flatMap((board) => board.stopEvents);
      const evidencePosts = getDatedJourneyDiscoveryPosts(areaStopIds, evidenceDatedJourneys);
      const requests = [
        ...new Map(
          [
            ...(scan
              ? areaStopIds.map(
                  (stopId): DatedJourneyDiscoveryPost => ({ stopId, eventKind: "departure" }),
                )
              : previous.posts),
            ...evidencePosts,
          ].map((post) => [`${post.stopId}:${post.eventKind}`, post]),
        ).values(),
      ];
      const options = {
        maxAgeMs: isEntryRead ? 0 : LINE_OBSERVATION_REFRESH_MS,
        datedJourneyMaxAgeMs: isEntryRead ? 0 : LINE_DATED_JOURNEY_READING_MAX_AGE_MS,
        topologyMaxAgeMs: scan ? 0 : ZENTRUM_OBSERVATION_REFRESH_MS,
        horizonMs: LINE_OBSERVATION_REFRESH_MS + 20_000,
      };
      const reading = await transitSource.getDatedJourneyDiscoveryReading(requests, options);
      const posts = getDatedJourneyDiscoveryPosts(areaStopIds, [
        ...evidenceDatedJourneys,
        ...reading.datedJourneyStopEvents,
      ]);
      const requested = new Set(requests.map((post) => `${post.stopId}:${post.eventKind}`));
      const additions = posts.filter((post) => !requested.has(`${post.stopId}:${post.eventKind}`));
      const extra = additions.length
        ? await transitSource.getDatedJourneyDiscoveryReading(additions, {
            ...options,
            datedJourneyMaxAgeMs: LINE_DATED_JOURNEY_READING_MAX_AGE_MS,
          })
        : undefined;
      const failedStopIds = [...reading.failedStopIds, ...(extra?.failedStopIds ?? [])];
      knowledge.current = {
        areaKey,
        scannedAt: scan && reading.failedStopIds.length === 0 ? Date.now() : previous.scannedAt,
        posts: failedStopIds.length
          ? [...requests, ...additions]
          : getDatedJourneyDiscoveryPosts(areaStopIds, [
              ...evidenceDatedJourneys,
              ...reading.datedJourneyStopEvents,
              ...(extra?.datedJourneyStopEvents ?? []),
            ]),
      };
      return {
        datedJourneyStopEvents: getDistinctDatedJourneys([
          ...reading.datedJourneyStopEvents,
          ...(extra?.datedJourneyStopEvents ?? []),
        ]),
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
