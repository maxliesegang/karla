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
 * The size the plan is drawn at, and the place the reader keeps while it changes.
 *
 * A zoom the scroll position is not moved with is a jump: the plan grows away from its top left
 * corner, so pressing + on the Hauptbahnhof leaves the reader over the Kaiserstraße. So the middle
 * of what is on screen is remembered as a share of the plan and put back under the middle once the
 * new width has been laid out — the step in and the step out land on the same place.
 */
export function useZentrumPlanCanvas(): ZentrumPlanCanvas {
  const [zoom, setZoom] = useState<number>(ZENTRUM_ZOOM_STEPS[0]);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Where the reader was looking when the zoom was pressed, as a share of the whole plan. */
  const zoomAnchor = useRef<{ x: number; y: number }>(null);
  /** Whether the plan has been laid out once, and so already put the middle of itself on screen. */
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
    // A plan drawn larger than its box opens on the middle of itself rather than on its top left
    // corner: a phone otherwise opens on the Mühlburger Tor, which is the edge of the Zentrum, and
    // the reader has to pan to find the middle before they can read anything. Once only -- after
    // that the place being read is the reader's own, and a re-measure must not take it from them.
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
