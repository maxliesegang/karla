/**
 * TRIAS read directly, without the proxy, for scripts run by hand. The requestor ref comes from
 * `TRIAS_REQUESTOR_REF`, or from `.env.local`. It is a secret: never commit it or print it.
 */
import { existsSync } from "node:fs";

export const TRIAS_ENDPOINT = "https://projekte.kvv-efa.de/liesegangtrias/trias";

export function readRequestorRef(): string {
  if (!process.env.TRIAS_REQUESTOR_REF && existsSync(".env.local"))
    process.loadEnvFile(".env.local");
  const ref = process.env.TRIAS_REQUESTOR_REF?.trim();
  if (!ref) {
    console.error("Set TRIAS_REQUESTOR_REF, e.g. in .env.local (git-ignored).");
    process.exit(1);
  }
  return ref;
}

export function envelope(requestorRef: string, payload: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Trias version="1.2" xmlns="http://www.vdv.de/trias" xmlns:siri="http://www.siri.org.uk/siri">
  <ServiceRequest>
    <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
    <siri:RequestorRef>${requestorRef}</siri:RequestorRef>
    <RequestPayload>${payload}</RequestPayload>
  </ServiceRequest>
</Trias>`;
}
