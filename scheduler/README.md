# scheduler/

Controlled recurring triggers: decide *when* an existing capability should be requested
again, and hand that request to the existing policy pipeline.

This folder **creates requests, it never executes them**. No module here calls a tool, an
adapter, an executor, or an approval function. A scheduler pass ends with a decision
(`ALLOW` / `APPROVAL_REQUIRED` / `BLOCK`) and the execution request that decision is about.

## Modules

| File | Concern |
|---|---|
| `scheduleModel.js` | Job schema and the deterministic occurrence arithmetic. Pure — no I/O, no clock of its own. |
| `scheduleStore.js` | Persistence, business isolation, and the claim-once guard. |
| `scheduleRunner.js` | The pass: due → claim → execution request → autonomy policy → outcome. |

## A job cannot widen what the system can do

`task.tool_id` must be a real id from `tools/toolRegistry.js`. There is no free-form
command, no shell string, and no dynamic dispatch — a schedule is a recurring request for a
capability that already exists.

## Duplicate prevention

Occurrence keys are **derived**, not remembered: `occurrenceKeyAt(schedule, now)` computes
which occurrence "now" belongs to from the schedule alone, anchored to the Unix epoch. A
restarted process computes the same key the previous one did and finds it already claimed.
There is no in-memory "already ran" set to lose and no timer whose loss would cause a re-run.

The claim is written to disk **before** the work, never after. A crash between the two
skips that occurrence — the correct trade when jobs can reach real stores: a missed
observation costs one cycle, a duplicated consequential action cannot be undone.

## Schedules

Two kinds, both computable in a few lines of arithmetic — no cron parser, no dependency:

- `{ kind: 'interval_minutes', every: N }` — N ≥ 5
- `{ kind: 'daily_utc', at: 'HH:MM' }`

A schedule this project cannot compute is **invalid**, never approximated, and a job
carrying one is never due.

## Every gate still applies

The runner calls `agent/core/autonomyPolicy.js`'s `evaluateAutonomyPolicy` — the same
policy, not a second copy. Business identity, platform enablement, tool authorization,
per-run and daily budgets, compliance, the human-approval requirement and the global
`AGENT_AUTONOMY_ENABLED` kill switch all apply unchanged.

The runner will state only one compliance verdict on its own: `not_applicable`, and only
for `analysis_only` / `recommendation` actions, which produce no content to check. For
anything else it supplies **no** verdict, so the policy blocks with
`compliance_verdict_missing` until a real compliance evaluation is threaded in. It will not
fabricate a PASS.

The scheduler never supplies a human approval. An agent cannot approve its own action, and
a scheduled action is the agent's own action by definition.

## Storage

```
memory/state/schedules/<businessKey>/<jobId>.json
```

`<businessKey>` is the business id, or the reserved `_default`. Real business data —
git-ignored, never committed.
