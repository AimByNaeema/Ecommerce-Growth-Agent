'use strict';

// The project's own explicit compliance policy DATA - the deterministic rules the
// Compliance stage checks content against, kept separate from the engine that applies
// them (compliance/complianceEngine.js) so the rules can be read, reviewed and extended
// without touching evaluation logic.
//
// WHAT THIS IS NOT. It is not a moderation framework, not a legal knowledge base, and
// not a platform-policy database. Every rule below is either (a) an explicit rule this
// project already states about itself, or (b) a caller/configuration-supplied rule the
// checker is merely applying. Nothing here asserts what any external platform's real
// policy is - inventing a platform rule would be exactly the fabrication CLAUDE.md rule
// 8 exists to prevent, so an unknown platform policy resolves to REVIEW, never to a
// guessed rule and never to a silent PASS.
//
// THREE OUTCOMES, AND WHAT THEY MEAN.
//   PASS   - no issue was detected by the checks that actually ran. NOT a statement
//            that no issue exists, and never a legal clearance.
//   REVIEW - something is ambiguous, unsupported, or needs human/legal/policy
//            judgment. Ownership, permission, trademark and platform questions land
//            here by design: this checker cannot establish them.
//   BLOCK  - content violates an EXPLICIT project or caller-declared policy rule.
//            Only the deterministic rule sets below can produce it.
//
// THIS SYSTEM IS NOT A LAWYER. LEGAL_LIMITATIONS below is attached to every single
// result, unconditionally - there is no code path that returns a compliance result
// without it, so no consumer can ever read a PASS as a legal guarantee.

const crypto = require('node:crypto');

// This checker's own rule-set/schema version. The project has no project-wide schema
// versioning convention (nothing else in the codebase carries one), so this is
// deliberately scoped to Compliance alone rather than introducing a global scheme:
// it exists so a stored governance record says which rule set produced it.
const COMPLIANCE_CHECKER_VERSION = 'compliance-checker/1.0.0';
const COMPLIANCE_SCHEMA_VERSION = 'compliance-result/1.0.0';

// The three outcomes. Deliberately UPPER-CASE and deliberately distinct from
// agent/core/contentBriefModel.js's lower-case ready/review/blocked content statuses -
// a compliance verdict is a different judgment about a different question, and reusing
// that vocabulary would invite the two being confused in a stored record.
const COMPLIANCE_STATUSES = ['PASS', 'REVIEW', 'BLOCK'];

// Every check this foundation supports. A result always reports one entry per check
// type, including the ones that did not run - an omitted check must never look like a
// passed one.
const CHECK_TYPES = [
  'provenance',
  'unsupported_claims',
  'reference_similarity',
  'ip_indicators',
  'platform_policy',
  'prohibited_content',
];

// 'block' and 'review' are the only severities that move the overall status; 'info'
// records something worth keeping in the governance record without gating anything.
const FINDING_SEVERITIES = ['block', 'review', 'info'];

const CHECK_STATUSES = ['passed', 'flagged', 'not_applicable', 'not_completed'];

// Checks that run on the content alone (plus whatever provenance was supplied) and are
// therefore required by default. reference_similarity, ip_indicators and
// platform_policy need caller-supplied material the current content workflow does not
// always have, so requiring them by default would turn every ordinary run into a
// REVIEW for a missing input rather than for a real concern.
const DEFAULT_REQUIRED_CHECKS = ['provenance', 'unsupported_claims', 'prohibited_content'];

// ---------------------------------------------------------------------------------
// Project policy rule set 1: assertions this project forbids its own content making.
// ---------------------------------------------------------------------------------
//
// These are not moderation categories - they are the project's own explicit rules
// turned into deterministic patterns. CLAUDE.md rule 8 forbids presenting an
// unverified claim as a fact, and this system in particular must never emit a legal
// guarantee about content it has no way to verify. Content asserting one is blocked by
// project policy - which is a statement about our rule, never a finding that the
// content is unlawful.
const PROHIBITED_ASSERTION_RULES = [
  {
    id: 'legal_guarantee_claim',
    description:
      'Content asserts a legal/compliance guarantee (e.g. "100% compliant", "guaranteed copyright-free", "no legal risk"). This project can never establish such a claim, so stating it is a project-policy violation.',
    pattern:
      /\b(?:100\s*%|fully|completely|totally)\s+(?:legal|lawful|compliant)\b|\bguarantee(?:d|s)?\s+(?:legal|lawful|compliant|copyright[\s-]?(?:free|safe)|trademark[\s-]?(?:free|safe))\b|\blegally\s+(?:safe|compliant|cleared)\b|\bno\s+legal\s+risk\b|\b(?:copyright|trademark)[\s-]?(?:free|safe)\s+guarantee(?:d)?\b/i,
    recommended_action:
      'Remove the guarantee and state only what has actually been verified, or route the claim to a human who can substantiate it.',
  },
  {
    id: 'absolute_verification_claim',
    description:
      'Content claims something is "verified", "certified" or "approved" in absolute terms without naming who verified it - the same unverified-claim-as-fact failure, applied to content instead of to analysis.',
    pattern: /\b(?:fully|independently|officially)\s+(?:verified|certified|approved|authenticated)\b/i,
    recommended_action:
      'Name the body that actually verified/certified it, or remove the claim. An unattributed verification claim cannot be checked by anyone.',
  },
];

