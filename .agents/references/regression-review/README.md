# Regression review playbook

Use these checks when implementing or reviewing changes to existing behavior. They are shared repository guidance for contributor agents and automated reviewers. [Supporting incidents](evidence.md) establish their scope; detection effectiveness has not been measured.

## Select the checks

Read the change's intended behavior and its actual callers. Select by the decision that changes, even when the producer and affected caller live in different directories. Read each applicable page whole, including its valid counterexample. Multiple pages can apply.

| Changed decision                                                                  | Read                                            | Evidence needed at closeout                                                                          | Independent high-confidence causes |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------: |
| A producer, adapter, or caller changes a consumed fact or artifact                | [R1: Contract propagation](contracts.md)        | The actual consumer receives its required fact or artifact                                           |                                  8 |
| Work or identity changes owner, survives replacement, or completes asynchronously | [R2: Ownership across completion](ownership.md) | Pending work keeps a live owner; valid successors proceed and unrelated installations remain refused |                                  6 |
| A failure becomes terminal, retryable, pending, or repairable                     | [R3: Recovery progress](recovery.md)            | Stop, wait, or recovery follows the actual outcome                                                   |                                  3 |
| A deadline, scan, snapshot, probe, or shared resource assumes a workload shape    | [R4: Workload assumptions](workload.md)         | The supported workload completes or receives a justified refusal                                     |                                  4 |
| A guard, parser, or migration tightens acceptance                                 | [R5: Preserve valid inputs](acceptance.md)      | Existing valid states pass; genuinely invalid states remain refused                                  |                                  4 |

Record selected checks and the reason in the existing review. Revisit each page's Done condition at closeout. Explain an omission when the changed contract makes a check plausibly relevant. Filename matches alone do not establish coverage.

## Use the result

[Subsequent audit findings](evidence.md#subsequent-audit-findings) apply these checks to later verified cases and distinguish repair dates, release exposure, and evidence limits. They are separate from the counted support above.

For an applicable check, cite the actual path from input to outcome and the proof or remaining gap. A finding must name the changed decision and a reachable failure. A missing test alone is not proof of a defect. Keep valid behavior and refusal cases in the same review.

Read incident records when tracing a cause or resolving ambiguity. Do not load the full historical corpus for every PR. Historical dates identify evidence; current owner contracts decide applicability. For a release regression audit or a lesson update, follow [refreshing the playbook](maintenance.md).
