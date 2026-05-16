// Whatsapp plugin module implements resolve outbound target behavior.
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";

type WhatsAppOutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const resolution = resolveWhatsAppTargetFacts({
    target: params.to,
    allowFrom: params.allowFrom,
  });
  if (!resolution.ok) {
    return { ok: false, error: resolution.error };
  }
  const facts = resolution.facts;
  if (facts.authorization.allowed) {
    return {
      ok: true,
      to: facts.wireDelivery.preserveJidAsAuthorizedTarget
        ? facts.wireDelivery.jid
        : facts.normalizedTarget,
    };
  }

  const normalizedTo = normalizeWhatsAppTarget(trimmed);
  if (!normalizedTo) {
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID|newsletter JID>"),
    };
  }
  if (isWhatsAppGroupJid(normalizedTo) || isWhatsAppNewsletterJid(normalizedTo)) {
    return { ok: true, to: normalizedTo };
  }

  const allowListRaw = normalizeStringEntries(params.allowFrom ?? []);
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (hasWildcard || allowList.length === 0) {
    return { ok: true, to: normalizedTo };
  }
  if (allowList.includes(normalizedTo)) {
    return { ok: true, to: normalizedTo };
  }
  return {
    ok: false,
    error: facts.authorization.error,
  };
}
