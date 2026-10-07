import assert from "node:assert/strict";
import test from "node:test";
import {
  type ZentrumSchematicEdge,
  type ZentrumSchematicLinePath,
  type ZentrumSchematicNode,
  getEdgeKey,
} from "../src/lib/zentrum-schematic-plan.ts";
import { getZentrumSchematicLaneBends } from "../src/lib/zentrum-schematic-paths.ts";

test("lanes turning together at a stop stay one lane apart in either direction", () => {
  const west = { id: "west", label: "West", x: 0, y: 0 };
  const stop = { id: "stop", label: "Stop", x: 100, y: 0 };
  const trackIds = ["1", "2", "3", "4"];
  const width = 7;
  for (const to of [
    { id: "south", label: "South", x: 100, y: 100 },
    { id: "short-south", label: "South", x: 100, y: 44 },
    { id: "tight-south", label: "South", x: 100, y: 22 },
    { id: "diagonal", label: "Diagonal", x: 200, y: 100 },
  ]) {
    const edge = (from: ZentrumSchematicNode, to: ZentrumSchematicNode): ZentrumSchematicEdge => ({
      id: getEdgeKey(from.id, to.id),
      from,
      to,
      lineIds: trackIds,
      trackIds,
      trackBandOffset: 0,
    });
    const edges = [edge(west, stop), edge(stop, to)];
    for (const nodes of [
      [west, stop, to],
      [to, stop, west],
    ]) {
      const paths: ZentrumSchematicLinePath[] = trackIds.map((trackId) => ({
        id: trackId,
        lineId: trackId,
        trackId,
        nodes,
      }));
      const bends = getZentrumSchematicLaneBends(paths, edges, width);
      assert.equal(bends.length, trackIds.length);
      for (let lane = 1; lane < bends.length; lane += 1) {
        for (let sample = 0; sample < bends[lane].points.length; sample += 1) {
          const left = bends[lane - 1].points[sample];
          const right = bends[lane].points[sample];
          const distance = Math.hypot(left.x - right.x, left.y - right.y);
          assert.ok(Math.abs(distance - width) < 0.01, `${to.id}: lanes are ${distance} apart`);
        }
      }
    }
  }
});
