import { AsyncLocalStorage } from "node:async_hooks";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { getPluginInstanceOwner, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import { resolvePluginReturnPromise } from "./plugin-return-value.js";
import { hasRetainedPluginRuntimeCloseError } from "./runtime-close-error.js";
import {
  getCanonicalGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";

type ResourceClaim = { release: () => Promise<void> };

export type LegacyPluginSdkProviderProjection = {
  retain(physical: ResourceClaim): ResourceClaim;
  project<T>(provider: T, instance: PluginInstanceHandle | undefined): T;
};

/** Owns resources borrowed by shipped SDK results that have no release method. */
export class LegacyPluginSdkResourceHost {
  private readonly work = new AsyncWorkScope();
  private readonly detachedWorkContext = new AsyncLocalStorage<AsyncWorkScope>();
  private readonly claims = new Map<object, ResourceClaim>();
  private readonly providerProjections = new WeakMap<object, LegacyPluginSdkProviderProjection>();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private closing?: Promise<void>;

  assertOpen(): void {
    if (this.closing || this.work.isClosing) {
      throw new Error("Plugin SDK resource host is closed");
    }
  }

  run<T>(run: () => T): T {
    return hostContext.run(this, run);
  }

  track<T>(run: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    return this.work.track(() => this.run(run));
  }

  /** Preserve synchronous SDK hooks while joining their asynchronous results and descendants. */
  invoke<T>(run: () => T): T {
    const detachedWork = this.detachedWorkContext.getStore();
    const work = detachedWork && !detachedWork.isClosing ? detachedWork : this.work;
    if (detachedWork === work && getAsyncWorkSignal() !== work.signal) {
      return this.invokeNestedDetached(work, run);
    }
    if (getAsyncWorkSignal() !== work.signal) {
      this.assertOpen();
    }
    return this.invokeInScope(work, run);
  }

  private invokeInScope<T>(work: AsyncWorkScope, run: () => T): T {
    return work.run(() =>
      this.run(() => {
        const result = run();
        const completion = resolvePluginReturnPromise(result);
        // SAFETY: Only promise-like results are normalized; synchronous hook values stay unchanged.
        return completion ? (work.track(() => completion) as T) : result;
      }),
    );
  }

  private invokeNestedDetached<T>(detachedWork: AsyncWorkScope, run: () => T): T {
    const parentTrack = captureAsyncWorkTracker();
    const invocationWork = new AsyncWorkScope();
    const returned = createDeferredCore();
    let admitted = false;
    // Retain both the plugin consumer and a nested cancellation scope until this
    // invocation's own tails settle. Waiting for either whole parent would cycle.
    const completion = detachedWork.track(() =>
      parentTrack(async () => {
        admitted = true;
        await returned.promise;
        await AsyncWorkScope.runWhenAllIdle(
          () => [invocationWork],
          () => invocationWork.drain(),
        );
      }),
    );
    void completion.catch((error: unknown) => {
      // A refused parent scope never invoked plugin code; its synchronous caller owns denial.
      if (admitted) {
        this.failures.push(error);
      }
    });
    if (!admitted) {
      throw new Error("Plugin SDK invocation work scope is closed");
    }
    try {
      return this.invokeInScope(invocationWork, run);
    } finally {
      returned.resolve();
    }
  }

  /** A void SDK call transfers completion and failures, but never delays synchronous admission. */
  invokeDetached(run: () => void | Promise<void>, reportError: (error: unknown) => void): void {
    this.assertOpen();
    const instance = pluginInstanceInvocation.getStore()?.instance;
    if (instance && (!instance.acceptingCalls || getPluginInstanceOwner(instance)?.revoked)) {
      throw new PluginInstanceUnavailableError(instance.pluginId);
    }
    const consumer = instance?.retainConsumer();
    const operation = createDeferredCore();
    // A per-operation work scope retains this consumer's cooperating tails without
    // waiting on unrelated host work that may itself be retiring this instance.
    const detachedWork = new AsyncWorkScope();
    const work = this.work.track(() =>
      this.run(async () => {
        try {
          await operation.promise;
        } catch (error) {
          this.reportDetachedFailure(error, reportError);
        } finally {
          try {
            await AsyncWorkScope.runWhenAllIdle(
              () => [detachedWork],
              () => detachedWork.drain(),
            );
          } finally {
            consumer?.release();
          }
        }
      }),
    );
    const completion = work.then(
      () => {
        this.pending.delete(completion);
      },
      (error: unknown) => {
        this.reportDetachedFailure(error, reportError);
        this.pending.delete(completion);
      },
    );
    // Both owners are registered before plugin code can reenter close/disposal.
    this.pending.add(completion);
    try {
      operation.resolve(
        this.detachedWorkContext.run(detachedWork, () =>
          detachedWork.run(() => this.run(() => (consumer ? consumer.run(run) : run()))),
        ),
      );
    } catch (error) {
      // The synchronous caller owns this exception; already admitted tails still
      // retain their consumer and host until the work scope becomes idle.
      operation.resolve();
      throw error;
    }
  }

  private reportDetachedFailure(error: unknown, reportError: (error: unknown) => void): void {
    this.failures.push(error);
    try {
      reportError(error);
    } catch (reporterError) {
      // Reporting cannot create an unobserved rejection or lose teardown evidence.
      this.failures.push(reporterError);
    }
  }

  adopt(source: object, claim: ResourceClaim): void {
    this.assertOpen();
    if (this.claims.has(source)) {
      this.releaseClaim(claim);
    } else {
      this.claims.set(source, claim);
    }
  }

  /** View lookup shares identity; only adopted or temporary claims own disposal. */
  getProviderProjection(
    source: object,
    create: () => LegacyPluginSdkProviderProjection,
  ): LegacyPluginSdkProviderProjection {
    this.assertOpen();
    let projection = this.providerProjections.get(source);
    if (!projection) {
      projection = create();
      this.providerProjections.set(source, projection);
    }
    return projection;
  }

  forgetProviderProjection(source: object, projection: LegacyPluginSdkProviderProjection): void {
    if (this.providerProjections.get(source) === projection) {
      this.providerProjections.delete(source);
    }
  }

  /** Projection failures still own their asynchronous release until it settles. */
  releaseClaim(claim: ResourceClaim): void {
    const operation = createDeferredCore();
    const completion = operation.promise.then(
      () => {
        this.pending.delete(completion);
      },
      (error: unknown) => {
        this.failures.push(error);
        this.pending.delete(completion);
      },
    );
    // Register before release can reenter host close through a disposer.
    this.pending.add(completion);
    try {
      // Failed projections may leave admitted tails; an idle host still releases immediately.
      operation.resolve(
        this.work.hasPendingWork
          ? AsyncWorkScope.runWhenAllIdle(
              () => [this.work],
              () => claim.release(),
            )
          : claim.release(),
      );
    } catch (error) {
      operation.reject(error);
    }
  }

  /** Fence new SDK work and join its tails before prepared resources can retire. */
  async drainWork(): Promise<void> {
    await this.work.drain();
    await this.drainPendingReleases();
    // Ordinary release errors are reported by close; failed prerequisites still own resources.
    if (this.failures.some(hasRetainedPluginRuntimeCloseError)) {
      throw new AggregateError(this.failures, "Plugin SDK resources could not all be disposed");
    }
  }

  private async drainPendingReleases(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      // A projection getter can close this host before its temporary claim is adopted.
      this.closing = Promise.resolve().then(async () => {
        await this.drainWork();
        const claims = [...this.claims.values()];
        this.claims.clear();
        for (const claim of claims) {
          this.releaseClaim(claim);
        }
        await this.drainPendingReleases();
        if (this.failures.length > 0) {
          throw new AggregateError(this.failures, "Plugin SDK resources could not all be disposed");
        }
      });
    }
    return this.closing;
  }
}

const { hostContext, gatewayHosts } = resolveGlobalSingleton(
  Symbol.for("openclaw.legacyPluginSdkResourceHosts"),
  () => ({
    hostContext: new AsyncLocalStorage<LegacyPluginSdkResourceHost>(),
    gatewayHosts: new WeakMap<object, LegacyPluginSdkResourceHost>(),
  }),
);

/** Associate exact host resolvers without calling them after their authority closes. */
export function bindLegacyPluginSdkResourceHost(
  resolver: object,
  host: LegacyPluginSdkResourceHost,
): void {
  gatewayHosts.set(resolver, host);
}

function getBoundLegacyPluginSdkResourceHost(): LegacyPluginSdkResourceHost | undefined {
  const scope = getPluginRuntimeGatewayRequestScope();
  const resolver = scope?.resolveGatewayContext ?? scope?.context?.resolveGatewayContext;
  if (resolver) {
    const owner = getCanonicalGatewayContextResolver(resolver);
    const host = owner ? gatewayHosts.get(owner) : undefined;
    if (!host) {
      throw new Error("Gateway SDK resource host is not bound");
    }
    return host;
  }
  return hostContext.getStore();
}

/** Standalone callers of the shipped bare-result SDK retain their process lifetime. */
export function getLegacyPluginSdkResourceHost(): LegacyPluginSdkResourceHost {
  return (
    getBoundLegacyPluginSdkResourceHost() ??
    resolveGlobalSingleton(
      Symbol.for("openclaw.legacyPluginSdkStandaloneResourceHost"),
      () => new LegacyPluginSdkResourceHost(),
    )
  );
}
