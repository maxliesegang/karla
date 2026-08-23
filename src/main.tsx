import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * The app is installable and starts offline; the departures never are (see public/sw.js).
 *
 * Registered only in a build, so a dev server is never shadowed by a cached shell, and after load,
 * so the worker's install never competes with the first board for the connection. A browser without
 * service workers — or a page opened from the file system — simply keeps the plain site.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(new URL("sw.js", document.baseURI)).catch(() => {});
  });
}
