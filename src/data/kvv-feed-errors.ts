/** Failures that affect feed availability rather than one provider lookup. */
export class TriasUnavailableError extends Error {
  readonly accessDenied: boolean;

  constructor(message: string, options?: ErrorOptions & { accessDenied?: boolean }) {
    super(message, options);
    this.name = "TriasUnavailableError";
    this.accessDenied = options?.accessDenied ?? false;
  }
}

export class TriasRateLimitError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number) {
    super("TRIAS-Anfragelimit erreicht; erneuter Versuch später");
    this.name = "TriasRateLimitError";
    this.retryAt = retryAt;
  }
}

export class FeedChangedError extends Error {
  constructor() {
    super("Die Datenquelle wurde gewechselt; erneuter Abruf erforderlich");
    this.name = "FeedChangedError";
  }
}
