import { html, nothing } from "lit";
import { renderExternalLinkLabel } from "../../../components/external-link.ts";
import { t } from "../../../i18n/index.ts";
import { EXTERNAL_LINK_TARGET, buildExternalLinkRel } from "../../../lib/external-link.ts";

export function renderQuestionExternalStep(url: string | undefined) {
  return url
    ? html`<div class="chat-question-panel__external">
        <a
          class="btn btn--sm"
          href=${url}
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
        >
          ${renderExternalLinkLabel(t("chat.questions.openLink"), url)}
        </a>
        <span class="muted">${t("chat.questions.externalStepHint")}</span>
      </div>`
    : nothing;
}
