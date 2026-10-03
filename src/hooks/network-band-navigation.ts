import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { findNetworkBandIdInView, type NetworkBandReading } from "../lib/network-band-navigation";
import { scrollIntoView } from "../lib/scroll";

export type NetworkBandNavigation = {
  /** The band being read, or `undefined`. */
  activeBandId: string | undefined;
  /** Registers a band's section element. */
  getBandRef: (bandId: string) => (band: HTMLElement | null) => void;
  /** Scrolls to a band, landing where the stylesheet's scroll margin says. */
  scrollToBand: (bandId: string) => void;
};

/**
 * The band the line index is read in, and scrolling to another. Landing, marking and sticking share
 * one line: the band's `scroll-margin-top`. Works in the list's own scrollport or the document's
 * (`isPageScrollport`) without knowing the breakpoint.
 */
export function useNetworkBandNavigation(
  listRef: RefObject<HTMLElement | null>,
  { isEnabled, isPageScrollport }: { isEnabled: boolean; isPageScrollport: boolean },
): NetworkBandNavigation {
  const bandByIdRef = useRef(new Map<string, HTMLElement>());
  const bandRefByIdRef = useRef(new Map<string, (band: HTMLElement | null) => void>());
  const [activeBandId, setActiveBandId] = useState<string | undefined>(undefined);

  const getBandRef = useCallback((bandId: string) => {
    let bandRef = bandRefByIdRef.current.get(bandId);
    if (!bandRef) {
      bandRef = (band) => {
        if (band) bandByIdRef.current.set(bandId, band);
        else bandByIdRef.current.delete(bandId);
      };
      bandRefByIdRef.current.set(bandId, bandRef);
    }
    return bandRef;
  }, []);

  const scrollToBand = useCallback((bandId: string) => {
    const band = bandByIdRef.current.get(bandId);
    if (band) scrollIntoView(band);
  }, []);

  const readActiveBandId = useCallback(() => {
    const list = listRef.current;
    if (!list || bandByIdRef.current.size === 0) {
      setActiveBandId(undefined);
      return;
    }
    const readings: NetworkBandReading[] = [];
    let landingInsetPx = 0;
    for (const [bandId, band] of bandByIdRef.current) {
      readings.push({ id: bandId, top: band.getBoundingClientRect().top });
      // The inset a scrolled-to band stops short of: bar plus nav where the document scrolls, else
      // zero.
      landingInsetPx = Number.parseFloat(getComputedStyle(band).scrollMarginTop) || landingInsetPx;
    }
    const scrollportTop = isPageScrollport ? 0 : list.getBoundingClientRect().top;
    setActiveBandId(findNetworkBandIdInView(readings, scrollportTop + landingInsetPx));
  }, [isPageScrollport, listRef]);

  // Re-read on every render: the bands may have been regathered.
  useEffect(() => {
    if (!isEnabled) return;
    readActiveBandId();
  });

  useEffect(() => {
    const list = listRef.current;
    if (!isEnabled || !list) return;
    const onScroll = () => readActiveBandId();
    if (isPageScrollport) {
      window.addEventListener("scroll", onScroll, { passive: true });
      return () => window.removeEventListener("scroll", onScroll);
    }
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, [isEnabled, isPageScrollport, listRef, readActiveBandId]);

  return { activeBandId, getBandRef, scrollToBand };
}
