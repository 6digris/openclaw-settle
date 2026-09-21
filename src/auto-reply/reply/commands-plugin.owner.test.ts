import { expect, it } from "vitest";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import {
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import { loadDeviceBootstrapTokenRecords } from "../../infra/device-pairing-store.js";
import { registerPluginCommandInRegistry } from "../../plugins/command-registration.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { handlePluginCommand } from "./commands-plugin.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

it.each(["issue", "clear"] as const)(
  "keeps the admitted plugin owner through %s bootstrap persistence",
  async (operation) => {
    await withAdminIngress(async ({ cfg, admins, context, state }) => {
      const registry = createEmptyPluginRegistry();
      const admin = admins[0]!;
      let entered = createDeferredCore();
      let resume = createDeferredCore();
      let revoke: (() => void) | undefined;
      let retainedAssertion: (() => void) | undefined;
      registerPluginCommandInRegistry(registry, "bootstrap-fixture", {
        name: "bootstrap-fixture",
        description: "Exercise a scoped plugin command's real credential mutation",
        requiredScopes: ["operator.pairing"],
        handler: async (ctx) => {
          retainedAssertion = ctx.assertOwnerCurrent;
          entered.resolve();
          await resume.promise;
          const pending =
            operation === "issue"
              ? issueDeviceBootstrapToken({
                  baseDir: state.stateDir,
                  assertCurrent: ctx.assertOwnerCurrent,
                  profile: {
                    roles: ["operator"],
                    scopes: ["operator.admin"],
                    purpose: "mobile-full",
                  },
                })
              : clearDeviceBootstrapTokens({
                  baseDir: state.stateDir,
                  assertCurrent: ctx.assertOwnerCurrent,
                });
          // The credential owner must revalidate after its lock/state awaits.
          revoke?.();
          await pending;
          return { text: "credential mutation accepted" };
        },
      });
      registerPluginCommandInRegistry(registry, "bootstrap-fixture", {
        name: "owner-independent-read",
        description: "An ordinary authorized plugin read",
        handler: () => ({ text: "ordinary read accepted" }),
      });

      await withPluginRuntimeRegistryScope(registry, async () => {
        for (const change of ["none", "demote", "reassign"] as const) {
          entered = createDeferredCore();
          resume = createDeferredCore();
          unlinkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
          linkUserChannelIdentity(admin.profile.id, admin.identity);
          setUserProfileRole(admin.profile.id, "admin");
          await clearDeviceBootstrapTokens({ baseDir: state.stateDir });
          if (operation === "clear") {
            await issueDeviceBootstrapToken({ baseDir: state.stateDir });
          }
          const before = loadDeviceBootstrapTokenRecords(state.stateDir);
          const params = buildCommandTestParams(
            "/bootstrap-fixture",
            cfg,
            await context(admin.identity.senderId),
            { workspaceDir: state.workspaceDir },
          );
          expect(params.command.senderIsOwner).toBe(true);
          const originalAssertion = params.command.assertOwnerCurrent;
          revoke =
            change === "none"
              ? undefined
              : () => {
                  if (change === "demote") {
                    setUserProfileRole(admin.profile.id, "member");
                  } else {
                    unlinkUserChannelIdentity(admin.profile.id, admin.identity);
                    linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
                  }
                };
          const pending = handlePluginCommand(params, true);
          try {
            expect(
              await Promise.race([
                entered.promise.then(() => "entered"),
                pending.then(() => "finished"),
              ]),
            ).toBe("entered");
            // Replacing the snapshot cannot replace its already-captured capability.
            params.command.assertOwnerCurrent = () => {};
            resume.resolve();
            const outcome = await pending;
            const after = loadDeviceBootstrapTokenRecords(state.stateDir);
            if (change === "none") {
              expect(outcome?.reply?.text).toBe("credential mutation accepted");
              expect(Object.keys(after).length).toBe(operation === "issue" ? 1 : 0);
            } else {
              expect(Object.keys(after).length).toBe(Object.keys(before).length);
              expect(outcome?.reply?.text).toContain("Command failed");
            }
            expect(retainedAssertion).toBeTypeOf("function");
            expect(() => retainedAssertion?.()).toThrow("invocation closed");
            params.command.commandBodyNormalized = "/owner-independent-read";
            params.command.senderIsOwner = false;
            params.command.assertOwnerCurrent = originalAssertion;
            expect((await handlePluginCommand(params, true))?.reply?.text).toBe(
              "ordinary read accepted",
            );
          } finally {
            resume.resolve();
            await pending;
          }
        }
      });
    });
  },
);
