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

## Starting a cycle

A cycle only runs when something calls it — nothing in this project schedules itself, and no
hosting or external scheduler has been chosen.

- `npm run autonomy:cycle` (`autonomy/runCycleCli.js`) or `POST /autonomy/cycle`, both through
  `autonomy/cycleTrigger.js`.
- The trigger refuses before claiming anything when storage is not durable (it refuses whenever
  `VERCEL` is set: a serverless filesystem cannot hold claims, approvals or verification
  records), when the `AGENT_AUTONOMY_ENABLED` kill switch is not on, or when the business's own
  `autonomy.enabled` is not `true`.
- Turning either switch on grants nothing else: every job still passes every policy gate.

## Schedules

Created only by the owner (`POST /autonomy/schedules`, `scheduler/scheduleManagement.js`) and
**always saved disabled**; enabling is a separate call that re-checks the business. A schedule is
refused at creation when its capability is not implemented, its platform is not enabled for the
business, the capability is not permitted for its specialist, or an observation capability does
not observe the schedule's platform (`observation_platform_mismatch`). No schedule, interval or
follow-up is ever invented.

## Approvals the cycle queues, and how the owner decides them

1. **Queued with an expiry.** Every approval the cycle queues expires `autonomy.approval_ttl_hours`
   after the cycle that queued it. There is no default: a business that enables autonomy without
   stating one is refused by the policy (`approval_ttl_not_configured`) and nothing is queued. This
   is separate from the minutes-long signing-challenge window (`APPROVAL_CHALLENGE_TTL_MS`).
2. **Never queued pointlessly.** An identical action already pending is not queued again
   (`approval_already_pending`), and an entity change that has already been applied and verified is
   not queued at all (`already_completed`).
3. **The owner signs.** `GET /approval-challenge?approvalId=…&decision=approved&decidedBy=…&business_id=…`
   returns the exact payload; the owner signs it with the Ed25519 private key held off this server
   and submits the nonce and signature to `POST /autonomy/approvals/decide`
   (`autonomy/approvalResolution.js`).
4. **Refused before anything is written** when the approval is not found for exactly this business,
   is no longer pending, has expired (`approval_expired` — an expired approval is also omitted from
   the pending list and gets no challenge), has already completed, targets an integration whose
   circuit is open, or carries a signature that does not verify.

## Immediately before a consequential write

`integrations/approvedCorrectionDispatch.js`, on every path that can execute a correction
(this resolver and `/orchestrate/approve` alike):

- loads the approval from durable storage only, never from its caller;
- checks the record belongs to this business and this action;
- **re-verifies the stored proof** with `approvals/approvalArchitecture.js`'s
  `verifyRecordedProvenance`: the execution fingerprint is recomputed from the stored request, the
  signed payload is rebuilt, and the stored signature is verified again under the configured
  `APPROVAL_PUBLIC_KEY`, bound to the business, the tool and the platform. A stored
  `method: 'ed25519_signature'` is never trusted on its own; with no public key configured nothing
  executes;
- refuses an entity change that is already applied and verified;
- claims the approval once (an expired approval cannot be claimed);
- lets the integration re-check compliance and publish authorization before it writes.

## Verification after a write

A correction is recorded as `verified` only when **both** independent reads agree: the
integration's own re-read, and the shared `reliability/executionVerification.js` `verifyExecution`
read of the entity. Every other outcome is recorded as exactly what it was, in the shared
verification store, and only a verified outcome is remembered.

| Correction | Entity verified | Expected state |
|---|---|---|
| `shopify_vendor_correction` | the product | its `vendor` |
| `shopify_collection_membership_update` | the product (the collection read carries no membership) | membership of that collection |
| `shopify_inventory_correction` | the inventory item, at the corrected location | `changeFromQuantity + delta` — only when `changeFromQuantity` was stated; otherwise `unverifiable` (`baseline_unknown`), never an invented baseline |

A verified entity change is permanent in that store: the same change is refused through any later
approval, while a different intended value for the same entity is a different change.

## What the owner can see

`GET /autonomy/state` and the dashboard's Autonomy page (read-only — nothing on it enables,
schedules, triggers or decides anything): the kill switch, the business's autonomy setting,
storage durability, enabled platforms, schedules, pending approvals with their expiry, recent
autonomous runs, and the latest cycle step by step (job, outcome, reason code, verification). A
cycle's recorded status is `success`, `partial` or `error` from what its steps actually did.

## Platform boundary

| Platform | What autonomy can do |
|---|---|
| Shopify | observe; queue the three corrections above for owner approval |
| Etsy | observe only — there is no Etsy write capability |
| Amazon, eBay | nothing — context only, no integration exists |
