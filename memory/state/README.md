# memory/state/

Persisted agent/session state (progress, working context) between runs. The shape that
state must conform to is defined in
[`agent/core/stateModel.js`](../../agent/core/stateModel.js) — no storage mechanism
(file format, database) has been chosen yet, so nothing is persisted here yet.
