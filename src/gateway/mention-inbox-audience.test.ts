import { createHash } from "node:crypto";
import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import * as stateReadOnly from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { MentionAudienceIdentity } from "./mention-inbox-audience-schema.js";
import {
  applyMentionAudienceCleanup,
  prepareMentionAudienceCleanup,
  readMentionAudience,
  retainMentionAudience,
} from "./mention-inbox-audience-store.js";
import { MENTION_RETENTION_MS } from "./mention-inbox-store.js";
import {
  SESSION_ID,
  SESSION_KEY,
  withMentionInbox,
  readMentionInbox,
} from "./mention-inbox.test-support.js";

it("keeps optional Inbox storage failures from aborting Gateway construction", async () => {
  await withMentionInbox(async (f) => {
    const read = vi
      .spyOn(stateReadOnly, "withExistingOpenClawStateDatabaseReadOnly")
      .mockImplementation(() => {
        throw new Error("isolated Inbox storage unavailable");
      });
    try {
      const reopened = f.openInbox();
      expect(reopened.list(f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      read.mockRestore();
      expect(readMentionInbox(reopened, f.bobClient).items).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });
});

it("keeps admitted audiences private across restart, retry, consumption and dismissal", async () => {
  await withMentionInbox(async (f) => {
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "everyone-source",
      senderProfileId: f.alice.id,
      requestFingerprint: createHash("sha256").update("@everyone").digest("hex"),
    };
    const assertCurrent = vi.fn();
    f.inbox.retainEveryoneAudience(f.aliceClient, identity, {
      recipients: [f.bob.id, f.carol.id],
      recovered: false,
      assertCurrent,
    });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);
    const { db } = openOpenClawStateDatabase();
    const original = readMentionAudience(db, identity);
    expect(original?.recipients).toEqual([f.bob.id, f.carol.id]);
    const late = ensureProfileForEmail("late-private-audience@example.test");
    f.inbox.dispose();
    const reopened = f.openInbox();
    reopened.retainEveryoneAudience(f.aliceClient, identity, {
      recipients: [late.id],
      recovered: true,
      assertCurrent,
    });
    expect(readMentionAudience(db, identity)).toEqual(original);
    f.post(
      identity.sourceId,
      { recipientProfileIds: [f.bob.id], everyoneAudience: { identity, retained: true } },
      reopened,
    );
    expect(readMentionAudience(db, identity)).toBeUndefined();
    expect(readMentionInbox(reopened, f.bobClient).items).toHaveLength(1);
    expect(readMentionInbox(reopened, f.carolClient).items).toHaveLength(1);
    expect(f.push).toHaveBeenCalledTimes(2);
    const id = readMentionInbox(reopened, f.bobClient).items[0]!.id;
    reopened.dismiss(f.bobClient, [id]);
    f.post(
      identity.sourceId,
      { recipientProfileIds: [f.bob.id], everyoneAudience: { identity, retained: true } },
      reopened,
    );
    expect(readMentionInbox(reopened, f.bobClient).items).toEqual([]);
    expect(f.push).toHaveBeenCalledTimes(2);
  });
});

it("refuses conflicting source identity, stale authority, session replacement and oversized custody", async () => {
  await withMentionInbox(async (f) => {
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "identity-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    const options = { recipients: [f.bob.id], recovered: false, assertCurrent: () => {} };
    f.inbox.retainEveryoneAudience(f.aliceClient, identity, options);
    expect(() =>
      f.inbox.retainEveryoneAudience(
        f.aliceClient,
        { ...identity, requestFingerprint: "b".repeat(64) },
        options,
      ),
    ).toThrow("conflicts");
    expect(() =>
      f.inbox.retainEveryoneAudience(
        f.bobClient,
        { ...identity, senderProfileId: f.bob.id },
        options,
      ),
    ).toThrow("conflicts");
    expect(() =>
      f.inbox.retainEveryoneAudience(
        f.aliceClient,
        { ...identity, sourceId: "revoked" },
        {
          ...options,
          assertCurrent: () => {
            throw new Error("revoked");
          },
        },
      ),
    ).toThrow("revoked");
    expect(() =>
      f.inbox.retainEveryoneAudience(
        f.aliceClient,
        { ...identity, sourceId: "oversized" },
        { ...options, recipients: Array.from({ length: 1001 }, (_, i) => "person-" + i) },
      ),
    ).toThrow();
    await f.setSession({ sessionId: "replacement" });
    expect(() => f.inbox.retainEveryoneAudience(f.aliceClient, identity, options)).toThrow(
      "session",
    );
    f.post(identity.sourceId, {
      recipientProfileIds: [],
      everyoneAudience: { identity, retained: true },
    });
    expect(f.push).not.toHaveBeenCalled();
  });
});

it("retires redacted custody and expires abandoned custody without re-expanding recovered input", async () => {
  await withMentionInbox(async (f) => {
    vi.useFakeTimers();
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "redacted-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    const options = { recipients: [f.bob.id], recovered: false, assertCurrent: () => {} };
    f.inbox.retainEveryoneAudience(f.aliceClient, identity, options);
    f.post(identity.sourceId, {
      recipientProfileIds: [],
      everyoneAudience: { identity, retained: false },
    });
    const { db } = openOpenClawStateDatabase();
    expect(readMentionAudience(db, identity)).toBeUndefined();
    expect(f.push).not.toHaveBeenCalled();
    const abandoned = { ...identity, sourceId: "abandoned-source" };
    f.inbox.retainEveryoneAudience(f.aliceClient, abandoned, options);
    await vi.advanceTimersByTimeAsync(MENTION_RETENTION_MS);
    expect(readMentionAudience(db, abandoned)).toBeUndefined();
    expect(() =>
      f.inbox.retainEveryoneAudience(f.aliceClient, abandoned, { ...options, recovered: true }),
    ).toThrow("unavailable");
    expect(readMentionAudience(db, abandoned)).toBeUndefined();
  });
});

it("delivers every aged collected source before cleanup observes their shared consumption", async () => {
  await withMentionInbox(async (f) => {
    vi.useFakeTimers();
    const scope = { agentId: "main", sessionKey: SESSION_KEY, sessionId: SESSION_ID };
    const target = () => ({
      ...scope,
      sessionEntry: loadSessionEntry(scope),
      expectedSessionId: SESSION_ID,
    });
    const sources = [];
    const { db } = openOpenClawStateDatabase();
    const schema = () => ({
      version: db.prepare("PRAGMA user_version").get(),
      metadata: db.prepare("SELECT * FROM schema_meta").all(),
      ddl: db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),
    });
    const before = schema();
    f.push.mockImplementation((notification) => {
      expect(notification.isCurrent()).toBe(true);
    });
    for (let index = 0; index < 2; index++) {
      const identity: MentionAudienceIdentity = {
        ...scope,
        sourceId: "collected-" + index + ":user",
        senderProfileId: f.alice.id,
        requestFingerprint: String(index).repeat(64),
      };
      const source = createUserTurnTranscriptRecorder({
        input: {
          text: "@everyone",
          mentions: [{ kind: "everyone", start: 0, end: 9 }],
          idempotencyKey: identity.sourceId,
        },
        target,
        pendingInputRequestFingerprint: identity.requestFingerprint,
        preparePendingInputSourceCustody: ({ recovered }) =>
          f.inbox.retainEveryoneAudience(f.aliceClient, identity, {
            recipients: [f.bob.id],
            recovered,
            assertCurrent: () => {},
          }),
        onOriginalInputCommitted: () =>
          f.post(identity.sourceId, {
            recipientProfileIds: [],
            everyoneAudience: { identity, retained: true },
          }),
      });
      await source.stageApproved?.({ runId: "collected-" + index, assertCurrent: () => {} });
      sources.push(source);
    }
    expect(schema()).toEqual(before);
    // Advance wall time without firing the Inbox timer: this reproduces cleanup at commit.
    vi.setSystemTime(Date.now() + MENTION_RETENTION_MS + 1);
    const aggregate = createUserTurnTranscriptRecorder({
      input: {
        text: "@everyone\n@everyone",
        mentions: [{ kind: "everyone", start: 0, end: 9 }],
        idempotencyKey: "aggregate:user",
      },
      pendingInputSources: sources,
      target,
    });
    await aggregate.persistApproved();
    expect(readMentionInbox(f.inbox, f.bobClient).items).toHaveLength(2);
    expect(f.push).toHaveBeenCalledTimes(2);
    expect(schema()).toEqual(before);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});

it("fences a stale orphan cleanup plan when the exact audience is reclaimed", async () => {
  await withMentionInbox(async (f) => {
    vi.useFakeTimers();
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "reclaimed-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    const options = { recipients: [f.bob.id], recovered: false, assertCurrent: () => {} };
    f.inbox.retainEveryoneAudience(f.aliceClient, identity, options);
    vi.setSystemTime(Date.now() + MENTION_RETENTION_MS + 1);
    const plan = prepareMentionAudienceCleanup();
    expect(plan).toHaveLength(1);
    // Claim directly through the store in a current owner's transaction, between plan and apply.
    runOpenClawStateWriteTransaction(({ db }) => {
      retainMentionAudience(db, identity, [f.carol.id]);
      applyMentionAudienceCleanup(db, plan);
    });
    const { db } = openOpenClawStateDatabase();
    expect(readMentionAudience(db, identity)?.recipients).toEqual([f.bob.id]);
  });
});

it("bounds private custody and cleans expired preparations before admitting at capacity", async () => {
  await withMentionInbox(async (f) => {
    vi.useFakeTimers();
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "capacity-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    const { db } = openOpenClawStateDatabase();
    runOpenClawStateWriteTransaction(() => {
      const insert = db.prepare(
        "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,?)",
      );
      for (let index = 0; index < 10000; index++) {
        const receipt = {
          ...identity,
          sourceId: "capacity-" + index,
          createdAt: Date.now(),
          recipients: [f.bob.id],
        };
        const hash = createHash("sha256")
          .update(
            JSON.stringify([
              receipt.agentId,
              receipt.sessionKey,
              receipt.sessionId,
              receipt.sourceId,
            ]),
          )
          .digest("hex");
        insert.run("notifications.mentions.audience." + hash, JSON.stringify(receipt), Date.now());
      }
    });
    const options = { recipients: [f.bob.id], recovered: false, assertCurrent: () => {} };
    expect(() => f.inbox.retainEveryoneAudience(f.aliceClient, identity, options)).toThrow(
      "retention is full",
    );
    f.inbox.dispose();
    vi.setSystemTime(Date.now() + MENTION_RETENTION_MS + 1);
    const reopened = f.openInbox();
    reopened.retainEveryoneAudience(f.aliceClient, identity, options);
    expect(readMentionAudience(db, identity)?.recipients).toEqual([f.bob.id]);
    expect(
      Number(
        db
          .prepare(
            "SELECT count(*) AS count FROM config_machine_state WHERE state_key >= ? AND state_key < ?",
          )
          .get("notifications.mentions.audience.", "notifications.mentions.audience/")?.count,
      ),
    ).toBeLessThanOrEqual(10000);
  });
});

it("rolls receipt consumption back with rejected Inbox delivery and never publishes uncommitted push", async () => {
  await withMentionInbox(async (f) => {
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "atomic-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    f.inbox.retainEveryoneAudience(f.aliceClient, identity, {
      recipients: [f.bob.id],
      recovered: false,
      assertCurrent: () => {},
    });
    // oxlint-disable-next-line typescript/unbound-method -- apply retains the intercepted statement receiver.
    const run = StatementSync.prototype.run;
    const failure = vi.spyOn(StatementSync.prototype, "run").mockImplementation(function (
      this: StatementSync,
      ...values
    ) {
      if (
        this.sourceSQL.includes('insert into "config_machine_state"') &&
        values.some(
          (value) =>
            typeof value === "string" && value.startsWith("notifications.mentions.source."),
        )
      ) {
        throw new Error("synthetic Inbox write refusal");
      }
      return run.apply(this, values);
    });
    const post = () =>
      f.post(identity.sourceId, {
        recipientProfileIds: [],
        everyoneAudience: { identity, retained: true },
      });
    try {
      post();
    } finally {
      failure.mockRestore();
    }
    const { db } = openOpenClawStateDatabase();
    expect(readMentionAudience(db, identity)?.recipients).toEqual([f.bob.id]);
    expect(f.push).not.toHaveBeenCalled();
    post();
    expect(readMentionAudience(db, identity)).toBeUndefined();
    expect(f.push).toHaveBeenCalledOnce();
  });
});
