# autonomy/

The controlled autonomous cycle — the one place the existing pieces are wired into a loop
that can run without a human starting it.

```
Scheduler → Monitor → Change detection → Chief execution contract → Compliance
→ Autonomy policy → ALLOW or APPROVAL_REQUIRED → Circuit breaker → Idempotency
→ Execute → Verify → Audit → Persist → next cycle
```

## This folder adds order and refusal, nothing else

Every gate is **called**, not reimplemented:

| Question | Answered by |
|---|---|
| Business identity, platform enablement, tool authorization, budget, compliance, approval requirement, kill switch | `agent/core/autonomyPolicy.js` |
| Which jobs are due, and once only | `scheduler/` |
| What actually changed on the platform | `monitoring/` |
| Is this integration working | `reliability/circuitBreaker.js` |
| Did it actually happen, and only once | `reliability/executionVerification.js` |
| How a capability is executed | `agent/core/orchestratorExecutionContract.js` |
| What happened, for the record | `audit/auditTrail.js`, `agent/core/runHistoryStore.js` |

There is no second orchestrator, no second policy, no second budget and no second approval
mechanism here.

**Note the split:** the autonomy *policy* lives in `agent/core/autonomyPolicy.js` alongside
the other permission gates it belongs with. This folder holds the *loop* that consults it.
They are deliberately separate — the policy is useful (and tested) without a loop, and the
loop must never become a place where policy decisions get made.

## An agent cannot approve its own action

This module never constructs, signs, verifies or passes an approval object, and there is
deliberately **no parameter** through which one could be injected into a cycle. When the
policy says `APPROVAL_REQUIRED`, the cycle queues a **durable pending approval** for a human
(with the same compliance input and refusals the Chief applies) and moves on. It never
decides, signs or waits for that approval; the owner decides it through
`autonomy/approvalResolution.js`, using the existing Ed25519 verification.

`approvals/approvalArchitecture.js` remains the only thing that can verify a human decision,
and `approvals/publishAuthorization.js` remains the only thing that can authorize publishing.

A second, independent check backs this up: even if the policy returned `ALLOW` for a
consequential action, the cycle refuses to execute it. If the two ever disagree, the
disagreement is resolved against acting.

## Idempotency, at two levels

- The **scheduler** claims each occurrence exactly once, from a key derived from the
  schedule — a restart recomputes the same key and finds it already claimed.
- Every **attempt** carries a derived idempotency key that is refused once it has completed.

A restart mid-cycle cannot duplicate an executed action.

## Hard rules

| Rule | Enforced by |
|---|---|
| Compliance BLOCK → never execute | the policy; this file never overrides it |
| Kill switch OFF → no autonomous execution | the policy |
| Budget exhausted → no execution | the policy, before the consequential step |
| Circuit breaker OPEN → no execution | checked here, before execution |
| Disabled platform → no execution | the policy; the monitor never queries it either |
| Unauthorized tool → no execution | the policy |
| Missing policy data → BLOCK | the policy |
| Consequential action → APPROVAL_REQUIRED | the policy, plus the independent refusal above |

One failing job never ends a cycle: each is processed in its own try/catch, and the
underlying error message is never relayed into persisted business data.
