# memory/state/

Persisted agent/session state (progress, working context) between runs. The shape that
state must conform to is defined in
[`agent/core/stateModel.js`](../../agent/core/stateModel.js), and the rules for what's
worth saving (and what isn't) are defined in
[`agent/core/memoryRules.js`](../../agent/core/memoryRules.js) — no storage mechanism
(file format, database) has been chosen yet, so nothing is persisted here yet.

Once real state is persisted, it belongs to whichever business/session it was saved
for — never committed, never hardcoded into agent logic (git-ignored, mirroring
`data/business/`). Reusable agent logic (`agent/core/`, `tools/`, `workflows/`,
`prompts/`) must never read this folder directly or hardcode its contents.
