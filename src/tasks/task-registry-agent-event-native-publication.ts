import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { clearTaskActivity } from "./task-registry-activity.js";
import { recoverTaskAgentEventPublication } from "./task-registry-agent-event-commit.js";
import {
  matchesTaskAgentEventTarget,
  type TaskAgentEventInput,
  type TaskAgentEventPublication,
} from "./task-registry-agent-event.operation.js";
import { captureTaskPersistenceReceipt, isEquivalentTaskRecord } from "./task-registry-records.js";
import type { TaskRegistryPublicationHandoff } from "./task-registry-worker-publication.js";
import {
  isTerminalTaskStatus,
  type TaskPersistenceReceipt,
  type TaskRecord,
} from "./task-registry.types.js";

/** Transaction-local publication handoff retained by the original accepted event. */
export function createTaskAgentEventNativePublication(params: {
  input: TaskAgentEventInput;
  admission: OpenClawStateDatabaseReadAdmission;
  claim: TaskRegistryPublicationHandoff | undefined;
  assertCurrent: (expected: TaskPersistenceReceipt) => void;
  current: () => TaskRecord | undefined;
  deliver: (publication: TaskAgentEventPublication) => void;
}) {
  let joinedCommit: unknown;
  let predecessor: TaskRecord | undefined;
  let successor: TaskRecord | undefined;
  let published = false;
  let deliveryDone = false;
  let publicationDepth = 0;
  return {
    get published() {
      return published;
    },
    join(facts: unknown) {
      joinedCommit = facts;
    },
    capture(current: TaskRecord | undefined) {
      if (
        joinedCommit !== undefined &&
        params.claim?.unchanged() &&
        recoverTaskAgentEventPublication(joinedCommit, params.input, current)
      ) {
        // Capture before the native write, while the existing recovery witness
        // still proves no intervening committed write (including ABA).
        predecessor = current;
      }
    },
    preparePublication(
      previous: TaskRecord,
      next: TaskRecord,
    ): ((succeeded: boolean) => void) | undefined {
      if (
        !predecessor ||
        previous === next ||
        deliveryDone ||
        (successor ? successor !== previous : predecessor !== previous) ||
        (successor && isEquivalentTaskRecord(next, predecessor))
      ) {
        return undefined;
      }
      const expectedTask = captureTaskPersistenceReceipt(predecessor);
      if (!matchesTaskAgentEventTarget(next, { ...params.input, expectedTask })) {
        return undefined;
      }
      try {
        params.assertCurrent(expectedTask);
      } catch {
        return undefined;
      }
      const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
        params.admission.databasePath,
      );
      const previousSuccessor = successor;
      const advance = {
        stage() {
          successor = next;
        },
        commit() {},
        rollback() {
          successor = previousSuccessor;
        },
      };
      if (!database || !stageSqliteTransactionState(database.db, advance)) {
        advance.stage();
      }
      // Link edges before reentrant observers, but transfer only after the whole
      // synchronous publication stack has finished its flow and observer work.
      publicationDepth += 1;
      return (succeeded) => {
        publicationDepth -= 1;
        if (!succeeded) {
          successor = undefined;
          return;
        }
        if (publicationDepth !== 0 || published || !successor || params.current() !== successor) {
          return;
        }
        try {
          params.assertCurrent(expectedTask);
        } catch {
          return;
        }
        if (isTerminalTaskStatus(successor.status)) {
          clearTaskActivity(successor.taskId);
        }
        let rollbackClaim: (() => void) | undefined;
        const handoff = {
          stage() {
            rollbackClaim = params.claim?.transfer();
            published = true;
          },
          commit() {},
          rollback() {
            published = false;
            rollbackClaim?.();
          },
        };
        if (!database || !stageSqliteTransactionState(database.db, handoff)) {
          handoff.stage();
        }
        const publication = recoverTaskAgentEventPublication(
          joinedCommit,
          params.input,
          predecessor,
        );
        if (!publication) {
          return;
        }
        const deliver = () => {
          const current = successor;
          if (
            !published ||
            !current ||
            params.current() !== current ||
            current.status !== publication.task.status
          ) {
            return;
          }
          try {
            params.assertCurrent(expectedTask);
          } catch {
            return;
          }
          deliveryDone = true;
          params.deliver({ ...publication, task: current });
        };
        // Generic native writes do not deliver agent events. Keep that obligation
        // with this handoff, follow exact successors, and never revive ABA delivery.
        if (!database || !deferSqlitePostCommitPublication(database.db, deliver)) {
          deliver();
        }
      };
    },
  };
}
