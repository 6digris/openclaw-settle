import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";

function withoutProgress(task: unknown): unknown {
  if (!isRecord(task) || task.progress === undefined) {
    return task;
  }
  const { progress: _progress, ...legacy } = task;
  return legacy;
}

function withoutNestedProgress(value: unknown): unknown {
  if (!isRecord(value) || !value.task) {
    return value;
  }
  const task = withoutProgress(value.task);
  return task === value.task ? value : { ...value, task };
}

function mapChanged(values: unknown, project: (value: unknown) => unknown): unknown {
  if (!Array.isArray(values)) {
    return values;
  }
  const source: readonly unknown[] = values;
  let changed: unknown[] | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    const projected = project(value);
    if (projected !== value) {
      changed ??= source.slice();
      changed[index] = projected;
    }
  }
  return changed ?? values;
}

/** Present owned task outputs only at the socket boundary; internal readers stay rich. */
export function presentTaskPayload(
  surface: string,
  payload: unknown,
  caps: string[] | undefined,
): unknown {
  if (hasGatewayClientCap(caps, GATEWAY_CLIENT_CAPS.TASK_PROGRESS) || !isRecord(payload)) {
    return payload;
  }
  // Only task envelopes are projected; similarly named application fields stay intact.
  switch (surface) {
    case "tasks.list": {
      const tasks = mapChanged(payload.tasks, withoutProgress);
      return tasks === payload.tasks ? payload : { ...payload, tasks };
    }
    case "tasks.get":
    case "tasks.cancel":
      return withoutNestedProgress(payload);
    case "tasks.retry":
    case "tasks.dismiss": {
      const results = mapChanged(payload.results, withoutNestedProgress);
      return results === payload.results ? payload : { ...payload, results };
    }
    case "tasks.history": {
      if (payload.activity === undefined) {
        return payload;
      }
      const { activity: _activity, ...legacy } = payload;
      return legacy;
    }
    case "task": {
      return payload.action === "upserted" ? withoutNestedProgress(payload) : payload;
    }
    default:
      return payload;
  }
}
