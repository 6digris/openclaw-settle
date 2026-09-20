import { lazyCompile } from "./protocol-validator.js";
import {
  TaskSummarySchema,
  TasksCancelResultSchema,
  TasksGetResultSchema,
  TasksListResultSchema,
  TasksRecoveryResultSchema,
} from "./schema/tasks.js";

export const validateTaskSummary = lazyCompile(TaskSummarySchema);
export const validateTasksListResult = lazyCompile(TasksListResultSchema);
export const validateTasksGetResult = lazyCompile(TasksGetResultSchema);
export const validateTasksCancelResult = lazyCompile(TasksCancelResultSchema);
export const validateTasksRecoveryResult = lazyCompile(TasksRecoveryResultSchema);
