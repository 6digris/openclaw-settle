import type { TemplateResult, nothing } from "lit";
import type { ToolsEffectiveResult } from "../../../api/types.ts";
import type { ApplicationNavigationOptions } from "../../../app/context.ts";
import type { McpServerSummary } from "../../../lib/config/mcp-servers.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";

export type ChatComposerPlusMenuView = "root" | "skills" | "connectors" | `tools:${string}`;

export type ChatComposerMenuSkill = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  baseEnabled: boolean;
  missingDeps?: boolean;
  blocked?: boolean;
};

export type ChatComposerRootToggle = {
  value: string;
  label: string;
  icon?: TemplateResult;
  checked: boolean;
  disabled: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
};

type MenuRoute = "mcp" | "plugins" | "skills";

export type ChatComposerPlusMenuProps = {
  attachments: ChatAttachmentControlsProps;
  showCapabilities: boolean;
  scopeKey: string;
  basePath: string;
  disabled: boolean;
  open: boolean;
  view: ChatComposerPlusMenuView;
  toolOverrides: SessionToolOverrides | null | undefined;
  skills: readonly ChatComposerMenuSkill[] | null;
  skillsLoading: boolean;
  skillsError: boolean;
  library?: ComposerLibraryProps;
  libraryDialog?: TemplateResult | typeof nothing;
  mcpServers: readonly McpServerSummary[];
  toolsEffectiveResult: ToolsEffectiveResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: boolean;
  toolAccessMutationBlockedReason: string | null;
  webSearchBaseEnabled: boolean;
  mutationBlockedReason: string | null;
  canAdmin: boolean;
  adminBlockedReason: string | null;
  rootToggles?: readonly ChatComposerRootToggle[];
  addServerDialog?: TemplateResult | typeof nothing;
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: ChatComposerPlusMenuView) => void;
  onLoadSkills: () => void;
  onPatchToolOverrides: (
    next: SessionToolOverrides | null,
  ) => void | Promise<{ ok: true; warning?: string } | { ok: false; error: string }>;
  onNavigate: (routeId: MenuRoute, options?: ApplicationNavigationOptions) => void;
  onAddServer?: () => void;
  onOpenToolAccess?: (serverName: string) => void;
};

export type ChatComposerCapabilityMenuProps = Omit<
  ChatComposerPlusMenuProps,
  | "attachments"
  | "disabled"
  | "open"
  | "view"
  | "toolOverrides"
  | "onOpenChange"
  | "onViewChange"
  | "showCapabilities"
  | "rootToggles"
>;
