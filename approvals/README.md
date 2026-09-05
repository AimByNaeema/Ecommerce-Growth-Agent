# approvals/

Human-in-the-loop approval requests and records for actions the agent proposes but
should not take unilaterally.

[`approvalArchitecture.js`](approvalArchitecture.js) classifies future actions into 4
classes — analysis-only, recommendation, approval-required, externally executable —
and defines the policy governing them: external or potentially consequential actions
(approval-required, externally executable) require explicit approval before they
proceed, unless a later, explicitly-scoped configuration setting permits otherwise;
and the agent must never silently perform a consequential external action. It also
exposes `AUTO_APPROVED_CLASSIFICATIONS` and `requiresApproval(classificationId)` -
the single source of truth for which classifications may proceed automatically, reused
(never redefined) by `agent/core/toolPermissions.js`.

[`approvalRequestModel.js`](approvalRequestModel.js) is the schema for one Approval
Request record: `id`, `classification`, `specialist_id`, `tool_id`,
`execution_request` (the exact request to re-run once approved), `reason`, `status`
(`pending`/`approved`/`rejected`), `requested_at`, `decided_at`, `decided_by`, and
`decision_notes`.

[`approvalWorkflow.js`](approvalWorkflow.js) is the operational lifecycle on top of
that schema: `createApprovalRequest(...)` produces one new `pending` record;
`decideApprovalRequest(requests, id, { decision, decidedBy, notes })` is the only
function that can move a request to `approved`/`rejected` - it requires a non-empty
`decidedBy` (real accountability, never a silent decision) and refuses to re-decide an
already-decided request. Like every other engine in this project (see
`agent/core/experimentLearningStore.js`), this module holds no hidden state - it is
pure functions over a caller-held array of request records, since
`agent/core/memory/` has no persistence engine implemented yet.

**How this connects to the Chief:** `agent/core/orchestratorExecutionContract.js`'s
`executeSelectedCapability()` is the single dispatch point every tool call goes
through. When `agent/core/toolPermissions.js`'s `checkToolAccess()` reports
`approval_required`, `executeSelectedCapability()` calls `createApprovalRequest()` and
appends the new record to a per-run tracker (returned to the caller as the final
response's `pending_approvals`) - it never executes the action itself.
`resumeApprovedExecution(decidedApprovalRequest, runTokenTracker)` is the only path in
the codebase that can execute a previously gated action, and it only runs the real tool
executor once a real, accountable `decideApprovalRequest(..., { decision: 'approved' })`
call has produced that record - a `pending` or `rejected` request is honestly refused
instead.

[`complianceApprovalGate.js`](complianceApprovalGate.js) is the boundary between
`compliance/` and this folder - the `Content -> Compliance -> Human Approval` flow, and
nothing beyond it. `requestApprovalForCheckedContent(...)` runs the REAL compliance
evaluation itself (it takes the compliance *input*, never a compliance *status*, so a
caller has no way to hand one in) and then: a `BLOCK` creates no request at all, so it
cannot enter the approval flow and there is nothing for a human to decide; a `PASS` or
`REVIEW` creates an ordinary `pending` record through `createApprovalRequest()` above,
carrying the verdict and its review reasons in `execution_request` so the approver sees
exactly what was unresolved. `decideComplianceGatedApproval(...)` re-runs compliance from
the record's own content *before* any decision is recorded and refuses a record whose
claimed verdict, or whose review reasons, no longer match - then delegates the decision
itself to `decideApprovalRequest()`, which remains the only function that can move a
request out of `pending`. Re-verification is exact and free because
`compliance/complianceEngine.js` is deterministic and offline, so it can run on every
decision. `isAuthorizedForPublishing(record)` is the single gate a future publishing step
must call: it requires an `approved` status, a real `decided_by`, and a passing
re-verification, all checked at the moment of asking.

This adds no second state machine, no new schema, and no storage - it is pure functions
over the same caller-held array, and nothing in `approvals/` or `compliance/` was
modified to accommodate it. A human approval is **not** a compliance PASS: the two
verdicts are stored separately and neither overwrites the other, so a `REVIEW` that a
human approves stays a `REVIEW`. An approval authorizes a **future** publishing step -
this project has no publishing stage, and nothing here calls an external system.

This is a real, operational engine: no external service is connected yet (no tool is
both implemented and approval-required in today's registry), so `externally_executable`
actions cannot run end-to-end today - but the classification, request lifecycle, and
Chief-level wiring are all real, not placeholders.
