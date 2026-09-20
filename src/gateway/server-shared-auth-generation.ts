// Gateway shared-auth generation enforcement.
// Disconnects clients when config writes invalidate shared credentials.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import {
  invalidateGatewayPolicyClient,
  type GatewayPolicyClient,
} from "./server/ws-policy-close.js";

/** Gateway client subset relevant to shared auth generation enforcement. */
export type SharedGatewayAuthClient = GatewayPolicyClient & {
  usesSharedGatewayAuth?: boolean;
  sharedGatewaySessionGeneration?: string;
};

export type SharedGatewaySessionGenerationOwnership = {
  generation: string | undefined;
  previousGeneration: string | undefined;
  revision: number;
};

/** One Gateway owns its generation fields, revision and read-only admission capability. */
export class SharedGatewaySessionGenerationState {
  #current: string | undefined;
  #required: string | undefined | null;
  #revision = 0;
  readonly #reader: GenerationReader;

  constructor(initial: { current: string | undefined; required: string | undefined | null }) {
    this.#current = initial.current;
    this.#required = initial.required;
    this.#reader = () => (this.#required === null ? this.#current : this.#required);
    Object.defineProperty(this.#reader, generationReaderStateKey, {
      value: new GenerationReaderBinding(this.#reader, this),
    });
  }

  get current(): string | undefined {
    return this.#current;
  }

  get required(): string | undefined | null {
    return this.#required;
  }

  get requiredGeneration(): string | undefined {
    return this.#required === null ? this.#current : this.#required;
  }

  get reader(): GenerationReader {
    return this.#reader;
  }

  static fromReader(
    read: GenerationReader | undefined,
  ): SharedGatewaySessionGenerationState | undefined {
    const binding: unknown =
      read && Object.getOwnPropertyDescriptor(read, generationReaderStateKey)?.value;
    return read ? GenerationReaderBinding.read(binding, read) : undefined;
  }

  capture(): SharedGatewaySessionGenerationOwnership {
    return {
      generation: this.#current,
      previousGeneration: this.#current,
      revision: this.#revision,
    };
  }

  owns(ownership: SharedGatewaySessionGenerationOwnership): boolean {
    return this.#revision === ownership.revision;
  }

  claim(
    ownership: SharedGatewaySessionGenerationOwnership,
    generation: string | undefined,
  ): SharedGatewaySessionGenerationOwnership | null {
    if (!this.owns(ownership)) {
      return null;
    }
    const previousGeneration = this.#current;
    this.#current = generation;
    return { generation, previousGeneration, revision: ++this.#revision };
  }

  publish(next: { current: string | undefined; required: string | undefined | null }): void {
    this.#current = next.current;
    this.#required = next.required;
    this.#revision++;
  }

  replace(
    ownership: SharedGatewaySessionGenerationOwnership,
    next: { current: string | undefined; required: string | undefined | null },
  ): boolean {
    if (!this.owns(ownership)) {
      return false;
    }
    this.publish(next);
    return true;
  }

  restoreCurrent(
    ownership: SharedGatewaySessionGenerationOwnership,
    current: string | undefined,
  ): boolean {
    if (!this.owns(ownership)) {
      return false;
    }
    this.#current = current;
    this.#revision++;
    return true;
  }

  setRequired(
    ownership: SharedGatewaySessionGenerationOwnership,
    required: string | undefined | null,
  ): SharedGatewaySessionGenerationOwnership | null {
    if (!this.owns(ownership)) {
      return null;
    }
    this.#required = required;
    this.#revision++;
    return this.capture();
  }

  finalize(ownership: SharedGatewaySessionGenerationOwnership): boolean {
    if (!this.owns(ownership)) {
      return false;
    }
    this.#current = ownership.generation;
    if (
      this.#required === ownership.generation ||
      (this.#required !== null && ownership.previousGeneration !== ownership.generation)
    ) {
      this.#required = null;
    }
    this.#revision++;
    return true;
  }
}

const generationReaderStateKey = Symbol("sharedGatewaySessionGenerationReaderState");
type GenerationReader = () => string | undefined;

class GenerationReaderBinding {
  readonly #owner: GenerationReader;
  readonly #state: SharedGatewaySessionGenerationState;

  constructor(owner: GenerationReader, state: SharedGatewaySessionGenerationState) {
    this.#owner = owner;
    this.#state = state;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(
    value: unknown,
    owner: GenerationReader,
  ): SharedGatewaySessionGenerationState | undefined {
    return typeof value === "object" && value !== null && #owner in value && value.#owner === owner
      ? value.#state
      : undefined;
  }
}

/** Disconnect shared-auth clients whose generation no longer matches the expected one. */
export function disconnectStaleSharedGatewayAuthClients(params: {
  clients: Iterable<SharedGatewayAuthClient>;
  expectedGeneration: string | undefined;
}): void {
  for (const gatewayClient of params.clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    if (gatewayClient.sharedGatewaySessionGeneration === params.expectedGeneration) {
      continue;
    }
    invalidateGatewayPolicyClient(gatewayClient, {
      reason: "gateway-auth-changed",
      code: 4001,
      message: "gateway auth changed",
    });
  }
}

/** Disconnect every shared-auth client regardless of generation. */
export function disconnectAllSharedGatewayAuthClients(
  clients: Iterable<SharedGatewayAuthClient>,
): void {
  for (const gatewayClient of clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    invalidateGatewayPolicyClient(gatewayClient, {
      reason: "gateway-auth-changed",
      code: 4001,
      message: "gateway auth changed",
    });
  }
}

/** Enforce shared auth generation behavior after a config write. */
export function enforceSharedGatewaySessionGenerationForConfigWrite(params: {
  state: SharedGatewaySessionGenerationState;
  nextConfig: OpenClawConfig;
  resolveRuntimeSnapshotGeneration: () => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
}): void {
  const reloadMode = resolveGatewayReloadSettings(params.nextConfig).mode;
  const nextSharedGatewaySessionGeneration = params.resolveRuntimeSnapshotGeneration();
  if (reloadMode === "off") {
    params.state.publish({
      current: nextSharedGatewaySessionGeneration,
      required: nextSharedGatewaySessionGeneration,
    });
    disconnectStaleSharedGatewayAuthClients({
      clients: params.clients,
      expectedGeneration: nextSharedGatewaySessionGeneration,
    });
    return;
  }
  params.state.publish({
    current: nextSharedGatewaySessionGeneration,
    required: null,
  });
  disconnectStaleSharedGatewayAuthClients({
    clients: params.clients,
    expectedGeneration: nextSharedGatewaySessionGeneration,
  });
}
