/** An activity strip along the bottom of the plan. */
export function ZentrumLoading() {
  return (
    <div className="zentrum-loading" role="status">
      <span className="visually-hidden">Linien und Fahrten werden geladen …</span>
      <span className="zentrum-loading-track" aria-hidden="true" />
    </div>
  );
}
