# CLAUDE.md — instructions for Claude Code sessions in this repo

This repo is being built through a sequence of prompts run one at a time. Follow these
rules on every prompt, not just the one currently being executed.

## Build rules

1. **One agent, always.** This project builds exactly ONE reusable Smart E-Commerce
   Growth AI Agent. Do not create multiple agents, separate agent personas, or separate
   system prompts for individual capabilities. Every capability (SEO, marketing,
   analytics, product, customer/market intelligence, etc.) is a module of the same
   agent, living under the relevant top-level folder.
2. **Configurable by design.** Store credentials, business rules, and thresholds belong
   in `configuration/`, not hardcoded into logic. The agent must be able to point at a
   different Shopify store/business later without code changes.
3. **First target: the owner's own Shopify store.** Use it as the real test case before
   generalizing further.
4. **No premature technical decisions.** Don't pick a runtime, framework, SDK, database,
   or hosting platform unless a prompt explicitly asks for that decision.
5. **Don't implement ahead of the current prompt.** Build exactly what's asked; leave
   placeholders/README purpose-statements for what's not yet scoped.
6. **Verify before continuing.** After each prompt: verify the result actually works,
   fix only confirmed issues (no speculative refactors), check git status, and create a
   commit checkpoint when the step is solid. Do not start the next prompt if the current
   one isn't genuinely complete.
7. **Preserve existing work.** Inspect the project before changing anything; never
   delete or overwrite existing user work without explicit confirmation.

## Project structure

See [README.md](README.md) for the folder map. Each folder has its own `README.md`
explaining its purpose — check it before adding files to that area.

## Technical decisions made

- **Runtime: Node.js.** Chosen when the first runnable code was needed (business
  config validator), because it fits the project's first integration target (Shopify's
  tooling/Admin API libraries are primarily JS/Node-based). No other runtime, framework,
  database, or hosting platform has been chosen — rule 4 above still applies to those.