// ---------------------------------------------------------------------------------
// Project policy rule set 2: phrasing that implies an affiliation we cannot establish.
// ---------------------------------------------------------------------------------
//
// REVIEW, never BLOCK. Any of these MAY be perfectly accurate - the business really may
// be an authorized dealer. This checker simply has no way to know, and per CLAUDE.md
// rule 1 it must not decide either way. It flags the claim for the one party who can.
const AFFILIATION_CLAIM_RULES = [
  {
    id: 'affiliation_or_endorsement_claim',
    description:
      'Content implies an affiliation, authorization, partnership or endorsement relationship with another party.',
    pattern:
      /\b(?:official(?:ly)?|authoriz(?:ed|ing)|approved)\s+(?:partner|reseller|retailer|distributor|dealer|stockist|supplier)\b|\bendorsed\s+by\b|\bin\s+partnership\s+with\b|\baffiliated\s+with\b|\bcertified\s+by\b|\bon\s+behalf\s+of\b/i,
    recommended_action:
      'A human must confirm the relationship really exists and is permitted to be stated, or the wording must be removed. This checker cannot establish it.',
  },
];

// ---------------------------------------------------------------------------------
// Platform/policy boundary - a reusable SHAPE, deliberately holding no rules.
// ---------------------------------------------------------------------------------
//
// RECOGNIZED_PLATFORMS names the contexts this project already talks about. Recognizing
// a NAME is not knowing its RULES: there is no entry here carrying a Shopify, Etsy,
// Amazon or eBay policy, because this project has never established one and inventing
// one would be worse than having none. A named platform with no structured rule set
// supplied resolves to REVIEW.
//
// Structured rules reach the checker through the caller's policy_context.platform_rules,
// shaped as:
//   { id, platform, description, forbidden_phrases: [string], severity: 'block'|'review' }
// forbidden_phrases are matched as literal, case-insensitive substrings - never
// compiled as regular expressions, so caller-supplied policy data can never inject a
// pattern into this process.
const RECOGNIZED_PLATFORMS = ['shopify', 'etsy', 'amazon', 'ebay', 'website', 'social'];

const PLATFORM_RULE_SEVERITIES = ['block', 'review'];

// ---------------------------------------------------------------------------------
// The standing legal limitation. Attached to EVERY result, unconditionally.
// ---------------------------------------------------------------------------------
const LEGAL_LIMITATIONS = [
  'This is an internal risk/policy check, not legal advice. Nothing in this result establishes legal compliance, copyright clearance, trademark clearance, or the absence of legal risk.',
  'PASS means no issue was detected by the checks that actually ran - it is not a statement that no issue exists, and it is not a clearance.',
  'Compliance neither approves nor publishes anything. A PASS result still requires explicit human approval (approvals/) before any external action, and this project has no publishing stage.',
];

// A short, stable fingerprint of a normalized phrase. Used so a similarity finding can
// identify WHICH passage matched without ever reproducing the passage itself - the
// point of the reference-similarity check is to DETECT copying, not to carry a copy
// around in the result or in a stored governance record.
function fingerprintPhrase(phrase) {
  return crypto.createHash('sha256').update(String(phrase)).digest('hex').slice(0, 16);
}

// The structured platform rules (if any) that apply to one platform id. Pure filter -
// never falls back to another platform's rules, and never invents one.
function getPlatformRulesFor(platformRules, platform) {
  if (!Array.isArray(platformRules) || typeof platform !== 'string') return [];
  const normalized = platform.trim().toLowerCase();
  return platformRules.filter(
    (rule) =>
      rule &&
      typeof rule === 'object' &&
      typeof rule.platform === 'string' &&
      rule.platform.trim().toLowerCase() === normalized
  );
}

module.exports = {
  COMPLIANCE_CHECKER_VERSION,
  COMPLIANCE_SCHEMA_VERSION,
  COMPLIANCE_STATUSES,
  CHECK_TYPES,
  CHECK_STATUSES,
  FINDING_SEVERITIES,
  DEFAULT_REQUIRED_CHECKS,
  PROHIBITED_ASSERTION_RULES,
  AFFILIATION_CLAIM_RULES,
  RECOGNIZED_PLATFORMS,
  PLATFORM_RULE_SEVERITIES,
  LEGAL_LIMITATIONS,
  fingerprintPhrase,
  getPlatformRulesFor,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - compliance policy (rule data only):\n');
  console.log(`Checker version: ${COMPLIANCE_CHECKER_VERSION}`);
  console.log(`Outcomes: ${COMPLIANCE_STATUSES.join(' | ')}`);
  console.log(`Checks: ${CHECK_TYPES.join(', ')}`);
  console.log(`Required by default: ${DEFAULT_REQUIRED_CHECKS.join(', ')}`);
  console.log('\nProject rules that can BLOCK:');
  PROHIBITED_ASSERTION_RULES.forEach((rule) => console.log(`  [${rule.id}] ${rule.description}`));
  console.log('\nProject rules that can only ever REVIEW:');
  AFFILIATION_CLAIM_RULES.forEach((rule) => console.log(`  [${rule.id}] ${rule.description}`));
  console.log(`\nRecognized platform CONTEXTS (no policy rule is asserted for any of them): ${RECOGNIZED_PLATFORMS.join(', ')}`);
  console.log('\nStanding limitations attached to every result:');
  LEGAL_LIMITATIONS.forEach((limitation) => console.log(`  - ${limitation}`));
}
