import assert from "node:assert/strict";
import { AsyncWorkScope } from "./async-work-scope.js";

async function closeCapturedScope(custom: boolean) {
  const scope = new AsyncWorkScope();
  const marker = { label: "retired cleanup caller" };
  const reference = new WeakRef(marker);
  const close = async () => {
    assert.equal(marker.label, "retired cleanup caller");
    const reason = custom ? new Error("caller cancellation") : undefined;
    if (reason) {
      const cause = new Error("underlying cancellation", { cause: reason });
      reason.cause = cause;
    }
    scope.beginClose(reason);
    if (reason) {
      assert.equal(scope.signal.reason, reason);
    }
    await scope.drain();
  };
  await close();
  return { scope, reference };
}

export async function runWorkScopeRetention(custom: boolean, collect: () => Promise<void>) {
  const { scope, reference } = await closeCapturedScope(custom);
  await collect();
  assert.equal(reference.deref(), undefined, "Closed work scope retained its cleanup caller");
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.hasPendingWork, false);
  const reason: unknown = scope.signal.reason;
  assert.ok(reason instanceof Error);
  if (custom) {
    assert.ok(reason.cause instanceof Error);
    assert.equal(reason.cause.cause, reason);
  } else {
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, "AbortError");
    assert.equal(reason.code, 20);
  }
  assert.throws(
    () => scope.signal.throwIfAborted(),
    (error) => error === reason,
  );
  await scope.drain();
  assert.equal(scope.signal.reason, reason);
}
