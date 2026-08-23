import { useEffect, useMemo, useRef, useState } from "react";
import { getViewStartKey, parseRoute, type AppRoute } from "../routing";

/** Tracking the raw hash keeps a repeated `hashchange` for the same URL from re-rendering the app. */
export function useAppRoute(): AppRoute {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener("hashchange", sync);
    sync();
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const route = useMemo(() => parseRoute(hash), [hash]);

  // Where the view starts, for the addresses that start anywhere at all. `getViewStartKey` holds
  // the rule; a trip answers `null` there because its diagram does the placing.
  const viewStartKey = getViewStartKey(route);
  const lastViewStartKey = useRef(viewStartKey);
  useEffect(() => {
    if (viewStartKey === null || lastViewStartKey.current === viewStartKey) return;
    lastViewStartKey.current = viewStartKey;
    window.scrollTo({ top: 0, left: 0 });
  }, [viewStartKey]);

  return route;
}
