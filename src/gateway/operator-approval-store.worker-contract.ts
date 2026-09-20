import type {
  GetOperatorApprovalInput,
  GetOperatorApprovalResult,
  ListTerminalOperatorApprovalsInput,
  ListTerminalOperatorApprovalsResult,
} from "./operator-approval-store.types.js";

export type OperatorApprovalWorkerOperations = {
  "operatorApproval.getDetailed": {
    input: GetOperatorApprovalInput;
    output: GetOperatorApprovalResult;
  };
  "operatorApproval.history": {
    input: ListTerminalOperatorApprovalsInput;
    output: { ok: true; history: ListTerminalOperatorApprovalsResult } | { ok: false };
  };
};
