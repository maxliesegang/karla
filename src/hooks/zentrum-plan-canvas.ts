import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  getNeighboringZentrumZoom,
  getZentrumOpeningScroll,
  getZentrumPlanWidth,
  ZENTRUM_MAXIMUM_ZOOM,
  ZENTRUM_MINIMUM_ZOOM,
  ZENTRUM_ZOOM_STEPS,
} from "../lib/zentrum-plan-canvas";
import { useDragPan } from "./drag-pan";
import { useElementBox } from "./element-box";
import { usePinchZoom } from "./pinch-zoom";
import { useWheelZoom, type ZoomAt } from "./wheel-zoom";

/** The plan's drawn size and scrollport. */
export type ZentrumPlanCanvas = {
  /** The scrollport, which is also the box the plan fits. */
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  /** The drawn width; `undefined` until measured. */
  planWidth: number | undefined;
  canZoomIn: boolean;
  canZoomOut: boolean;
  changeZoom: (direction: 1 | -1) => void;
  fitWholePlan: () => void;
};

/**
 * The plan's drawn size. The zoom buttons keep the middle of the view in place; the wheel and a
 * pinch zoom between the steps and keep the point under the pointer or fingers.
 */
export function useZentrumPlanCanvas(): ZentrumPlanCanvas {
  const [zoom, setZoom] = useState<number>(ZENTRUM_ZOOM_STEPS[0]);
  const [isWholePlanFitted, setIsWholePlanFitted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * The point a zoom holds still: where it is on the plan, as a share, and where it stands in the
   * view, in pixels.
   */
  const zoomAnchor = useRef<{ x: number; y: number; left: number; top: number }>(null);
  /** Whether the plan has already been opened once. */
  const hasOpened = useRef(false);
  const center = useRef({ x: 0.5, y: 0.5 });
  const box = useElementBox(scrollRef);
  useDragPan(scrollRef);
  const planWidth = getZentrumPlanWidth(box, zoom, isWholePlanFitted);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const readCenter = () => {
      center.current = {
        x: (element.scrollLeft + element.clientWidth / 2) / element.scrollWidth,
        y: (element.scrollTop + element.clientHeight / 2) / element.scrollHeight,
      };
    };
    element.addEventListener("scroll", readCenter);
    return () => element.removeEventListener("scroll", readCenter);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!element || planWidth === undefined) return;
    if (anchor) {
      element.scrollLeft = anchor.x * element.scrollWidth - anchor.left;
      element.scrollTop = anchor.y * element.scrollHeight - anchor.top;
    } else if (hasOpened.current) {
      element.scrollLeft = center.current.x * element.scrollWidth - element.clientWidth / 2;
      element.scrollTop = center.current.y * element.scrollHeight - element.clientHeight / 2;
    } else {
      hasOpened.current = true;
      const { left, top } = getZentrumOpeningScroll(element);
      element.scrollLeft = left;
      element.scrollTop = top;
    }
    center.current = {
      x: (element.scrollLeft + element.clientWidth / 2) / element.scrollWidth,
      y: (element.scrollTop + element.clientHeight / 2) / element.scrollHeight,
    };
  }, [zoom, planWidth, box]);

  const holdAnchor = (point: { left: number; top: number }) => {
    const element = scrollRef.current;
    if (!element) return;
    zoomAnchor.current = {
      x: (element.scrollLeft + point.left) / element.scrollWidth,
      y: (element.scrollTop + point.top) / element.scrollHeight,
      ...point,
    };
  };

  const zoomAt: ZoomAt = (factor, point) => {
    const next = Math.min(Math.max(zoom * factor, ZENTRUM_MINIMUM_ZOOM), ZENTRUM_MAXIMUM_ZOOM);
    if (next === zoom) return;
    holdAnchor(point);
    setZoom(next);
  };
  useWheelZoom(scrollRef, zoomAt);
  usePinchZoom(scrollRef, zoomAt);

  return {
    fitWholePlan: () => {
      zoomAnchor.current = null;
      hasOpened.current = false;
      setIsWholePlanFitted(true);
      setZoom(ZENTRUM_ZOOM_STEPS[0]);
      const element = scrollRef.current;
      if (element) {
        const { left, top } = getZentrumOpeningScroll(element);
        element.scrollTo({ left, top, behavior: "instant" });
      }
    },
    scrollRef,
    zoom,
    planWidth,
    canZoomIn: zoom < ZENTRUM_MAXIMUM_ZOOM,
    canZoomOut: zoom > ZENTRUM_MINIMUM_ZOOM,
    changeZoom: (direction) => {
      const element = scrollRef.current;
      if (element) holdAnchor({ left: element.clientWidth / 2, top: element.clientHeight / 2 });
      setZoom((current) => getNeighboringZentrumZoom(current, direction));
    },
  };
}
