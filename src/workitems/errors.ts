// A refusal with a stable machine-readable code (`error.details.code` over the gateway).

export class WorkItemRefused extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
