import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { getLineColors } from "./lib/line-sign-colors";
import { network } from "./networks/network";
import "./index.css";

const networkColors = getLineColors(network.accentColor, "#ffffff");
document.documentElement.style.setProperty("--network-accent", networkColors.signColor);
document.documentElement.style.setProperty("--network-ink", networkColors.signInk);
document.documentElement.style.setProperty("--network-accent-ink", networkColors.textTone);

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
