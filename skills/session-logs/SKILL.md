---
name: session-logs
description: "Find earlier conversations with sessions_search, sessions_history, and sessions_list."
metadata: { "openclaw": { "emoji": "📜" } }
---

# session-logs

Use this skill when a user refers to an earlier conversation or asks what was said
before. Session history belongs to the Gateway; use the session tools even when
your workspace runs on another machine.

## Find a conversation

| Need                                              | Tool               | Example arguments                                              |
| ------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| Find a phrase in past user or assistant messages  | `sessions_search`  | `{"query":"deployment decision","limit":10}`                   |
| Find a session by title or other session metadata | `sessions_list`    | `{"search":"deployment","includeLastMessage":true,"limit":10}` |
| List archived sessions                            | `sessions_list`    | `{"archived":true,"limit":10}`                                 |
| Read a known session                              | `sessions_history` | `{"sessionKey":"<key>","limit":20}`                            |

1. Search with a distinctive phrase. Add `sessionKey` to `sessions_search` when
   you already know which conversation to search. Its maximum `limit` is 25.
2. Read surrounding context with `sessions_history`. For a search hit, pass its
   `sessionKey`, `messageId`, and `sessionId` when present to locate the matching
   transcript. Do not combine `messageId` with `offset`.
3. If history returns `hasMore` and `nextOffset`, use that offset for the next
   page. Use `includeTools: true` only when tool activity is relevant.
4. Summarize what the retrieved messages establish. Preserve uncertainty when
   context is missing. Use the returned session-link rule if one is provided.

If search returns `indexing: true`, results may be incomplete; retry shortly.
A missing hit alone does not establish that the conversation never happened.

## Limits

- These tools return only history allowed by the current session-access policy.
  Search includes visible active and archived sessions, and excludes incognito
  sessions. Deleted transcripts may no longer be available.
- History is sanitized and size-limited. Check truncation and redaction flags;
  do not claim to have read a complete transcript when they are set.
- This workflow supports conversation recall, not exact cost accounting or a
  complete audit of every tool call.
- If a session tool is unavailable or denies access, explain the limitation.
  Do not look for Gateway transcript files in the workspace or bypass the
  session-access policy with shell commands.
