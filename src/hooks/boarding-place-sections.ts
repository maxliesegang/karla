import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  findBoardingPlaceIdInView,
  type BoardingPlaceSectionReading,
} from "../lib/boarding-place-sections";
import { scrollIntoView } from "../lib/scroll";

export type BoardingPlaceSections = {
  /** The place being read, or `undefined`. */
  activePlaceId: string | undefined;
  /** Registers a place's section element. */
  getSectionRef: (placeId: string) => (section: HTMLElement | null) => void;
  /** Scrolls to a place's section, landing where the stylesheet's scroll margin says. */
  scrollToSection: (placeId: string) => void;
};

/**
 * The place a board is read at, and scrolling to another. Landing, marking and sticking share one
 * line: the section's `scroll-margin-top`. Works in the board's scrollport or the document's
 * (`isPageScrollport`) without knowing the breakpoint.
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
      // The inset a scrolled-to section stops short of: the bar where the document scrolls, else
      // zero.
      landingInsetPx =
        Number.parseFloat(getComputedStyle(section).scrollMarginTop) || landingInsetPx;
    }
    const scrollportTop = isPageScrollport ? 0 : list.getBoundingClientRect().top;
    setActivePlaceId(findBoardingPlaceIdInView(readings, scrollportTop + landingInsetPx));
  }, [isPageScrollport, listRef]);

  // Re-read on every render: a refresh regathers the sections.
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
