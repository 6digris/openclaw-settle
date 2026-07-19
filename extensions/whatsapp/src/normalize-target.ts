import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  normalizeLowercaseStringOrEmpty,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const NON_WHATSAPP_PROVIDER_PREFIX_RE = /^[a-z][a-z0-9-]*:/i;

function classifyWhatsAppTargetJid(value: string): WhatsAppJid {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (/^group:/i.test(candidate)) {
    const classified = classifyWhatsAppJid(candidate.replace(/^group:/i, "").trim());
    return classified.kind === "group" ? classified : { kind: "unsupported" };
  }
  return classifyWhatsAppJid(candidate);
}

export function isWhatsAppGroupJid(value: string): boolean {
  return classifyWhatsAppTargetJid(value).kind === "group";
}

export function isWhatsAppNewsletterJid(value: string): boolean {
  return classifyWhatsAppTargetJid(value).kind === "newsletter";
}

export function isWhatsAppUserTarget(value: string): boolean {
  return extractUserJidPhone(stripWhatsAppTargetPrefixes(value)) !== null;
}

function extractUserJidPhone(jid: string): string | null {
  return (
    (jid.match(WHATSAPP_USER_JID_RE) ??
      jid.match(WHATSAPP_LEGACY_USER_JID_RE) ??
      jid.match(WHATSAPP_LID_RE))?.[1] ?? null
  );
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  const classified = classifyWhatsAppTargetJid(candidate);
  if (classified.kind === "unsupported") {
    return normalizeWhatsAppDirectPhone(candidate);
  }
  const newsletterMatch = candidate.match(WHATSAPP_NEWSLETTER_JID_RE);
  if (newsletterMatch) {
    return `${newsletterMatch[1]}@newsletter`;
  }
  const phone = extractUserJidPhone(candidate);
  if (phone) {
    const normalized = normalizeE164(phone);
    return normalized.length > 1 ? normalized : null;
  }
  if (candidate.includes("@")) {
    return null;
  }
  if (NON_WHATSAPP_PROVIDER_PREFIX_RE.test(candidate)) {
    return null;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}

export function normalizeWhatsAppMessagingTarget(raw: string): string | undefined {
  return normalizeWhatsAppTarget(raw) ?? undefined;
}

export function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return uniqueStrings(
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeWhatsAppAllowFromEntry,
    }),
  );
}

export function normalizeWhatsAppAllowFromEntry(entry: string): string | null {
  if (entry === "*") {
    return entry;
  }
  const normalized = normalizeWhatsAppTarget(entry);
  if (!normalized) {
    return null;
  }
  return normalized.startsWith("+") ? normalized.slice(1) : normalized;
}

export function looksLikeWhatsAppTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  return /^whatsapp:/i.test(trimmed) || normalizeWhatsAppTarget(trimmed) !== null;
}
