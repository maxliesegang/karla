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
 * The shell is installable and starts offline; departures never come from cache (public/sw.js).
 * Registered only in builds, after load, so dev servers are not shadowed and the first board wins.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(new URL("sw.js", document.baseURI)).catch(() => {});
  });
}
