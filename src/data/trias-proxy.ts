/** Where the app reads TRIAS: through the proxy, which holds the requestor ref. */

/** Browser proxy addresses; Vite forwards the development path to the deployed proxy. */
export const DEFAULT_TRIAS_PROXY_URL = "https://karla.app.liesegang.info/api/";
export const DEV_TRIAS_PROXY_PATH = "/trias-api/";

export type TriasProxyEnvironment = {
  DEV?: boolean;
  /** Another proxy (`/api/` with `npm run proxy`); unset or empty, the deployed one. */
  VITE_TRIAS_PROXY_URL?: string;
};

export function readTriasProxyUrl(environment: TriasProxyEnvironment): string {
  return (
    environment.VITE_TRIAS_PROXY_URL ||
    (environment.DEV ? DEV_TRIAS_PROXY_PATH : DEFAULT_TRIAS_PROXY_URL)
  );
}
