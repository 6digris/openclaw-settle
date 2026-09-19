import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { nodeRuntimeFailure, SQLITE_CAPABILITY_PROBE } from "../../node-sqlite.mjs";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { runExec } from "../process/exec.js";

export type NodeRuntimeExec = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

const NODE_RUNTIME_PROBE_TIMEOUT_MS = 5_000;

const execNodeRuntime: NodeRuntimeExec = async (file, args, options) =>
  await runExec(file, [...args], { logOutput: false, timeoutMs: options.timeoutMs });

const NODE_RUNTIME_PROBE = String.raw`
const sqliteCapabilities = ${SQLITE_CAPABILITY_PROBE};
const variables = (process.config && process.config.variables) || {};
const nodeSharedSqlite = variables.node_shared_sqlite === true || variables.node_shared_sqlite === "true";
process.stdout.write(JSON.stringify({ nodeVersion: process.versions.node, sqliteVersion: sqliteCapabilities.version, sqliteCapabilities, nodeSharedSqlite }));
`;

type NodeRuntimeInfo = {
  nodeVersion: string | null;
  sqliteVersion: string | null;
  nodeSharedSqlite: boolean;
  supported: boolean;
};

/** Probes one Node executable against the runtime and SQLite safety contract. */
export async function resolveNodeRuntimeInfo(
  nodePath: string,
  execFileImpl: NodeRuntimeExec = execNodeRuntime,
): Promise<NodeRuntimeInfo> {
  try {
    const { stdout } = await execFileImpl(nodePath, ["-e", NODE_RUNTIME_PROBE], {
      encoding: "utf8",
      timeoutMs: NODE_RUNTIME_PROBE_TIMEOUT_MS,
    });
    const parsed = asOptionalRecord(JSON.parse(stdout));
    const nodeVersion = typeof parsed?.nodeVersion === "string" ? parsed.nodeVersion : null;
    const sqliteVersion = typeof parsed?.sqliteVersion === "string" ? parsed.sqliteVersion : null;
    const nodeSharedSqlite =
      parsed?.nodeSharedSqlite === true || parsed?.nodeSharedSqlite === "true";
    const capabilities = asOptionalRecord(parsed?.sqliteCapabilities);
    return {
      nodeVersion,
      sqliteVersion,
      nodeSharedSqlite,
      supported:
        isSupportedOpenClawNodeVersion(nodeVersion) &&
        nodeRuntimeFailure(nodeVersion, {
          available: capabilities?.available === true,
          version: sqliteVersion,
          text: capabilities?.text === true,
          blob: capabilities?.blob === true,
          json: capabilities?.json === true,
          error: typeof capabilities?.error === "string" ? capabilities.error : undefined,
        }) === null,
    };
  } catch {
    return { nodeVersion: null, sqliteVersion: null, nodeSharedSqlite: false, supported: false };
  }
}
