import type { ErrorCode } from "@critiqs/core";

/** A refusal every backend reports the same way, so the interface can explain it. */
export class CritiqsError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CritiqsError";
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new CritiqsError(code, message);
}
