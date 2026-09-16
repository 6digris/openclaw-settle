import type { SandboxFsStat } from "./fs-bridge.types.js";

export function validateSandboxDirectoryLimit(maxEntries: number): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
    throw new RangeError("Sandbox directory limit must be between 1 and 10000.");
  }
}

export function parseSandboxDirectoryEntries(
  output: Buffer,
  maxEntries: number,
): Array<{ name: string; type: SandboxFsStat["type"] }> | null {
  if (output.length > 4_194_304) {
    throw new Error("Sandbox directory response exceeds its limit.");
  }
  const entries: unknown = JSON.parse(output.toString("utf8"));
  if (entries === null) {
    return null;
  }
  if (
    !Array.isArray(entries) ||
    entries.length > maxEntries ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof entry.name !== "string" ||
        !entry.name ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("\0") ||
        /[/\\]/u.test(entry.name) ||
        !["file", "directory", "other"].includes(entry.type),
    )
  ) {
    throw new Error("Invalid sandbox directory response.");
  }
  return entries;
}
