import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { findSectionIdInView, type ScrollSectionReading } from "../lib/scroll-sections";
import { scrollIntoView } from "../lib/scroll";

export type ScrollSections = {
  /** The section being read, or `undefined` above the first. */
  activeSectionId: string | undefined;
  /** Registers a section's element. */
  getSectionRef: (sectionId: string) => (section: HTMLElement | null) => void;
  /** Scrolls to a section, landing where the stylesheet's scroll margin says. */
  scrollToSection: (sectionId: string) => void;
};

/**
 * The section a list is read in, and scrolling to another. Landing, marking and sticking share one
 * line: the section's `scroll-margin-top`. Works in the list's own scrollport or the document's
 * (`isPageScrollport`) without knowing the breakpoint.
 */
export function useScrollSections(
  listRef: RefObject<HTMLElement | null>,
  { isEnabled, isPageScrollport }: { isEnabled: boolean; isPageScrollport: boolean },
): ScrollSections {
  const sectionByIdRef = useRef(new Map<string, HTMLElement>());
  const sectionRefByIdRef = useRef(new Map<string, (section: HTMLElement | null) => void>());
  const [activeSectionId, setActiveSectionId] = useState<string | undefined>(undefined);

  const getSectionRef = useCallback((sectionId: string) => {
    let sectionRef = sectionRefByIdRef.current.get(sectionId);
    if (!sectionRef) {
      sectionRef = (section) => {
        if (section) sectionByIdRef.current.set(sectionId, section);
        else sectionByIdRef.current.delete(sectionId);
      };
      sectionRefByIdRef.current.set(sectionId, sectionRef);
    }
    return sectionRef;
  }, []);

  const scrollToSection = useCallback((sectionId: string) => {
    const section = sectionByIdRef.current.get(sectionId);
    if (section) scrollIntoView(section);
  }, []);

  const readActiveSectionId = useCallback(() => {
    const list = listRef.current;
    if (!list || sectionByIdRef.current.size === 0) {
      setActiveSectionId(undefined);
      return;
    }
    const readings: ScrollSectionReading[] = [];
    let landingInsetPx = 0;
    for (const [sectionId, section] of sectionByIdRef.current) {
      readings.push({ id: sectionId, top: section.getBoundingClientRect().top });
      // The inset a scrolled-to section stops short of: the pinned bars where the document
      // scrolls, else zero.
      landingInsetPx =
        Number.parseFloat(getComputedStyle(section).scrollMarginTop) || landingInsetPx;
    }
    const scrollportTop = isPageScrollport ? 0 : list.getBoundingClientRect().top;
    setActiveSectionId(findSectionIdInView(readings, scrollportTop + landingInsetPx));
  }, [isPageScrollport, listRef]);

  // Re-read on every render: a refresh regathers the sections.
  useEffect(() => {
    if (!isEnabled) return;
    readActiveSectionId();
  });

  useEffect(() => {
    const list = listRef.current;
    if (!isEnabled || !list) return;
    const onScroll = () => readActiveSectionId();
    const scrollport = isPageScrollport ? window : list;
    scrollport.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollport.removeEventListener("scroll", onScroll);
  }, [isEnabled, isPageScrollport, listRef, readActiveSectionId]);

  return { activeSectionId, getSectionRef, scrollToSection };
}
