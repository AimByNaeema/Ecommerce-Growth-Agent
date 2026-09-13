# monitoring/

The observation layer: capture what a platform's state looks like now, persist it, and
report what changed since the last time — deterministically, and without inventing meaning.

This folder **observes only**. Nothing in it executes an action, approves anything,
publishes anything, writes to a platform, spends a budget, schedules work, or loops. A
change reported here is information; it is not a trigger.

## Modules

| File | Concern |
|---|---|
| `snapshotModel.js` | The snapshot schema, normalization, and the state fingerprint. Pure — no I/O. |
| `snapshotStore.js` | Persistence: one JSON file per snapshot, atomic writes, business-isolated directories, corrupt-fails-closed. |
| `changeDetection.js` | Deterministic comparison of two snapshots into added / removed / changed / unchanged. Pure. |
| `platformMonitor.js` | The capture pass: enablement gate, adapter resolution, reads, snapshot, diff, save. |

The model/store/engine split matches the convention already used by
`agent/core/memoryRecordModel.js` + `agent/core/memoryStore.js` and by
`approvals/approvalRequestModel.js` + `approvals/approvalStore.js`.

## What this layer may and may not say

It reports **facts**: a product was added or removed, a product became unavailable, an
inventory total changed, an order or customer count changed, a collection's product count
changed, the configured shop identity changed.

It does **not** say why something happened, whether a change is good, bad, important,
expected or profitable, what it implies about revenue, or what customers will do about it.
Those are claims requiring evidence this layer neither has nor gathers, and CLAUDE.md rule 8
forbids presenting an unverified claim as a fact. A consumer that wants meaning must bring
its own evidence.

## Storage

```
memory/state/snapshots/<businessKey>/<platform>/<snapshotId>.json
```

`<businessKey>` is the business id, or the reserved `_default` for the single-business
deployment (an underscore-leading name `configuration/businessRegistry.js`'s
`BUSINESS_ID_PATTERN` can never produce, so it cannot collide with a real id). Real business
data — git-ignored, never committed.

## Platform access

Adapters are resolved through `integrations/adapters/adapterRegistry.js`. No module here
imports a concrete Shopify or Etsy client. A platform absent from the business's own
`enabled_platforms` is **not queried at all** — the enablement gate runs before the adapter
is resolved. Amazon and eBay have no adapter in this repository and are refused; nothing
here fakes support for them.
