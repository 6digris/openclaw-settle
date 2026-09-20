import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import type { SessionsProps } from "./view.ts";

type SessionCategoryViewProps = Pick<
  SessionsProps,
  | "groupBy"
  | "groupWriteDisabledReason"
  | "knownCategories"
  | "loading"
  | "onAssignCategory"
  | "onRequestNewCategory"
>;

const NEW_GROUP_OPTION = "__new-group__";

// Drag-over highlighting toggles a class directly on the target row instead of
// re-rendering per dragover event; lit re-renders mid-drag would cancel the drag.
function setDropTargetActive(event: DragEvent, active: boolean) {
  (event.currentTarget as HTMLElement | null)?.classList.toggle(
    "session-drop-target--active",
    active,
  );
}

export function categoryDropHandlers(props: SessionCategoryViewProps, category: string | null) {
  if (props.groupBy !== "category" || props.groupWriteDisabledReason) {
    return { dragover: nothing, dragleave: nothing, drop: nothing } as const;
  }
  const carriesSessionKey = (event: DragEvent) =>
    event.dataTransfer?.types.includes(SESSION_DRAG_MIME) === true;
  return {
    dragover: (event: DragEvent) => {
      if (!carriesSessionKey(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      setDropTargetActive(event, true);
    },
    dragleave: (event: DragEvent) => setDropTargetActive(event, false),
    drop: (event: DragEvent) => {
      if (!carriesSessionKey(event)) {
        return;
      }
      event.preventDefault();
      setDropTargetActive(event, false);
      const key = event.dataTransfer?.getData(SESSION_DRAG_MIME);
      if (key) {
        props.onAssignCategory(key, category);
      }
    },
  } as const;
}

export function renderCategoryCell(row: GatewaySessionRow, props: SessionCategoryViewProps) {
  const current = normalizeOptionalString(row.category) ?? "";
  const options = [...props.knownCategories];
  if (current && !options.includes(current)) {
    options.push(current);
  }
  return html`
    <td>
      <select
        ?disabled=${props.loading || Boolean(props.groupWriteDisabledReason)}
        title=${props.groupWriteDisabledReason ?? nothing}
        aria-label=${t("sessionsView.moveToGroup")}
        class="session-group-select"
        @change=${(e: Event) => {
          if (props.groupWriteDisabledReason) {
            return;
          }
          const select = e.target as HTMLSelectElement;
          if (select.value === NEW_GROUP_OPTION) {
            // The page prompts for a name and patches; restore until the refresh lands.
            select.value = current;
            props.onRequestNewCategory(row.key);
            return;
          }
          props.onAssignCategory(row.key, select.value || null);
        }}
      >
        <option value="" ?selected=${!current}>${t("sessionsView.ungrouped")}</option>
        ${options.map(
          (name) => html`<option value=${name} ?selected=${current === name}>${name}</option>`,
        )}
        <option value=${NEW_GROUP_OPTION}>${t("sessionsView.newGroup")}</option>
      </select>
    </td>
  `;
}
