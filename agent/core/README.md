# agent/core/

The agent's central definition: identity, objectives, and the logic that ties every
capability module together into one coherent agent.

[`agentContract.js`](agentContract.js) defines the ONE agent's conceptual lifecycle — the
ordered stages every objective passes through (understand objective, inspect
configuration, retrieve context, inspect memory/state, identify required work, select
tools, execute work, verify results, handle confirmed errors, save state, respond). It's
a structural contract only: no stage performs real work yet — no tool execution, no AI
API calls, no autonomous looping. Run `node agent/core/agentContract.js` to print it.

[`contextBoundaries.js`](contextBoundaries.js) defines where each kind of context the
agent might need lives (task, business, product, research, memory, tool), so a future
retrieval step can pull only the relevant slice instead of everything. Run
`node agent/core/contextBoundaries.js` to print it.

[`stateModel.js`](stateModel.js) defines the compact shape of one task's state (current
objective, task status, relevant configuration, selected research, findings, decisions,
pending/completed/failed work, verification status, approvals) — a schema and an
empty-state helper only, never entire conversations, no database. Instances of this
shape are meant to be persisted under `memory/state/` once persistence is implemented.
Run `node agent/core/stateModel.js` to print it.

[`memoryRules.js`](memoryRules.js) defines what memory must be (relevant, compact,
structured, retrievable, safe), what to prioritize saving (reusable findings, important
decisions, business configuration, research summaries, completed tasks, useful
historical context), and what must never be saved by default (temporary noise, full
conversations). Rules only — no save/prune engine. Run `node agent/core/memoryRules.js`
to print it.

[`researchRecordModel.js`](researchRecordModel.js) defines the shape of one reusable
research record (topic, market, date, source/evidence, finding, confidence, relevance,
summary, verification status), so existing research can be recognized and reused instead
of repeated. Schema only — no lookup/search/duplicate-detection (no research engine).
Run `node agent/core/researchRecordModel.js` to print it.
