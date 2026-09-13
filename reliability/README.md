# reliability/

Controls that decide whether autonomous work should *keep* happening, and whether it
actually *did* happen.

Every other gate in this system answers "is this allowed?". These two answer the questions
none of those can: **is it working?** and **did it work?**

## Modules

| File | Concern |
|---|---|
| `circuitBreaker.js` | Durable, scoped failure memory. After repeated failures, stop trying. |
| `executionVerification.js` | Re-read the platform after a consequential action and compare reality against intent. Also the idempotency guard. |

## The breaker can only ever subtract permission

A closed circuit grants nothing — it means "I have no reason to stop you". Compliance,
approval, platform enablement, budget and permission gates all still apply unchanged. There
is no path through `circuitBreaker.js` that turns a BLOCK into an ALLOW, and nothing there
can satisfy an approval.

Circuits are keyed by **business + platform + action**, so one business's broken Shopify
inventory integration never stops a different action, a different platform, or a different
business.

Thresholds are **counts and minutes, never money** — this project has no price table, so a
financial threshold would have to be invented. Defaults: 3 consecutive failures, 30-minute
cooldown, both overridable by environment.

Recovery is either an **explicit operator reset** (requires a stated actor and reason, both
recorded) or **one careful trial**: after the cooldown the circuit goes half-open and
permits exactly one attempt. A success closes it; a failure reopens it for a fresh cooldown.
It never silently reopens on a timer alone.

## Verification never fakes a pass

`verifyExecution` re-reads through the ordinary adapter path and compares. Five outcomes,
one of which is success:

| Status | Meaning |
|---|---|
| `verified` | The platform's own state matches what the action was supposed to produce. |
| `mismatch` | The read worked; reality is not what was expected (or a field that should not have changed did). |
| `not_found` | The target entity is not there after the action. |
| `unverifiable` | This platform cannot answer the question. **Not a pass.** |
| `failed` | The verification read itself did not complete. |

If a platform's adapter declares the needed read capability unsupported — as Etsy does for
four of the seven — the answer is `unverifiable`, and every caller that must decide whether
to proceed treats it as a failure. No green tick is invented for a platform that cannot be
checked.

Verification **verifies; it does not repair**. Nothing here retries, re-applies, rolls back,
or calls a write capability.

## Idempotency

Every consequential attempt carries a key derived from exactly what it intends to do
(business, platform, action, entity, expected state) — never random, never a timestamp — so
the same intended change computes the same key on a retry, after a crash, and in a different
process.

A key that has already been **verified** is refused for all time: a later mismatch never
downgrades a completed record, because that would silently reopen the duplicate guard. A key
whose attempt *failed* may be retried — retrying something that did not happen is
legitimate, and the circuit breaker is what stops that becoming a loop.

## Storage

```
memory/state/circuits/<businessKey>/<platform>__<action>.json
memory/state/verifications/<businessKey>/<idempotencyKey>.json
```

Business-scoped directories, atomic writes, credential-shaped keys refused. Real business
data — git-ignored, never committed.
