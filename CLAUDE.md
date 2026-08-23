# CLAUDE.md — permanent project constitution for the E-Commerce Growth AI Agent

This file is the durable source of truth for how this project is built. It applies to
every prompt in every session, not just the one currently being executed. Where a
prompt's instructions conflict with this file, that conflict must be surfaced to the
user, not silently resolved either way.

## 1. Project purpose and long-term goal

Build a production-quality, reusable AI agent system that grows an e-commerce
business — research, product strategy, listing optimization, SEO, marketing, social
and advertising, and analytics/optimization, all working from one shared, configurable
foundation. The first real deployment is the owner's own Shopify store, used as the
proving ground. The long-term goal is an architecture that can point at a different
e-commerce business/store without rewriting the core system, built to a standard
suitable for a future commercial SaaS product — not a one-off script.

## 2. Approved architecture: 1 Orchestrator + 7 controlled specialist agents

The approved architecture is:

- **Chief / Orchestrator Agent** — the single entry point. It receives objectives,
  decides which specialist(s) are relevant, enforces the shared infrastructure below
  (approvals, permissions, budget) on every specialist's behalf, aggregates results,
  and is the only place cross-specialist coordination happens.
- **7 controlled specialist agents/modules**, each scoped to one domain and never
  acting outside it or bypassing the orchestrator/shared infrastructure:
  1. **Research** — market, competitor, and customer/market-intelligence research
  2. **Product** — product catalog analysis and opportunity research
  3. **SEO** — search visibility analysis and keyword research
  4. **Listing** — product listing content and optimization
  5. **Marketing** — campaign ideas, copy, and marketing strategy
  6. **Social & Advertising** — social media and paid advertising
  7. **Analytics & Optimization** — store performance, growth metrics, and
     optimization recommendations

This replaces the project's original "One agent, always" rule. Whether each specialist
is eventually implemented as a fully separate agent process/prompt, or as a tightly
scoped module invoked by the orchestrator under one runtime, is an implementation-
mechanics decision — not assumed here either way. That decision must be made
explicitly (and can differ per specialist) when that specialist is first built, per
rule 1 (no unauthorized assumptions) below. Until a specialist is actually built, its
responsibilities remain conceptual, matching how every capability in this project has
been scoped so far (schema/pipeline definitions before real logic).

No specialist agent may call an external system, spend budget, or take a consequential
action except through the shared infrastructure in section 3 — there is no side
channel around approvals, permissions, or cost controls.

## 3. Shared core infrastructure

These are cross-cutting and used by the Orchestrator and all 7 specialists — no
specialist duplicates its own copy:

- **Tools** — a single shared tool registry and (once built) dispatch mechanism; every
  specialist calls tools through it, never by reimplementing a tool's logic locally.
- **Memory** — persisted agent/session state, scoped so one business's history never
  leaks into another's.
- **Approvals** — the human-in-the-loop gate for consequential actions (see rule 7).
- **Permissions** — least-privilege access control: a specialist only gets the tools,
  data, and external-system scopes its domain actually requires.
- **Security** — secret handling and safe-by-default behavior (see rule 6).
- **Cost/token controls** — budget-aware, efficient use of models and tools (see rule 5).
- **Integrations** — per-platform adapters (e.g. Shopify, the Claude API) that any
  specialist can use, never reimplemented per specialist.
- **Audit** — a record of what actions were taken/proposed, by which specialist, and
  under what approval — so behavior is traceable after the fact.

## 4. Operating rules

1. **No unauthorized assumptions.** Never invent missing information, business facts,
   credentials, or requirements. If something is genuinely unclear, mark it
   "needs decision" and ask rather than guessing (see section 6 below).
2. **Execute only the requested scope.** Build exactly what the current prompt asks;
   leave placeholders or README purpose-statements for anything not yet scoped. Touch
   only the files that scope requires.
3. **Reuse existing code before creating new code.** Search the codebase for an
   existing function, model, workflow, or utility before writing a new one.
