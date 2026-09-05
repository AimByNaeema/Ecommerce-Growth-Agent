# compliance/

The shared Compliance stage: the deterministic pre-action check that runs AFTER content
is generated and BEFORE it is ever put in front of a human approver.

```
Real Question Discovery -> Information Gap Finder -> SEO Content Generation
    -> Compliance -> Human Approval -> Publishing
```

**Compliance is not Approval.** Compliance answers *"is this content sufficiently safe
and compliant to proceed to human approval?"*. Approval answers *"has the authorized
human approved it?"* — that stays `approvals/`, which is still the only approval state
machine in this codebase. Nothing in this folder creates, decides, or reads an approval
request, and nothing here publishes: no integration import, no HTTP call, no destination
field, no schedule, no publish flag.

[`compliancePolicy.js`](compliancePolicy.js) is rule DATA only — the three outcomes
(`PASS`/`REVIEW`/`BLOCK`), the six check types, the severities, the checker/schema
version, and the two small explicit rule sets: `PROHIBITED_ASSERTION_RULES` (the only
project rules that can BLOCK — content asserting a legal/compliance guarantee this
project can never establish) and `AFFILIATION_CLAIM_RULES` (which can only ever
REVIEW). `RECOGNIZED_PLATFORMS` names the platform *contexts* this project talks about
and deliberately carries **no** platform policy for any of them: recognizing a name is
not knowing its rules, and inventing one would be exactly the fabrication CLAUDE.md rule
8 forbids. `LEGAL_LIMITATIONS` is attached to every result unconditionally.

[`complianceModel.js`](complianceModel.js) is the schema: the input contract
(`content` is the only required field, so the existing content workflow can call it
unchanged), the result contract, and the Content/Asset Governance record. The honesty
invariants live in `validateComplianceResultShape()` rather than in convention — it
mechanically refuses a `PASS` carrying a block/review finding or a review reason, a
`BLOCK` with no block-severity finding naming the rule, a block-severity finding sitting
under a softer status, a `REVIEW` with no reason, and an empty `limitations` array.
`createGovernanceRecord(result)` derives the retainable record and deliberately drops
the content itself, passing everything it keeps through `audit/auditTrail.js`'s
`redactSensitiveData()` (reused, not reimplemented) so a credential-shaped value can
never be retained.

[`complianceEngine.js`](complianceEngine.js) is the evaluation — pure, offline, and free
(no model call, no I/O, no persistence). Six deterministic checks:

| check | what it does | worst verdict |
|---|---|---|
| `provenance` | required source + supporting evidence present | REVIEW |
| `unsupported_claims` | `[VERIFY: ...]` markers and claims the supplied facts do not support | REVIEW |
| `reference_similarity` | distinctive-wording match against supplied reference material | REVIEW |
| `ip_indicators` | affiliation/endorsement wording, declared third-party brands | REVIEW |
| `platform_policy` | applies *structured caller-supplied* rules; an undetermined policy is REVIEW | BLOCK (only via an explicit configured rule) |
| `prohibited_content` | project `PROHIBITED_ASSERTION_RULES` + configured prohibited terms | BLOCK |

Three detectors are reused from `agent/core/contentBriefEngine.js` rather than
reimplemented (CLAUDE.md rules 3-4): `findVerificationMarkers`,
`findUnsupportedFactualClaims` and `findCopiedCompetitorPhrase`. The generator applies
them to its own draft as a post-check; Compliance applies them as an independent gate
over content from any producer, with the reference-material and policy dimensions the
generator has no concept of.

**Competitor/reference text never escapes.** Reference material is read only inside
`checkReferenceSimilarity()`. A finding carries a SHA-256 fingerprint, the reference
material's id, and character offsets into *our own* content — never a phrase, an
excerpt, or a competitor's wording. The content generator upstream is unchanged and
still never sees competitor text at all.

`applyAdditionalFindings()` is the only way a supplementary check can affect a result,
and it is monotonic: findings are appended, the verdict is re-derived through the single
`deriveComplianceStatus()` rule, and a `block` severity is **refused outright**. So an
extra pass can escalate `PASS -> REVIEW -> BLOCK` and can never clear, downgrade, or
resolve a finding, and a BLOCK can only ever come from a deterministic rule.

`isEligibleForHumanApproval(result)` reports that a `BLOCK` may not proceed to an
approver. It offers no way past it — this project's approval architecture has no
authorized-override mechanism, and inventing one is not in scope.
`summarizeComplianceForApproval(result)` returns plain data an existing approval request
can carry alongside it, with **no** change to `approvals/approvalRequestModel.js`'s
schema or `approvals/approvalWorkflow.js`'s lifecycle.

`complianceInputFromContentGenerationResult()` is the minimum integration with content
generation: a pure projection of an `agent/core/contentBriefModel.js` result.
`contentBriefModel.js`, `contentBriefEngine.js` and `tools/seoContentGenerationTool.js`
are **not modified** — their evidence/provenance guarantees carry through exactly as
produced.

**How this connects to the Chief:** [`tools/complianceCheckTool.js`](../tools/complianceCheckTool.js)
registers `compliance_check` in `tools/toolRegistry.js` under the new shared-infrastructure
`compliance` category. Because that category is absent from
`agent/core/toolPermissions.js`'s `CATEGORY_TO_SPECIALIST`, it is derived into
`SHARED_INFRASTRUCTURE_CATEGORIES` automatically: **no specialist owns it**, exactly like
`approvals/` and `audit/`, so no specialist can reach it as a side channel. It is a
`'read'` operation classified `analysis_only`, so no role ceiling was widened and no
permission was weakened to add it. Dispatch goes through
`agent/core/orchestratorExecutionContract.js`'s `TOOL_EXECUTORS` like every other tool —
gated by `checkToolAccess()`, counted by `agent/core/usageLimits.js`, recorded by
`audit/auditTrail.js`.

The tool is deterministic and costs zero tokens by default. Its opt-in AI-assisted
ambiguity pass (`aiAssistedAmbiguityCheck: true`) goes through
`tools/aiReasoningCompletion.js`, so `AI_PROVIDER` selection, `agent/core/tokenControls.js`'s
per-call ceiling and per-run budget, and the usage-ledger token split all apply
unchanged — neither provider is named anywhere in the file. It is never shown reference
material or credentials, and if it is requested but fails, the result escalates to
REVIEW saying so rather than reporting a check that did not run as one that passed.

**This is not legal advice.** No result ever states that content is legally compliant,
copyright-safe, trademark-safe, or free of legal risk. The vocabulary is deliberately:
*no issue detected by current checks* / *review required* / *blocked by project policy*.

Like every other engine in this project (see `approvals/approvalWorkflow.js`,
`audit/auditTrail.js`, `agent/core/experimentLearningStore.js`), this module holds no
hidden state and no persistence layer — a governance record lives only for as long as
its caller holds it.
