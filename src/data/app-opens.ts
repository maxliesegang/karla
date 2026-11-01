/** Counts one visible app start without sending an address or a visitor identifier. */
export function countAppOpen(proxyUrl: string): void {
  if (
    navigator.doNotTrack === "1" ||
    ("globalPrivacyControl" in navigator && navigator.globalPrivacyControl === true)
  ) {
    return;
  }

  const count = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", count);
    void fetch(`${proxyUrl.replace(/\/$/, "")}/app-open.php`, {
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      keepalive: true,
    }).catch(() => {});
  };

  if (document.visibilityState === "visible") count();
  else document.addEventListener("visibilitychange", count);
}
