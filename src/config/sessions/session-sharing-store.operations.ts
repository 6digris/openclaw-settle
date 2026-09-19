import type {
  addSessionMemberInDatabase,
  removeSessionMemberInDatabase,
} from "./session-sharing-store.kernel.js";

export type SessionMemberWriteOutcome<T> = { value: T; changed: boolean };

export type SessionMemberWriteOperations = {
  "members.add": {
    input: { sessionKey: string; params: Parameters<typeof addSessionMemberInDatabase>[2] };
    output: SessionMemberWriteOutcome<ReturnType<typeof addSessionMemberInDatabase>>;
  };
  "members.remove": {
    input: {
      sessionKey: string;
      identityId: string;
      expected?: Parameters<typeof removeSessionMemberInDatabase>[3];
      expectedSessionId?: string;
    };
    output: SessionMemberWriteOutcome<ReturnType<typeof removeSessionMemberInDatabase>>;
  };
};
