// The legacy argument form selects Octopool's pooled viewer instead of the publisher.
export const landingSnapshotQuery =
  'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id databaseId url nameWithOwner ref(qualifiedName:"refs/heads/main"){target{oid}} pullRequest(number:$number){id number url state headRefOid baseRefName isDraft mergeCommit{oid} autoMergeRequest{mergeMethod} isInMergeQueue isMergeQueueEnabled mergeable mergeStateStatus}}}';
