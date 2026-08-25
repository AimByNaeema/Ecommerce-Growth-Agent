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

[`productModel.js`](productModel.js) defines the shape of one product record (product
identity, category, product model, description, positioning, target customer, market,
pricing, availability, source, research status), the shape real catalog entries under
`data/products/` are meant to conform to. Schema only — no product-hunting, scraping, or
sourcing logic, and no real product data. Run `node agent/core/productModel.js` to print
it.

[`opportunityAnalysisModel.js`](opportunityAnalysisModel.js) defines the shape of one
product opportunity analysis (opportunity reference, demand, competition, customer fit,
differentiation, market relevance, commercial potential, risks, evidence quality) — the
structured, evidence-based output of evaluating a candidate. Schema only — no scoring,
ranking, or automated recommendation. Run `node agent/core/opportunityAnalysisModel.js`
to print it.

[`marketResearchModel.js`](marketResearchModel.js) defines the shape of one market
research record (country, market, category, customer segment, demand signals,
competitors, trends, opportunities, risks, evidence, research date) — a market-level
specialization of `researchRecordModel.js`. Schema only — no lookup/search logic, and
no country or market is hardcoded; real values come only from
`configuration/business.yaml` or explicit task requirements. Run
`node agent/core/marketResearchModel.js` to print it.

[`customerSegmentResearchModel.js`](customerSegmentResearchModel.js) defines the shape
of one customer segment research record (segment definition, needs, problems, buying
motivations, objections, preferences, market, evidence, confidence). Schema only — no
survey/interview/lookup logic. No customer research is invented; `confidence` (reusing
`researchRecordModel.js`'s `CONFIDENCE_LEVELS`) defaults to `unassessed`, so an
assumption is never claimed as a fact. Run
`node agent/core/customerSegmentResearchModel.js` to print it.

[`competitorResearchModel.js`](competitorResearchModel.js) defines the shape of one
competitor research record (competitor, market, product/category, positioning, pricing
evidence, strengths, weaknesses, marketing signals, SEO signals, opportunities, source,
research date). Schema only — no scraping/lookup logic, and no competitor data is
invented. Run `node agent/core/competitorResearchModel.js` to print it.

[`seoResearchModel.js`](seoResearchModel.js) defines the shape of one SEO keyword
research record (keyword, search intent, market, language, relevance, competition,
opportunity, source, research date, confidence) — reusing
`researchRecordModel.js`'s `RELEVANCE_LEVELS` and `CONFIDENCE_LEVELS` enums. Schema
only — no live keyword API is called or configured today. Run
`node agent/core/seoResearchModel.js` to print it.

[`listingOptimizationModel.js`](listingOptimizationModel.js) defines the shape of one
product/listing optimization record (product reference, product title, description,
keywords, search intent, structure, metadata, internal optimization opportunities,
conversion considerations). Schema only — every field is a suggestion; nothing here
overwrites real listing content, and no field claims an SEO performance improvement
without evidence. Run `node agent/core/listingOptimizationModel.js` to print it.

[`toolSelectionRules.js`](toolSelectionRules.js) defines the ONE agent's tool
selection rules (use only relevant tools, avoid unnecessary tool calls, reuse valid
existing information, avoid duplicate research, verify tool results, handle tool
failures, never invent tool results, stop when enough evidence exists). Rules only —
no automatic tool-selection optimization exists yet. Run
`node agent/core/toolSelectionRules.js` to print it.

[`marketingAnalysisModel.js`](marketingAnalysisModel.js) defines the shape of one
marketing analysis record (marketing channel, target segment, product, campaign,
objective, message, offer, timing, evidence, expected outcome, verification status) —
reusing `researchRecordModel.js`'s `RESEARCH_VERIFICATION_STATUSES` enum. Schema only
— no external marketing action is ever executed here. Run
`node agent/core/marketingAnalysisModel.js` to print it.

[`growthOpportunityModel.js`](growthOpportunityModel.js) defines the shape of one
growth opportunity record (opportunity type, product reference, related products,
target segment, offer, recommendation, evidence, verification status), covering
upselling, cross-selling, retention, repeat purchases, and customer re-engagement.
Schema only — every product/offer reference must be real and already configured,
never invented, and no customer-facing action is ever executed here. Run
`node agent/core/growthOpportunityModel.js` to print it.

[`analyticsModel.js`](analyticsModel.js) defines the shape of one analytics snapshot
(reporting period, sales, traffic, conversion, product performance, customer behavior,
marketing performance, SEO performance, retention, growth opportunities) — reusing
`researchRecordModel.js`'s `RESEARCH_VERIFICATION_STATUSES` enum. Schema only — no
analytics provider is assumed, and no integration exists yet. Run
`node agent/core/analyticsModel.js` to print it.

[`claudeClient.js`](claudeClient.js) is the ONE agent's connection to the Claude API
(Anthropic Messages API) — a connection layer only: it can send a message to Claude and
return the reply (`sendMessage`), and report whether `ANTHROPIC_API_KEY` is configured
(`isConfigured`). It does not decide when to call Claude, does not call/dispatch tools
(`tools/toolRegistry.js`), and is not wired into `agentContract.js`'s stages yet — that
orchestration is later, explicitly-scoped work. No SDK dependency was added (Node's
built-in `fetch` is enough); `.env` (git-ignored) is loaded automatically via Node's
built-in `process.loadEnvFile`. A missing API key, a network failure, or a non-success
API response all throw a clear error — no reply is ever invented. Run
`node agent/core/claudeClient.js` to check configuration and, if a real
`ANTHROPIC_API_KEY` is set, send one live test message.

[`orchestratorExecutionContract.js`](orchestratorExecutionContract.js)'s
`runOrchestratorContract()` now creates one `../../audit/auditTrail.js` tracker per run
(`createAuditTracker`) and threads it through routing, specialist selection, and every
tool call via `appendAuditEvent` — recording a `request` event once the objective is
understood, an `agent` event per routed specialist/capability, `tools`/`data_access`/
`execution` events immediately before the single dispatch chokepoint (`runExecutor`)
actually calls a tool, a `result` event (plus `recommendation` when the tool's
classification is `'recommendation'`) on success or an `error` event on failure, and an
`approval` event whenever `approvals/approvalWorkflow.js`'s `createApprovalRequest`
fires or a gated action is later resumed. Every field passed through `detail` is
redacted by `redactSensitiveData` first, so a secret can never leak into the trail.
The full, ordered log is returned on the final response as `audit_trail` — see
`../../audit/README.md` for the module itself.
