/**
 * The error vocabulary the store throws.
 *
 * Each carries a machine-readable `code` because three different callers render these failures:
 * a tool result, an HTTP response, and a CLI exit. A single `Error` with a message would make all
 * three parse prose. `policy.ts` returns failures rather than throwing; these are thrown for the
 * failures that are *not* a policy decision the caller can retry differently.
 */
import type { PolicyCode, PolicyFailure } from './policy.js';

export type StoreErrorCode =
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'locked'
  | 'closed'
  | 'read-only';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** No such task, sprint, view or template. */
export class NotFoundError extends StoreError {
  constructor(what: string, id: string) {
    super('not-found', `${what} ${JSON.stringify(id)} does not exist`);
    this.name = 'NotFoundError';
  }
}

/**
 * Optimistic-concurrency failure: the caller wrote against a stale `rev`.
 *
 * Carries the row as it stands now, so a UI can rebase instead of guessing, and a tool can say
 * exactly what changed under it.
 */
export class ConflictError<T> extends StoreError {
  readonly current: T;

  constructor(what: string, id: string, current: T) {
    super('conflict', `${what} ${JSON.stringify(id)} changed since it was read (rev conflict)`);
    this.name = 'ConflictError';
    this.current = current;
  }
}

/** A value the schema or an invariant rejects — the caller sent something impossible. */
export class InvalidError extends StoreError {
  constructor(message: string) {
    super('invalid', message);
    this.name = 'InvalidError';
  }
}

/**
 * A policy decision said no.
 *
 * Kept separate from `StoreError` because it is not a bug or a race: it is the board working. Three
 * callers render it three ways — a tool result, a `422` with the missing checklist, and a CLI exit
 * code — and all three need the *code* rather than a sentence to parse.
 */
export class PolicyViolation extends Error {
  readonly policyCode: PolicyCode;
  readonly missing: readonly string[];

  constructor(failure: PolicyFailure) {
    super(failure.message);
    this.name = 'PolicyViolation';
    this.policyCode = failure.code;
    this.missing = failure.missing ?? [];
  }
}
