import type { DaemonStatus } from "./status.gather.js";

const DUPLICATE_POLLER_CONFLICT_PATTERN =
  /(?:getUpdates conflict|duplicate poller|other getUpdates request)/iu;

export function resolveForeignChannelConflictCorrelations(status: DaemonStatus) {
  const jobs = status.service.foreignLaunchdJobs;
  const rpc = status.rpc;
  if (
    !jobs?.length ||
    !rpc ||
    !("channelStatusIssues" in rpc) ||
    !Array.isArray(rpc.channelStatusIssues)
  ) {
    return [];
  }
  return rpc.channelStatusIssues
    .filter((issue) => DUPLICATE_POLLER_CONFLICT_PATTERN.test(issue.message))
    .map((issue) => ({
      channel: issue.channel,
      accountId: issue.accountId,
      message: issue.message,
      foreignJobs: jobs.map(({ label, program }) => ({ label, program })),
    }));
}
