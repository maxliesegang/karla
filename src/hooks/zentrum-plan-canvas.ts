import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  getNeighboringZentrumZoom,
  getZentrumOpeningScroll,
  getZentrumPlanWidth,
  getZentrumPortraitFrameHeight,
  ZENTRUM_MAXIMUM_ZOOM,
  ZENTRUM_MINIMUM_ZOOM,
  ZENTRUM_ZOOM_STEPS,
} from "../lib/zentrum-plan-canvas";
import { useDragPan } from "./drag-pan";
import { useElementBox } from "./element-box";
import { useWheelZoom } from "./wheel-zoom";

/** The plan's drawn size and scrollport. */
export type ZentrumPlanCanvas = {
  /** The scrollport, which is also the box the plan fits. */
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  /** The drawn width; `undefined` until measured. */
  planWidth: number | undefined;
  /** How tall a portrait box needs to be for the city-centre frame; `undefined` until measured. */
  frameHeight: number | undefined;
  canZoomIn: boolean;
  canZoomOut: boolean;
  changeZoom: (direction: 1 | -1) => void;
};

/**
 * The plan's drawn size. The zoom buttons keep the middle of the view in place; the wheel zooms
 * between the steps and keeps the point under the pointer.
 */
export function useZentrumPlanCanvas(): ZentrumPlanCanvas {
  const [zoom, setZoom] = useState<number>(ZENTRUM_ZOOM_STEPS[0]);
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * The point a zoom holds still: where it is on the plan, as a share, and where it stands in the
   * view, in pixels.
   */
  const zoomAnchor = useRef<{ x: number; y: number; left: number; top: number }>(null);
  /** Whether the plan has already been opened once. */
  const hasOpened = useRef(false);
  const box = useElementBox(scrollRef);
  useDragPan(scrollRef);
  const planWidth = getZentrumPlanWidth(box, zoom);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!element) return;
    if (anchor) {
      element.scrollLeft = anchor.x * element.scrollWidth - anchor.left;
      element.scrollTop = anchor.y * element.scrollHeight - anchor.top;
      return;
    }
    // A plan larger than its box opens on the city centre, once; later re-measures do not move it.
    if (hasOpened.current || planWidth === undefined) return;
    hasOpened.current = true;
    const { left, top } = getZentrumOpeningScroll(element);
    element.scrollLeft = left;
    element.scrollTop = top;
  }, [zoom, planWidth]);

  const holdAnchor = (point: { left: number; top: number }) => {
    const element = scrollRef.current;
    if (!element) return;
    zoomAnchor.current = {
      x: (element.scrollLeft + point.left) / element.scrollWidth,
      y: (element.scrollTop + point.top) / element.scrollHeight,
      ...point,
    };
  };

  useWheelZoom(scrollRef, (factor, point) => {
    const next = Math.min(Math.max(zoom * factor, ZENTRUM_MINIMUM_ZOOM), ZENTRUM_MAXIMUM_ZOOM);
    if (next === zoom) return;
    holdAnchor(point);
    setZoom(next);
  });

  return {
    scrollRef,
    zoom,
    planWidth,
    frameHeight: box ? Math.ceil(getZentrumPortraitFrameHeight(box.width)) : undefined,
    canZoomIn: zoom < ZENTRUM_MAXIMUM_ZOOM,
    canZoomOut: zoom > ZENTRUM_MINIMUM_ZOOM,
    changeZoom: (direction) => {
      const element = scrollRef.current;
      if (element) holdAnchor({ left: element.clientWidth / 2, top: element.clientHeight / 2 });
      setZoom((current) => getNeighboringZentrumZoom(current, direction));
    },
  };
}
