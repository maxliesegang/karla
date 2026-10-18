/** Browser proxy addresses; Vite forwards the development path to the deployed proxy. */
export const DEFAULT_TRIAS_PROXY_URL = "https://karla.liesegang.info/api/";
export const DEV_TRIAS_PROXY_PATH = "/trias-api/";

export function resolveTriasProxyUrl(environment: {
  DEV?: boolean;
  VITE_TRIAS_PROXY_URL?: string;
}): string {
  return (
    environment.VITE_TRIAS_PROXY_URL ??
    (environment.DEV ? DEV_TRIAS_PROXY_PATH : DEFAULT_TRIAS_PROXY_URL)
  );
}
