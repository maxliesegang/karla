import { useEffect, useState } from "react";

/** The breakpoint the stacked layout is keyed to; the stylesheet carries the same one. */
const NARROW_VIEWPORT_QUERY = "(max-width: 860px)";

/** A boolean media query, updated only while the page is being read. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const queryList = window.matchMedia(query);
    const update = () => setMatches(queryList.matches);
    update();
    queryList.addEventListener("change", update);
    return () => queryList.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** Responsive composition belongs in the shell; components receive the resulting layout as data. */
export function useIsNarrowViewport(): boolean {
  return useMediaQuery(NARROW_VIEWPORT_QUERY);
}
