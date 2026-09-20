import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";

// Serialized into the page alongside the other fixture owners. Pass runtime
// dependencies explicitly so toString() never captures a module import.
export function createControlUiSessionGroupFixtures(
  scenario: Required<Pick<ControlUiMockGatewayScenario, "sessionGroups" | "sessionGroupDefaults">>,
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  // Gateway-owned custom group catalog (sessions.groups.*). Persisted in
  // sessionStorage so a page reload keeps the catalog the way the real
  // gateway's SQLite store does; renames replay onto static sessions.list
  // fixtures because the real gateway rewrites member categories server-side.
  const groupsStateKey = "openclaw.control-ui-e2e.sessionGroups";
  let groupsState: {
    names: string[];
    defaults: Record<string, { cwd?: string; worktree?: boolean }>;
    sectionOrder: string[];
    renames: Array<{ from: string; to: string | null }>;
  } = {
    names: [...scenario.sessionGroups],
    defaults: { ...scenario.sessionGroupDefaults },
    sectionOrder: [],
    renames: [],
  };
  try {
    const rawGroups = window.sessionStorage.getItem(groupsStateKey);
    if (rawGroups) {
      groupsState = JSON.parse(rawGroups) as typeof groupsState;
      groupsState.sectionOrder ??= [];
      groupsState.defaults ??= {};
    }
  } catch {
    // Storage-disabled browser contexts still get the scenario catalog.
  }

  function persistGroupsState(): void {
    try {
      window.sessionStorage.setItem(groupsStateKey, JSON.stringify(groupsState));
    } catch {
      // In-memory catalog still serves the current page.
    }
  }

  function groupsPayload(): {
    groups: Array<{ name: string; position: number }>;
    sectionOrder: string[];
  } {
    return {
      groups: groupsState.names.map((name, position) => ({ name, position })),
      sectionOrder: [...groupsState.sectionOrder],
    };
  }

  function groupDefaultsPayload() {
    return {
      defaults: groupsState.names.map((name) => ({ name, ...groupsState.defaults[name] })),
    };
  }

  function normalizedGroupNames(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const seen = new Set<string>();
    const names: string[] = [];
    for (const raw of value) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }

  function response(method: string, params: unknown): unknown {
    switch (method) {
      case "sessions.groups.list":
        return groupsPayload();
      case "sessions.groups.defaults":
        return groupDefaultsPayload();
      case "sessions.groups.put": {
        groupsState.names = normalizedGroupNames(isRecord(params) ? params.names : undefined);
        if (isRecord(params) && Array.isArray(params.sectionOrder)) {
          groupsState.sectionOrder = normalizedGroupNames(params.sectionOrder);
        }
        persistGroupsState();
        return { ok: true, ...groupsPayload() };
      }
      case "sessions.groups.rename": {
        const from = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        const to = isRecord(params) && typeof params.to === "string" ? params.to.trim() : "";
        if (from && to && from !== to) {
          const sourceIndex = groupsState.names.indexOf(from);
          const names = groupsState.names.filter((name) => name !== from);
          if (!names.includes(to)) {
            // Renames keep the source position, like the real catalog.
            names.splice(sourceIndex < 0 ? names.length : sourceIndex, 0, to);
          }
          groupsState.names = names;
          if (!groupsState.defaults[to] && groupsState.defaults[from]) {
            groupsState.defaults[to] = groupsState.defaults[from];
          }
          delete groupsState.defaults[from];
          const sourceSectionId = `category:${from}`;
          const targetSectionId = `category:${to}`;
          groupsState.sectionOrder = groupsState.sectionOrder.flatMap((sectionId) => {
            if (sectionId !== sourceSectionId) {
              return [sectionId];
            }
            return groupsState.sectionOrder.includes(targetSectionId) ? [] : [targetSectionId];
          });
          groupsState.renames.push({ from, to });
          persistGroupsState();
        }
        return { ok: true, updatedSessions: 0, ...groupsPayload() };
      }
      case "sessions.groups.update": {
        const name = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        if (name) {
          const cwd = isRecord(params) && typeof params.cwd === "string" ? params.cwd.trim() : "";
          groupsState.defaults[name] = {
            ...(cwd ? { cwd } : {}),
            worktree: isRecord(params) && params.worktree === true,
          };
          persistGroupsState();
        }
        return { ok: true, ...groupDefaultsPayload() };
      }
      case "sessions.groups.delete": {
        const name = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        if (name) {
          groupsState.names = groupsState.names.filter((existing) => existing !== name);
          delete groupsState.defaults[name];
          groupsState.sectionOrder = groupsState.sectionOrder.filter(
            (sectionId) => sectionId !== `category:${name}`,
          );
          groupsState.renames.push({ from: name, to: null });
          persistGroupsState();
        }
        return { ok: true, updatedSessions: 0, ...groupsPayload() };
      }
    }
    return undefined;
  }

  return { renames: () => groupsState.renames, response };
}
