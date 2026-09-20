import { z } from "zod";
import {
  assertSystemCookiePlatform,
  listSystemProfiles,
  readSystemProfileCookies,
} from "./system-profiles.js";

const requestSchema = z.discriminatedUnion("action", [
  z.object({ version: z.literal(1), nonce: z.uuid(), action: z.literal("list") }).strict(),
  z
    .object({
      version: z.literal(1),
      nonce: z.uuid(),
      action: z.literal("read"),
      browser: z.enum(["chrome", "brave", "edge", "chromium"]),
      profile: z.string().max(128),
    })
    .strict(),
]);

/** Private app-child pipe protocol, not a Gateway route or a cookie-export CLI. */
export async function runMacCookieImport(
  transport: {
    input: AsyncIterable<Uint8Array>;
    write: (data: string) => Promise<void>;
    signal: AbortSignal;
  },
  producer = {
    assertPlatform: assertSystemCookiePlatform,
    list: listSystemProfiles,
    read: readSystemProfileCookies,
  },
): Promise<void> {
  let nonce: string | undefined;
  let reply: unknown;
  try {
    producer.assertPlatform();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of transport.input) {
      transport.signal.throwIfAborted();
      size += chunk.length;
      if (size > 8192) {
        throw new Error("invalid-request");
      }
      chunks.push(Buffer.from(chunk));
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // A nonce is only a reply correlator; stdin/stdout pipe ownership is the boundary.
    if (
      typeof raw === "object" &&
      raw !== null &&
      "nonce" in raw &&
      typeof raw.nonce === "string"
    ) {
      nonce = z.uuid().parse(raw.nonce);
    }
    const request = requestSchema.parse(raw);
    transport.signal.throwIfAborted();
    const profiles = producer.list().filter((profile) => profile.hasCookies);
    if (request.action === "list") {
      reply = { version: 1, nonce, ok: true, profiles };
    } else {
      if (!profiles.some((p) => p.browser === request.browser && p.id === request.profile)) {
        throw new Error("invalid-profile");
      }
      const result = await producer.read({
        browser: request.browser,
        systemProfile: request.profile,
        signal: transport.signal,
      });
      transport.signal.throwIfAborted();
      reply = {
        version: 1,
        nonce,
        ok: true,
        batch: {
          cookies: result.cookies,
          total: result.counts.total,
          skipped: result.counts.skipped,
          failed: result.counts.failed,
        },
      };
    }
    const encoded = JSON.stringify(reply);
    if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
      throw new Error("response-too-large");
    }
    await transport.write(encoded);
  } catch {
    // Never serialize a producer/Keychain/SQLite error: it can contain credentials.
    if (!transport.signal.aborted) {
      await transport.write(
        JSON.stringify({ version: 1, nonce, ok: false, error: "import-unavailable" }),
      );
    }
  }
}
