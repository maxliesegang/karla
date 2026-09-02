/** The whole screen while the network is still being read: nothing can be addressed without it. */
export function AppLoadingScreen() {
  return (
    <main className="loading" aria-live="polite">
      <span className="loading-mark" aria-hidden="true">
        <img src="./favicon.png" alt="" />
        KARLA
      </span>
      <span>
        <strong>KARLA wird geladen</strong>
      </span>
    </main>
  );
}
