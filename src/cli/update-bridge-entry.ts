// Dedicated external-shell bootstrap. No updater graph is loaded until the
// explicitly selected artifact and original target have passed read-only admission.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  admitUpdateBridgeBinding,
  assertExternalUpdateBridgeInvocation,
  assertExternalUpdateBridgeProcess,
  releaseUpdateBridgeBinding,
  type UpdateBridgeRequest,
} from "../infra/update-bridge-binding.js";
import type { UpdateCommandOptions } from "./update-cli/shared.js";
// Dedicated external-shell bootstrap. No updater graph is loaded until the
// explicitly selected artifact and original target have passed read-only admission.

export async function runUpdateBridgeEntry(args: string[]): Promise<void> {
  assertExternalUpdateBridgeInvocation(process.env);
  assertExternalUpdateBridgeProcess();
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      "target-install": { type: "string" },
      "expected-target-identity": { type: "string" },
      "bridge-manifest": { type: "string" },
      "bridge-manifest-sha256": { type: "string" },
      channel: { type: "string" },
      tag: { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean" },
      yes: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "no-restart": { type: "boolean" },
      "accept-capabilities": { type: "boolean" },
    },
  });
  const identityFile = values["expected-target-identity"];
  const targetRoot = values["target-install"];
  const manifestPath = values["bridge-manifest"];
  const manifestSha256 = values["bridge-manifest-sha256"];
  if (!identityFile || !targetRoot || !manifestPath || !manifestSha256) {
    throw new Error(
      "Update bridge requires --target-install, --expected-target-identity, --bridge-manifest and --bridge-manifest-sha256.",
    );
  }
  if (fs.statSync(identityFile).size > 64 * 1024) {
    throw new Error("Update bridge target identity is too large.");
  }
  // SAFETY: This request view is validated by root/selector admission before command loading.
  const identity = JSON.parse(fs.readFileSync(identityFile, "utf8")) as Pick<
    UpdateBridgeRequest,
    "target" | "selectors"
  >;
  if (identity.target?.root !== targetRoot || !identity.selectors) {
    throw new Error("Update bridge target identity does not select the requested installation.");
  }
  const context = admitUpdateBridgeBinding(
    {
      target: identity.target,
      selectors: identity.selectors,
      bridgeManifestPath: manifestPath,
      bridgeManifestSha256: manifestSha256,
    },
    import.meta.url,
  );
  try {
    // Relative import is anchored to the verified executing artifact, not argv,
    // cwd, the target shim, a continuation marker, or a serialized grant.
    const { updateCommand } = await import("./update-cli/update-command.js");
    const opts: UpdateCommandOptions = {
      bridge: context,
      channel: values.channel,
      tag: values.tag,
      timeout: values.timeout,
      json: values.json,
      yes: values.yes,
      dryRun: values["dry-run"],
      restart: values["no-restart"] ? false : undefined,
      acceptCapabilities: values["accept-capabilities"],
    };
    await updateCommand(opts);
  } finally {
    releaseUpdateBridgeBinding(context);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runUpdateBridgeEntry(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
