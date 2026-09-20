import { AsyncLocalStorage } from "node:async_hooks";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import {
  readGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayOperatorRoleActor,
} from "./server-methods/shared-types.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

// Equal source tokens describe one authenticated connection, without retaining its socket or auth.
const operatorSources = new WeakMap<GatewayClient, object>();

/** Transfers the original operator restriction into accepted work, independently of its request. */
export function captureGatewayOperatorRunAuthority(params: {
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "getRuntimeConfig" | "resolveGatewayContext">;
  hasCurrentClientAuthority?: () => boolean;
  sourceAuthority?: Readonly<{ assertCurrent: () => void; signal?: AbortSignal }>;
}): { authority: AdmittedRunOperatorAuthority; release: () => void } | undefined {
  const inherited = params.client?.internal?.operatorRunAuthority;
  if (inherited !== undefined) {
    assertAdmittedRunOperatorAuthority(inherited);
    inherited.assertCurrent();
    return { authority: inherited, release: inherited.retain?.() ?? (() => {}) };
  }
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const client = params.client;
  if (!client || actor?.kind !== "operator") {
    return undefined;
  }
  const profileId = actor.profileId;
  let aliasRevision = readUserProfileAliasRevision();
  if (params.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway caller authority is no longer active.");
  }
  const releaseDevice = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const isSourceCurrent = readGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority);
  const resolveGatewayContext = params.context.resolveGatewayContext;
  const gatewayContext = resolveGatewayContext?.();
  const getConfig = params.context.getRuntimeConfig;
  const sourceAuthority = params.sourceAuthority;
  const scopes = Object.freeze([...(client.connect.scopes ?? [])]);
  const policyClient: GatewayClient = {
    connect: {
      minProtocol: client.connect.minProtocol,
      maxProtocol: client.connect.maxProtocol,
      client: client.connect.client,
      role: "operator",
      scopes: [...scopes],
    },
    internal: { operatorRoleActor: { kind: "operator", profileId } },
  };
  let source = operatorSources.get(client);
  if (!source) {
    source = Object.freeze({});
    operatorSources.set(client, source);
  }
  let references = 1;
  let revoked = false;
  const assertCurrent = () => {
    if (revoked || references === 0) {
      throw new Error("operator execution authority is no longer active");
    }
    try {
      if (
        isSourceCurrent?.() === false ||
        (resolveGatewayContext && (!gatewayContext || resolveGatewayContext() !== gatewayContext))
      ) {
        throw new Error("operator source authority is no longer active");
      }
      sourceAuthority?.signal?.throwIfAborted();
      sourceAuthority?.assertCurrent();
      const currentAliasRevision = readUserProfileAliasRevision();
      if (currentAliasRevision !== aliasRevision) {
        if (resolveUserProfileId(profileId) !== profileId) {
          throw new Error("operator source identity changed; start a new request");
        }
        aliasRevision = currentAliasRevision;
      }
      const error = authorizeCurrentOperatorRoleScopes(policyClient, getConfig());
      if (error) {
        throw new Error(error.message);
      }
    } catch (error) {
      revoked = true;
      throw error;
    }
  };
  const releaseHold = () => {
    let released = false;
    return () => {
      if (!released) {
        released = true;
        if (--references === 0) {
          releaseDevice?.();
        }
      }
    };
  };
  const release = releaseHold();
  try {
    assertCurrent();
    return {
      authority: createAdmittedRunOperatorAuthority({
        profileId,
        scopes,
        source,
        assertCurrent,
        signal: sourceAuthority?.signal,
        retain: () => {
          assertCurrent();
          references += 1;
          return releaseHold();
        },
      }),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

type OperatorToolGatewayAuthority = {
  authenticatedUserProfile: NonNullable<
    NonNullable<GatewayRequestOptions["client"]>["authenticatedUserProfile"]
  >;
  scopes: readonly string[];
  operatorRoleActor?: GatewayOperatorRoleActor;
  operatorRunAuthority?: AdmittedRunOperatorAuthority;
  signal: AbortSignal;
};

export const operatorToolGatewayAuthority = new AsyncLocalStorage<OperatorToolGatewayAuthority>();

/** Retains operator attribution and authority only for the awaited tool invocation. */
export async function withOperatorToolGatewayAuthority<T>(
  authority: Omit<OperatorToolGatewayAuthority, "signal">,
  run: () => Promise<T>,
): Promise<T> {
  const lifetime = new AbortController();
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
  const captured = context
    ? captureGatewayOperatorRunAuthority({
        client:
          scope?.client ??
          createSyntheticPluginRuntimeClient({
            authenticatedUserProfile: authority.authenticatedUserProfile,
            operatorRoleActor: authority.operatorRoleActor,
            scopes: [...authority.scopes],
          }),
        context,
        hasCurrentClientAuthority: scope?.hasCurrentClientAuthority,
      })
    : undefined;
  try {
    return await operatorToolGatewayAuthority.run(
      { ...authority, operatorRunAuthority: captured?.authority, signal: lifetime.signal },
      () =>
        captured && scope?.client
          ? withPluginRuntimeGatewayRequestScope(
              {
                ...scope,
                client: {
                  ...scope.client,
                  internal: { ...scope.client.internal, operatorRunAuthority: captured.authority },
                },
              },
              run,
            )
          : run(),
    );
  } finally {
    lifetime.abort(new Error("operator tool invocation authority expired"));
    captured?.release();
  }
}

/** Transfer bounded cleanup without retaining the finished operator invocation. */
export function runWithOperatorToolGatewayCleanupContext<T>(run: () => T): T {
  const authority = operatorToolGatewayAuthority.getStore();
  if (!authority) {
    return run();
  }
  authority.signal.throwIfAborted();
  const scope = getPluginRuntimeGatewayRequestScope();
  // Retain the effective actor and scopes after releasing the invocation;
  // profile attribution alone does not establish authority.
  const client = createSyntheticPluginRuntimeClient({
    authenticatedUserProfile: authority.authenticatedUserProfile,
    scopes: [...authority.scopes],
    operatorRoleActor: authority.operatorRoleActor ??
      scope?.client?.internal?.operatorRoleActor ?? {
        kind: "operator",
        profileId: authority.authenticatedUserProfile.profileId,
      },
  });
  return operatorToolGatewayAuthority.exit(() =>
    withPluginRuntimeGatewayRequestScope(
      { ...scope, client, isWebchatConnect: scope?.isWebchatConnect ?? (() => false) },
      run,
    ),
  );
}
