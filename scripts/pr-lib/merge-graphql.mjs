import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { execPrGhJson } from "./github.mjs";

const queries = new Map([
  [
    "observe",
    'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id databaseId url nameWithOwner ref(qualifiedName:"refs/heads/main"){target{oid}} pullRequest(number:$number){id number url state headRefOid baseRefName isDraft mergeCommit{oid} autoMergeRequest{mergeMethod} isInMergeQueue isMergeQueueEnabled mergeable mergeStateStatus}}}',
  ],
  [
    "preview",
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid author{login __typename} isMergeQueueEnabled viewerMergeBodyText(mergeType:SQUASH) viewerMergeHeadlineText(mergeType:SQUASH)}}}",
  ],
]);

function readMergeGraphql([mode, host, repository, pr, ...extra]) {
  const query = queries.get(mode);
  const number = Number(pr);
  if (
    extra.length ||
    !query ||
    !/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(host ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    String(number) !== pr
  ) {
    throw new Error("Expected a merge observe or preview read with hostname, repository, and PR.");
  }
  const [owner, name] = repository.split("/");
  try {
    // Mergeability and squash previews belong to the publishing account. JSON
    // stdin retains the protected CLI writer route instead of a pooled viewer.
    return execPrGhJson(
      ["api", "graphql", "--hostname", host, "-H", "Cache-Control: max-age=0", "--input", "-"],
      {
        input: JSON.stringify({ query, variables: { owner, name, number } }),
        stdio: ["pipe", "pipe", "pipe"],
      },
      "plain",
    );
  } catch (error) {
    // Only the fixed read operations above can authorize the existing REST fallback.
    if (error.graphqlQuotaExhausted) {
      return { graphqlQuotaExhausted: true };
    }
    throw error;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(readMergeGraphql(process.argv.slice(2)))}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = Number.isInteger(error.status) ? error.status : 1;
  }
}
