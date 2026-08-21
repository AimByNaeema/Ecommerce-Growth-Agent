# agent/core/

The agent's central definition: identity, objectives, and the logic that ties every
capability module together into one coherent agent.

[`agentContract.js`](agentContract.js) defines the ONE agent's conceptual lifecycle — the
ordered stages every objective passes through (understand objective, inspect
configuration, retrieve context, inspect memory/state, identify required work, select
tools, execute work, verify results, handle confirmed errors, save state, respond). It's
a structural contract only: no stage performs real work yet — no tool execution, no AI
API calls, no autonomous looping. Run `node agent/core/agentContract.js` to print it.
