import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { findNetworkBandIdInView, type NetworkBandReading } from "../lib/network-band-navigation";
import { scrollIntoView } from "../lib/scroll";

export type NetworkBandNavigation = {
  /** The band the page is being read in, or `undefined` while it is being read in none. */
  activeBandId: string | undefined;
  /** The ref a band's section renders under, which is how the navigation knows where the bands are. */
  getBandRef: (bandId: string) => (band: HTMLElement | null) => void;
  /** Walks the page to a band's own section, as the stylesheet says a walked-to band lands. */
  scrollToBand: (bandId: string) => void;
};

/**
 * The band the line index is being read in, and the way to read it in another.
 *
 * The band navigation's buttons are a map of the page's own bands: tapping one walks the page to
 * that band, and the scroll marks the button of the band whose heading is stuck at the top. What
 * the two share is the landing point — the `scroll-margin-top` the stylesheet gives a band, read
 * back here as the line a band has to reach to count as being read — so arriving, marking and
 * sticking are one decision the CSS owns rather than two the code has to keep agreed.
 *
 * `isPageScrollport` says whose scrollport the bands are read in: the list's own on a wide screen,
 * the document's where the layout is stacked and the sticky headings pin under the app bar instead
 * of at the scrollport's top. The scroll is heard where it happens, so the same navigation serves
 * both without either knowing a breakpoint.
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
      // One decision for every band of the page: the inset a walked-to band stops short of, which
      // is the bar and the navigation's own height where the document scrolls and nothing at all
      // where the list scrolls itself.
      landingInsetPx = Number.parseFloat(getComputedStyle(band).scrollMarginTop) || landingInsetPx;
    }
    const scrollportTop = isPageScrollport ? 0 : list.getBoundingClientRect().top;
    setActiveBandId(findNetworkBandIdInView(readings, scrollportTop + landingInsetPx));
  }, [isPageScrollport, listRef]);

  // Re-read whenever the page renders anew: the observed network regathers the bands, and the band
  // the page is being read in is a fact about what is on it now, not about the last scroll.
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
