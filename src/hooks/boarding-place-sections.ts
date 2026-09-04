import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  findBoardingPlaceIdInView,
  type BoardingPlaceSectionReading,
} from "../lib/boarding-place-sections";
import { scrollIntoView } from "../lib/scroll";

export type BoardingPlaceSections = {
  /** The place the board is being read at, or `undefined` while it is being read at none. */
  activePlaceId: string | undefined;
  /** The ref a place's section renders under, which is how the bar knows where the places are. */
  getSectionRef: (placeId: string) => (section: HTMLElement | null) => void;
  /** Walks the board to a place's own section, as the stylesheet says a walked-to section lands. */
  scrollToSection: (placeId: string) => void;
};

/**
 * The place a board is being read at, and the way to read it at another.
 *
 * The place bar's buttons are a map of the board's own sections: tapping one walks the board to that
 * place, and the scroll marks the button of the place whose heading is stuck at the top. What the
 * two share is the landing point — the `scroll-margin-top` the stylesheet gives a section, read
 * back here as the line a section has to reach to count as being read — so arriving, marking and
 * sticking are one decision the CSS owns rather than two the code has to keep agreed.
 *
 * `isPageScrollport` says whose scrollport the sections are read in: the board's own on a wide
 * screen, the document's where the layout is stacked and the sticky headings pin under the app
 * bar instead of at the scrollport's top. The scroll is heard where it happens, so the same nav
 * serves both without either knowing a breakpoint.
 */
export function useBoardingPlaceSections(
  listRef: RefObject<HTMLElement | null>,
  { isEnabled, isPageScrollport }: { isEnabled: boolean; isPageScrollport: boolean },
): BoardingPlaceSections {
  const sectionByPlaceIdRef = useRef(new Map<string, HTMLElement>());
  const sectionRefByPlaceIdRef = useRef(new Map<string, (section: HTMLElement | null) => void>());
  const [activePlaceId, setActivePlaceId] = useState<string | undefined>(undefined);

  const getSectionRef = useCallback((placeId: string) => {
    let sectionRef = sectionRefByPlaceIdRef.current.get(placeId);
    if (!sectionRef) {
      sectionRef = (section) => {
        if (section) sectionByPlaceIdRef.current.set(placeId, section);
        else sectionByPlaceIdRef.current.delete(placeId);
      };
      sectionRefByPlaceIdRef.current.set(placeId, sectionRef);
    }
    return sectionRef;
  }, []);

  const scrollToSection = useCallback((placeId: string) => {
    const section = sectionByPlaceIdRef.current.get(placeId);
    if (section) scrollIntoView(section);
  }, []);

  const readActivePlaceId = useCallback(() => {
    const list = listRef.current;
    if (!list || sectionByPlaceIdRef.current.size === 0) {
      setActivePlaceId(undefined);
      return;
    }
    const readings: BoardingPlaceSectionReading[] = [];
    let landingInsetPx = 0;
    for (const [placeId, section] of sectionByPlaceIdRef.current) {
      readings.push({ id: placeId, top: section.getBoundingClientRect().top });
      // One decision for every section of a board: the inset a walked-to section stops short of,
      // which is the bar's height where the document scrolls and nothing at all where the board
      // scrolls itself.
      landingInsetPx =
        Number.parseFloat(getComputedStyle(section).scrollMarginTop) || landingInsetPx;
    }
    const scrollportTop = isPageScrollport ? 0 : list.getBoundingClientRect().top;
    setActivePlaceId(findBoardingPlaceIdInView(readings, scrollportTop + landingInsetPx));
  }, [isPageScrollport, listRef]);

  // Re-read whenever the board renders anew: a refresh regathers the sections, and the place the
  // board is being read at is a fact about what is on it now, not about the last scroll.
  useEffect(() => {
    if (!isEnabled) return;
    readActivePlaceId();
  });

  useEffect(() => {
    const list = listRef.current;
    if (!isEnabled || !list) return;
    const onScroll = () => readActivePlaceId();
    if (isPageScrollport) {
      window.addEventListener("scroll", onScroll, { passive: true });
      return () => window.removeEventListener("scroll", onScroll);
    }
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, [isEnabled, isPageScrollport, listRef, readActivePlaceId]);

  return { activePlaceId, getSectionRef, scrollToSection };
}
