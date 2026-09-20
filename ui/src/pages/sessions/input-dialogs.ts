import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveSessionRenamePatch, resolveSessionRenameValue } from "../../lib/session-rename.ts";

/** Type-only, so the dialog itself stays behind its lazy boundary. */
type InputDialogOpener = (typeof import("../../components/input-dialog.ts"))["showInputDialog"];

/** Each page owns one dialog lifetime; disconnect closes whichever dialog is open. */
export class SessionPageInputDialogs {
  private lifecycle: AbortController | null = null;

  constructor(private readonly onError: (message: string) => void) {}

  close() {
    this.lifecycle?.abort();
  }

  async newCategory(submit: (name: string) => Promise<string | null>): Promise<void> {
    await this.withLifecycle(async (signal) => {
      const showInputDialog = await this.load();
      await showInputDialog?.({
        signal,
        title: t("sessionsView.newGroupTitle"),
        label: t("sessionsView.newGroupPrompt"),
        submitLabel: t("sessionsView.newGroupCreate"),
        requireValue: true,
        submit,
      });
    });
  }

  async rename(
    row: Parameters<typeof resolveSessionRenameValue>[0],
    requestSignal: AbortSignal,
  ): Promise<ReturnType<typeof resolveSessionRenamePatch>> {
    const initialValue = resolveSessionRenameValue(row);
    const value = await this.withLifecycle(async (signal) => {
      const showInputDialog = await this.load();
      return (
        (await showInputDialog?.({
          signal: AbortSignal.any([signal, requestSignal]),
          title: t("sessionsView.renameSessionPrompt"),
          defaultValue: initialValue,
        })) ?? null
      );
    });
    return value === null ? null : resolveSessionRenamePatch(value, initialValue, row.label);
  }

  private async withLifecycle<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // A second open while one is live must not take ownership. showInputDialog
    // drops the reentrant request anyway, and if it installed its own controller
    // it would clear this field on the way out, leaving the dialog that is
    // actually on screen with nothing for disconnect to abort.
    const active = this.lifecycle;
    if (active) {
      return run(active.signal);
    }
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    try {
      return await run(lifecycle.signal);
    } finally {
      if (this.lifecycle === lifecycle) {
        this.lifecycle = null;
      }
    }
  }

  /** A dialog that never opens still owes the operator a visible outcome. */
  private async load(): Promise<InputDialogOpener | null> {
    try {
      return (await import("../../components/input-dialog.ts")).showInputDialog;
    } catch (error) {
      this.onError(formatUiError(error));
      return null;
    }
  }
}
