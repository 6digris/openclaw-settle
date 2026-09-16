import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
export async function readDirectoryEntries(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === "string" &&
      ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code)
    ) {
      return [];
    }
    throw error;
  }
}

export function isSafeLegacySessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed.length > 0 && trimmed.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(trimmed)
  );
}
