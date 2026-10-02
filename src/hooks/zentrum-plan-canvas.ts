import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  getNeighboringZentrumZoom,
  getZentrumPlanWidth,
  ZENTRUM_MAXIMUM_ZOOM,
  ZENTRUM_MINIMUM_ZOOM,
  ZENTRUM_ZOOM_STEPS,
} from "../lib/zentrum-plan-canvas";
import { useElementBox } from "./element-box";

/** The plan as it is being read: how big it is drawn, and in which scrollport. */
export type ZentrumPlanCanvas = {
  /** The scrollport the plan is read in, which is also the box it is fitted to. */
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  /** The width the plan is drawn at; `undefined` until the box has been measured. */
  planWidth: number | undefined;
  canZoomIn: boolean;
  canZoomOut: boolean;
  changeZoom: (direction: 1 | -1) => void;
};

/**
 * The size the plan is drawn at. A zoom keeps the middle of the view where it was: unanchored, the
 * plan grows away from its top left corner and the reader loses their place.
 */
export function useZentrumPlanCanvas(): ZentrumPlanCanvas {
  const [zoom, setZoom] = useState<number>(ZENTRUM_ZOOM_STEPS[0]);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The middle of the view when the zoom was pressed, as a share of the plan. */
  const zoomAnchor = useRef<{ x: number; y: number }>(null);
  /** Whether the plan has already been centred once. */
  const hasOpened = useRef(false);
  const box = useElementBox(scrollRef);
  const planWidth = getZentrumPlanWidth(box, zoom);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!element) return;
    if (anchor) {
      element.scrollLeft = anchor.x * element.scrollWidth - element.clientWidth / 2;
      element.scrollTop = anchor.y * element.scrollHeight - element.clientHeight / 2;
      return;
    }
    // A plan larger than its box opens centred, not on its edge. Once only: after that the place
    // being read is the reader's, and a re-measure must not move it.
    if (hasOpened.current || planWidth === undefined) return;
    hasOpened.current = true;
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  }, [zoom, planWidth]);

  return {
    scrollRef,
    zoom,
    planWidth,
    canZoomIn: zoom < ZENTRUM_MAXIMUM_ZOOM,
    canZoomOut: zoom > ZENTRUM_MINIMUM_ZOOM,
    changeZoom: (direction) => {
      const element = scrollRef.current;
      if (element) {
        zoomAnchor.current = {
          x: (element.scrollLeft + element.clientWidth / 2) / element.scrollWidth,
          y: (element.scrollTop + element.clientHeight / 2) / element.scrollHeight,
        };
      }
      setZoom((current) => getNeighboringZentrumZoom(current, direction));
    },
  };
}
