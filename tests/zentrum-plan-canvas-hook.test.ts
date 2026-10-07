import assert from "node:assert/strict";
import test from "node:test";
import "./support/render-hook.ts";
import { useZentrumPlanCanvas, type ZentrumPlanCanvas } from "../src/hooks/zentrum-plan-canvas.ts";
import { ZENTRUM_SCHEMATIC_VIEWBOX } from "../src/lib/zentrum-schematic-plan.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

test("resizing the map preserves the center after panning and zooming", async (t) => {
  let measure!: ResizeObserverCallback;
  const NativeResizeObserver = ResizeObserver;
  t.mock.method(globalThis, "ResizeObserver", function (callback: ResizeObserverCallback) {
    measure = callback;
    return new NativeResizeObserver(callback);
  });
  let width = 372;
  let height = 600;
  let plan!: ZentrumPlanCanvas;
  const ratio = ZENTRUM_SCHEMATIC_VIEWBOX.height / ZENTRUM_SCHEMATIC_VIEWBOX.width;
  const root = createRoot(document.createElement("div"));
  function Probe() {
    plan = useZentrumPlanCanvas();
    return createElement("div", { ref: plan.scrollRef });
  }
  const resize = async (nextWidth: number, nextHeight: number) => {
    width = nextWidth;
    height = nextHeight;
    await act(async () =>
      measure(
        [
          {
            contentRect: new DOMRect(0, 0, width, height),
            target: plan.scrollRef.current!,
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ],
        new NativeResizeObserver(() => {}),
      ),
    );
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    const element = plan.scrollRef.current!;
    Object.defineProperties(element, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => height },
      scrollWidth: { get: () => Math.max(width, plan.planWidth ?? 0) },
      scrollHeight: { get: () => Math.max(height, (plan.planWidth ?? 0) * ratio) },
    });
    await resize(width, height);
    element.scrollLeft += 40;
    element.scrollTop += 12;
    element.dispatchEvent(new Event("scroll"));
    const center = () => ({
      x: (element.scrollLeft + width / 2) / element.scrollWidth,
      y: (element.scrollTop + height / 2) / element.scrollHeight,
    });
    const panned = center();
    const assertCenter = () => {
      assert.ok(Math.abs(center().x - panned.x) < 0.000001);
      assert.ok(Math.abs(center().y - panned.y) < 0.000001);
    };
    await resize(372, 360);
    assertCenter();
    await act(async () => plan.changeZoom(1));
    assertCenter();
    await resize(372, 700);
    assertCenter();
    await resize(480, 300);
    assertCenter();
  } finally {
    await act(async () => root.unmount());
  }
});
