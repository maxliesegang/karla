import assert from "node:assert/strict";
import test from "node:test";
import { flush, renderHook } from "./support/render-hook.ts";
import type { Departure } from "../src/data/transit-types.ts";
import { transitSource } from "../src/data/transit-source.ts";
import { createLineSelection } from "../src/lib/line-bundles.ts";
import { useLineRoutes } from "../src/hooks/line-observation.ts";
import type { LineObservationBoard } from "../src/lib/line-observation.ts";

const row = (id: string, routeDirectionId: string) =>
  ({ id, lineId: "3", routeDirectionId }) as Departure;

const selection = createLineSelection("3", []);

test("a line's published route is kept once the provider answers it", async () => {
  const asked: string[] = [];
  transitSource.getLineRoute = async (rowId) => {
    asked.push(rowId);
    return rowId === "out" ? ["a", "b", "c"] : ["c", "d"];
  };
  const boards: LineObservationBoard[] = [{ departures: [row("out", "3:H"), row("back", "3:R")] }];

  const routes = await renderHook(
    (props: { boards: LineObservationBoard[] }) => useLineRoutes(selection, props.boards),
    { boards },
  );
  await flush();

  assert.deepEqual(routes.current.get("3"), ["a", "b", "c", "d"]);
  assert.deepEqual(asked.sort(), ["back", "out"]);

  // A re-render with new boards naming the same directions asks for nothing again.
  await routes.rerender({ boards: [{ departures: [row("out2", "3:H")] }] });
  await flush();
  assert.deepEqual(asked.sort(), ["back", "out"]);
  await routes.unmount();
});
