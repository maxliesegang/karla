/**
 * Which KVV interface the app reads, for its whole life: TRIAS through the proxy, or EFA when the
 * build sets `VITE_USE_EFA=true`. The two are never mixed in one session.
 */

/** Browser proxy addresses; Vite forwards the development path to the deployed proxy. */
export const DEFAULT_TRIAS_PROXY_URL = "https://karla.app.liesegang.info/api/";
export const DEV_TRIAS_PROXY_PATH = "/trias-api/";

export type KvvFeedConfig = { feed: "efa" } | { feed: "trias"; proxyUrl: string };

export type KvvFeedEnvironment = {
  DEV?: boolean;
  VITE_USE_EFA?: string;
  /** Another proxy (`/api/` with `npm run proxy`); unset or empty, the deployed one. */
  VITE_TRIAS_PROXY_URL?: string;
};

export function readKvvFeedConfig(environment: KvvFeedEnvironment): KvvFeedConfig {
  if (/^(true|1)$/i.test(environment.VITE_USE_EFA?.trim() ?? "")) return { feed: "efa" };
  return {
    feed: "trias",
    proxyUrl:
      environment.VITE_TRIAS_PROXY_URL ||
      (environment.DEV ? DEV_TRIAS_PROXY_PATH : DEFAULT_TRIAS_PROXY_URL),
  };
}
