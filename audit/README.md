# audit/

The centralized audit trail: a real, traceable record of what the system did, by which
specialist, and under what approval - CLAUDE.md section 3's "Audit" shared
infrastructure component.

[`auditRecordModel.js`](auditRecordModel.js) is the schema for one Audit Record:
`id` (auto-composed as `${run_id}-${sequence number}`), `run_id` (correlates every
event from one run), `type` (one of `AUDIT_EVENT_TYPES` - `request`, `agent`, `tools`,
`data_access`, `recommendation`, `approval`, `execution`, `result`, `error`),
`timestamp`, `specialist_id`, `capability_id`, `tool_id`, `classification`, `status`,
`summary` (required, truncated to 300 characters), and `detail` (optional structured
payload, always redacted before storage - see below).

[`auditTrail.js`](auditTrail.js) is the operational layer on top of that schema:
`createAuditTracker(runId)` creates one empty, run-scoped tracker; `appendAuditEvent(
tracker, fields)` appends one new record to `tracker.events` (mutated in place - safe
because past events are never edited, only new ones added) and silently no-ops when
handed a falsy tracker, so every call site that doesn't pass one is unaffected.
`redactSensitiveData(value)` is applied unconditionally to every record's `detail`
field: it replaces the value of any key that looks like a credential (password, token,
secret, api key, access token, credential, authorization, private key, ssn, client
secret) with `'[REDACTED]'`, and truncates any string longer than 500 characters - the
concrete mechanism ensuring a record can never leak a secret or an unbounded payload.
Read helpers `getEventsByType`, `getEventsBySpecialist`, `getErrorEvents` are pure
filters over a tracker's `events` array.

**How this connects to the Chief:** `agent/core/orchestratorExecutionContract.js`
creates one `runAuditTracker` per `runOrchestratorContract()` call and threads it
through the same pipeline as its existing `runTokenTracker`/`runApprovalTracker`
per-run accumulators. A `request` event is recorded once the objective is understood
(or an `error` event if it wasn't); an `agent` event is recorded in `buildPlanStep()`
once a specialist/capability is routed; `tools`, `data_access`, and `execution` events
are recorded in `runExecutor()` - the single chokepoint every tool call funnels
through, reached only via `executeSelectedCapability()` or `resumeApprovedExecution()`
- immediately before the real executor runs, followed by a `result` event on success
(plus a `recommendation` event when the tool's classification is `'recommendation'`)
or an `error` event on a thrown error; `approval` events are recorded when
`executeSelectedCapability()` creates a pending request via
`approvals/approvalWorkflow.js`'s `createApprovalRequest()`, and again in
`resumeApprovedExecution()` once a real decision has been made. Every event is
surfaced in the final response as `audit_trail` - on every return path, including
clarification-required responses, so a partial trail is never silently dropped.

Like every other engine in this project (see `approvals/approvalWorkflow.js`,
`agent/core/experimentLearningStore.js`), this module holds no hidden state and no
persistence layer - `agent/core/memory/` has no persistence engine implemented yet
(CLAUDE.md rule 15), so the trail lives only for the duration of one
`runOrchestratorContract()` call, held by its caller.
