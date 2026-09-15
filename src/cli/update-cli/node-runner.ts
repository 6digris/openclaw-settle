// Published updaters resolve this binding after package replacement; keep its imports bootstrap-only.
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Prefer the current Node executable, falling back to `node` when run through another shim. */
export function resolveNodeRunner(): string {
  const base = normalizeLowercaseStringOrEmpty(path.basename(process.execPath));
  if (base === "node" || base === "node.exe") {
    return process.execPath;
  }
  return "node";
}
