import type { CatalogListEnumeration, CatalogListResult } from "./session-catalog-list-cache.js";
import type {
  CatalogFinalResponsePermit,
  SessionCatalogListLifetime,
} from "./session-catalog-list-lifetime.js";

export function catalogError(error: unknown): { code: string; message: string } {
  const record =
    // SAFETY: The non-null object branch reads unknown properties, narrowed before string use.
    error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const recordMessage = typeof record?.message === "string" ? record.message.trim() : "";
  const fallbackMessage = typeof error === "string" ? error.trim() : "";
  return {
    code: typeof record?.code === "string" && record.code ? record.code : "catalog_error",
    message: recordMessage || fallbackMessage || "session catalog provider failed",
  };
}

export function projectSessionCatalogFinalResult(params: {
  result: CatalogListEnumeration;
  progress: SessionCatalogListLifetime;
  response: CatalogFinalResponsePermit;
  project: (
    result: CatalogListEnumeration,
    listEntries: SessionCatalogListLifetime["listEntries"],
  ) => CatalogListResult;
}): CatalogListResult {
  const { progress, response } = params;
  const retired = response.assertResponseCurrent() === "retired";
  // Source retirement ends data delivery, but an admitted caller still needs its terminal result.
  const delivery: CatalogListEnumeration = retired
    ? {
        catalogs: params.result.catalogs.map((catalog) => ({
          ...catalog,
          hosts: [],
          error: catalog.error ?? catalogError("Session catalog listing is no longer current"),
        })),
        instances: new Map(),
      }
    : params.result;
  try {
    const projected = params.project(delivery, progress.listEntries);
    if (retired) {
      response.assertResponseCurrent();
    } else {
      response.assertCurrent();
    }
    return projected;
  } catch (error) {
    progress.failResult(error);
    throw error;
  }
}