4. **Do not duplicate existing functionality.** If two pieces of code would do the same
   thing, consolidate or reuse instead of adding a parallel implementation.
5. **Token-efficient, budget-friendly usage.** Prefer the smallest sufficient model/tool
   call for a task; avoid redundant API calls, redundant research, and unnecessary
   re-work of already-valid results.
6. **Security-first design.** Secrets are never hardcoded or committed (`.env` is
   git-ignored). Every external credential is least-privilege. Safe defaults over
   convenient ones.
7. **Approval required for consequential external actions.** Governed by
   `approvals/approvalArchitecture.js`'s existing 4-class system
   (`analysis_only`, `recommendation`, `approval_required`, `externally_executable`) —
   `approval_required` and `externally_executable` actions always need explicit human
   sign-off before they happen; the agent must never silently perform one.
8. **Deterministic behavior where possible.** Prefer explicit logic, structured data,
   and verifiable outputs over open-ended generation; never present a hypothesis,
   guess, or unverified claim as a fact.
9. **Modular, testable, maintainable architecture.** Keep each specialist's
   responsibilities inside its own module/folder boundary; one concern per module.
10. **Tests must be added or updated for implementation changes.** No implementation
    change ships without corresponding test coverage.
11. **Do not break existing functionality.** Run the full test suite (`npm test`)
    before considering a step complete.
12. **Small, incremental implementation with verification after each step.** After each
    prompt: verify the result actually works, fix only confirmed issues (no
    speculative refactors), check git status, and create a commit checkpoint when the
    step is solid. Do not start the next prompt until the current one is genuinely
    complete.
13. **Production-quality standards.** Write code to a standard suitable for a future
    commercial SaaS product: real error handling at system boundaries, no throwaway
    hacks, no silent failure.
14. **Configurable by design.** Store credentials, business rules, and thresholds
    belong in `configuration/`, not hardcoded into logic — the system must be able to
    point at a different Shopify store/business later without code changes.
15. **No premature technical decisions.** Don't pick a new runtime, framework, SDK,
    database, or hosting platform unless a prompt explicitly asks for that decision
    (Node.js is already decided — see "Technical decisions made" below).
16. **First target: the owner's own Shopify store.** Use it as the real test case
    before generalizing further.
17. **Preserve existing work.** Inspect the project before changing anything; never
    delete or overwrite existing user work without explicit confirmation.

## 5. Change control

- Architecture and rule changes happen only via explicit user request, recorded here —
  this file is the source of truth, not any single prompt's instructions.
- A prompt whose instructions conflict with this file must have that conflict surfaced
  to the user, not silently resolved in either direction.
- Every implementation step follows rule 12 above: verify, fix only confirmed issues,
  check git status, checkpoint when solid, don't start the next step early.

## 6. When to stop and ask instead of guessing

Stop and ask the user (rather than proceeding on an assumption) when:

- Required business information, credentials, or requirements are missing or
  ambiguous.
- A prompt's instructions conflict with this file or with a decision already made.
- A capability's ownership is ambiguous across two or more specialist agents.
- An action is classified `approval_required` or `externally_executable` per
  `approvals/approvalArchitecture.js`.
- A request would delete, overwrite, force-push, or otherwise irreversibly change
  existing work without explicit confirmation.
- A request requires an unscoped technical decision (new runtime, framework, database,
  hosting platform) beyond what's already decided.

## Project structure

See [README.md](README.md) for the folder map. Each folder has its own `README.md`
explaining its purpose — check it before adding files to that area. Note:
`README.md`'s "One-agent architecture" section has not yet been updated to reflect the
architecture in section 2 above — that update is out-of-scope for this file and is
expected in a separate, explicitly-scoped prompt.

## Technical decisions made

- **Runtime: Node.js.** Chosen when the first runnable code was needed (business
  config validator), because it fits the project's first integration target (Shopify's
  tooling/Admin API libraries are primarily JS/Node-based). No other runtime,
  framework, database, or hosting platform has been chosen — rule 15 above still
  applies to those.
