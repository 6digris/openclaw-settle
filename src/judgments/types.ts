/** Experimental typed judgment contract, version 1. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JudgmentEntry =
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JudgmentQuestion =
  | {
      readonly type: "choice";
      readonly instructions?: JudgmentEntry;
      readonly criteria: Readonly<Record<string, JudgmentEntry>>;
    }
  | {
      readonly type: "score";
      readonly instructions?: JudgmentEntry;
      readonly criteria: readonly JudgmentEntry[];
    }
  | {
      readonly type: "boolean";
      readonly instructions?: JudgmentEntry;
      readonly criteria?: {
        readonly true?: JudgmentEntry;
        readonly false?: JudgmentEntry;
      } | null;
    };

export type JudgmentBatch = {
  readonly state: JudgmentEntry;
  readonly questions: Readonly<Record<string, JudgmentQuestion>>;
};

export type JudgmentAnswer =
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      /** Provider-specific distribution metric, not correctness probability. */
      readonly confidence?: number;
    }
  | {
      readonly type: "score";
      /** Fractional expected zero-based position in the submitted rubric. */
      readonly score: number;
      /** Index-aligned probabilities; same length/order as input criteria. */
      readonly probabilities: readonly number[];
      readonly confidence?: number;
    }
  | {
      readonly type: "boolean";
      readonly probabilityTrue: number;
    };

export type JudgmentBatchResult = {
  /** Resolved vendor model identity, not a host conversational-model record. */
  readonly model: string;
  readonly answers: Readonly<Record<string, JudgmentAnswer>>;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
};

export type ProviderFailureReason =
  | "credentials-unavailable"
  | "authentication"
  | "rate-limited"
  | "transport"
  | "unsupported-input"
  | "invalid-response";

export type UnavailableReason =
  | ProviderFailureReason
  | "disabled"
  | "not-configured"
  | "retiring"
  | "overloaded"
  | "circuit-open"
  | "deadline";

export type ProviderJudgmentOutcome =
  | { readonly status: "ok"; readonly result: JudgmentBatchResult }
  | {
      readonly status: "unavailable";
      readonly reason: ProviderFailureReason;
      /** Validated and bounded by host; does not cause an automatic retry. */
      readonly retryAfterMs?: number;
    };

export type JudgmentOutcome =
  | {
      readonly status: "ok";
      readonly result: JudgmentBatchResult;
      readonly provenance: {
        readonly providerId: string;
        readonly rubricVersion: string;
        /** Host-owned opaque identity; no secret values or SecretRef IDs. */
        readonly runtimeGeneration: string;
      };
    }
  | { readonly status: "unavailable"; readonly reason: UnavailableReason };

export interface JudgmentProviderV1 {
  readonly id: string;
  readonly contractVersion: 1;
  /** Prepared local credential availability only; must not perform I/O. */
  isReady?(): boolean;
  evaluate(
    batch: JudgmentBatch,
    context: {
      /** Composed by host from caller, per-call deadline, and retirement. */
      readonly signal: AbortSignal;
      /** Deadline on the same process-local performance.now() time base. */
      readonly deadlineMonotonicMs: number;
    },
  ): Promise<ProviderJudgmentOutcome>;
}

/**
 * Supplied by the host, bound to its consumer's live authority/lifecycle.
 * Not a constructible global service or an unbound registry lookup.
 */
export interface JudgmentRuntimeV1 {
  /** Bounded, evidence-free consumer diagnostics; never authorizes an effect. */
  recordOutcome(outcome: "accepted" | "fallback" | "no-change"): Promise<void>;
  evaluate(
    batch: JudgmentBatch,
    options: {
      readonly purpose: string;
      readonly rubricVersion: string;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<JudgmentOutcome>;
}

// Caller cancellation, closed host authority, and programmer/contract errors
// reject rather than becoming an unavailable result. The host recognizes its
// own deadline/retirement abort separately while preserving caller cancellation.
