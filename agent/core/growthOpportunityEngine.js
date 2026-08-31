'use strict';

// The Growth Opportunity Engine. Looks across all nine growth surfaces named in its
// prompt - products, pricing, listings, seo, marketing, social, advertising,
// conversion, retention - and ranks a caller-supplied list of opportunity candidates
// by evidence and business impact. Never invents an opportunity, a reason, a piece of
// evidence, an impact estimate, or a required action: every one of those is either a
// direct relay of a real caller-supplied value, or (rank_score only) a plain
// arithmetic computation over caller-supplied impact magnitude and honesty-graded
// confidence - the same deterministic, evidence-only philosophy as
// agent/core/offerRecommendationEngine.js and
// agent/core/productOpportunityScoringEngine.js.
//
// Reachable through the dispatcher via exactly one path: Marketing's
// marketing_opportunity_ranking capability (agent/core/marketingAgent.js's
// analyzeMarketingOpportunities(), dispatched by tools/marketingAnalysisTool.js under
// the existing marketing_analysis tool id) pins every candidate's category to
// 'marketing' and calls rankGrowthOpportunities() directly with caller-supplied
// candidates - no new tool id, no change to routing/dispatch elsewhere. This module
// still does not call into any specialist agent itself, still does not gather
// candidates on its own, and still requires expectedImpactCategory,
// expectedImpactMagnitude, and actionClassification on every candidate (see this
// file's own HONESTY GUARDS below) - a bare free-text objective with no
// caller-supplied candidates cannot succeed through this path either; something
// upstream (a human, or a future explicitly-scoped automation) must still supply real
// candidates first. Every other growth surface named above remains unreached by any
// capability.
//
// RANKING FORMULA (ICE-style: Impact x Confidence): rank_score =
// expected_impact_magnitude (caller-supplied, 1-5) x CONFIDENCE_MULTIPLIERS[confidence]
// (agent/core/growthOpportunityEngineModel.js: unassessed=0, low=0.33, medium=0.66,
// high=1). This is a standard, transparent prioritization framework, not an invented
// weighting scheme - the exact formula is also echoed in this module's `methodology`
// output field so every ranking is auditable. Ties are broken by evidence count
// (desc), then category (alphabetical), then original input order (a stable sort,
// documented here rather than left implicit).
//
// HONESTY GUARDS (same rule agent/core/productOpportunityScoringEngine.js's
// buildAssessedDimension and agent/core/analyticsAgent.js's analyzeInsights() already
// apply): a confidence asserted with zero evidence is forced down to 'unassessed'
// (so rank_score can never be inflated by an unevidenced confidence claim); a
// verification_status of 'verified' asserted with zero evidence is forced down to
// 'unverified'.
//
// expected_impact_magnitude has no honest default and is always required: unlike
// confidence/verification_status, which can honestly default to "nothing asserted
// yet", a business-impact size estimate cannot be silently invented as zero or
// guessed - the caller must supply it.

const {
  OPPORTUNITY_CATEGORIES,
  IMPACT_CATEGORIES,
  CONFIDENCE_MULTIPLIERS,
  createEmptyRankedGrowthOpportunity,
  validateRankedGrowthOpportunityShape,
} = require('./growthOpportunityEngineModel');
const { CONFIDENCE_LEVELS, RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');
const { getClassificationById } = require('../../approvals/approvalArchitecture');
const { AUTO_APPROVED_CLASSIFICATIONS } = require('./toolPermissions');

const METHODOLOGY =
  'rank_score = expected_impact_magnitude (caller-supplied, 1-5) x confidence_multiplier ' +
  '(unassessed=0, low=0.33, medium=0.66, high=1). Sorted descending by rank_score; ties ' +
  'broken by evidence count (desc), then category (alphabetical), then input order.';

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

function requireEnumMember(value, allowed, fieldName, fnName) {
  if (!allowed.includes(value)) {
    throw new Error(`${fnName} requires \`${fieldName}\` to be one of: ${allowed.join(', ')}`);
  }
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Validates and normalizes one raw candidate. Throws on a structurally invalid
// candidate (never silently drops or guesses one); never invents a value that wasn't
// supplied.
function normalizeCandidate(candidate, index, fnName) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`${fnName} requires candidates[${index}] to be an object.`);
  }

  requireEnumMember(candidate.category, OPPORTUNITY_CATEGORIES, `candidates[${index}].category`, fnName);
  requireNonEmptyString(candidate.opportunity, `candidates[${index}].opportunity`, fnName);
  requireNonEmptyString(candidate.reason, `candidates[${index}].reason`, fnName);
  requireNonEmptyString(candidate.requiredAction, `candidates[${index}].requiredAction`, fnName);
  requireEnumMember(
    candidate.expectedImpactCategory,
    IMPACT_CATEGORIES,
    `candidates[${index}].expectedImpactCategory`,
    fnName
  );

  const magnitude = candidate.expectedImpactMagnitude;
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude < 1 || magnitude > 5) {
    throw new Error(
      `${fnName} requires candidates[${index}].expectedImpactMagnitude to be a finite number between 1 and 5.`
    );
  }

  const classification = getClassificationById(candidate.actionClassification);
  if (!classification) {
    throw new Error(
      `${fnName} requires candidates[${index}].actionClassification to resolve to a real approvals/approvalArchitecture.js classification id.`
    );
  }

  const evidence = normalizeArray(candidate.evidence);

  const assertedConfidence = candidate.confidence || 'unassessed';
  requireEnumMember(assertedConfidence, CONFIDENCE_LEVELS, `candidates[${index}].confidence`, fnName);
  const confidence = evidence.length === 0 ? 'unassessed' : assertedConfidence;

  const assertedVerificationStatus = candidate.verificationStatus || 'unverified';
  requireEnumMember(
    assertedVerificationStatus,
    RESEARCH_VERIFICATION_STATUSES,
    `candidates[${index}].verificationStatus`,
    fnName
  );
  const verificationStatus =
    assertedVerificationStatus === 'verified' && evidence.length === 0 ? 'unverified' : assertedVerificationStatus;

  return {
    category: candidate.category,
    opportunity: candidate.opportunity,
    reason: candidate.reason,
    evidence,
    expectedImpactCategory: candidate.expectedImpactCategory,
    expectedImpactMagnitude: magnitude,
    confidence,
    verificationStatus,
    requiredAction: candidate.requiredAction,
    classification,
  };
}

function buildApprovalRequirement(classification) {
  return {
    classification: classification.id,
    title: classification.title,
    description: classification.description,
    requires_human_approval: !AUTO_APPROVED_CLASSIFICATIONS.includes(classification.id),
  };
}

function composeRecord(normalized) {
  const record = createEmptyRankedGrowthOpportunity(normalized.category, normalized.opportunity);
  record.reason = normalized.reason;
  record.evidence = normalized.evidence;
  record.expected_impact_category = normalized.expectedImpactCategory;
  record.expected_impact_magnitude = normalized.expectedImpactMagnitude;
  record.confidence = normalized.confidence;
  record.verification_status = normalized.verificationStatus;
  record.required_action = normalized.requiredAction;
  record.approval_requirement = buildApprovalRequirement(normalized.classification);
  record.rank_score = normalized.expectedImpactMagnitude * CONFIDENCE_MULTIPLIERS[normalized.confidence];

  const validation = validateRankedGrowthOpportunityShape(record);
  if (!validation.valid) {
    throw new Error(`Composed growth opportunity record failed validation: ${validation.errors.join('; ')}`);
  }
  return record;
}

function compareRecords(a, b, originalIndex) {
  if (b.rank_score !== a.rank_score) return b.rank_score - a.rank_score;
  if (b.evidence.length !== a.evidence.length) return b.evidence.length - a.evidence.length;
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  return originalIndex.get(a) - originalIndex.get(b);
}

// ---------------------------------------------------------------------------------
// Combined entry point.
// ---------------------------------------------------------------------------------

function rankGrowthOpportunities(candidates = []) {
  const fnName = 'rankGrowthOpportunities';
  if (!Array.isArray(candidates)) {
    throw new Error(`${fnName} requires \`candidates\` to be an array.`);
  }

  const records = candidates.map((candidate, index) => composeRecord(normalizeCandidate(candidate, index, fnName)));

  const originalIndex = new Map(records.map((record, index) => [record, index]));
  records.sort((a, b) => compareRecords(a, b, originalIndex));
  records.forEach((record, index) => {
    record.rank = index + 1;
  });

  return {
    generated_date: todayIsoDate(),
    total_opportunities: records.length,
    methodology: METHODOLOGY,
    opportunities: records,
  };
}

// ---------------------------------------------------------------------------------
// Partial ranking: rankAvailableGrowthOpportunities / applyGrowthOpportunityOverrides
//
// rankGrowthOpportunities() above is intentionally all-or-nothing: one structurally
// incomplete candidate throws and discards the whole batch - verified behavior, and
// not one line of the function above was changed for this addition. A caller working
// from real, partially-complete drafts (see agent/core/crossAgentContext.js's
// gatherGrowthOpportunityDrafts, which deliberately leaves expectedImpactCategory/
// expectedImpactMagnitude/actionClassification named as missing rather than inventing
// them) needs a way to rank what CAN be ranked and honestly report what can't - that
// is what this section adds, as a pure wrapper around the functions above, never a
// replacement for them.
// ---------------------------------------------------------------------------------

// Lists every REQUIRED field a candidate is missing or has invalid - mirrors
// normalizeCandidate's own checks above field for field, but never just the first one,
// so a caller can see the complete gap. Deliberately a separate, read-only check next
// to normalizeCandidate rather than a modification of it: normalizeCandidate's job is
// still to throw on the first bad field for rankGrowthOpportunities' existing
// all-or-nothing contract, completely unchanged; this one's job is to enumerate every
// gap without throwing, for the partial-ranking path below only.
function findMissingRequiredFields(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return ['(not an object)'];
  }

  const missing = [];
  if (!OPPORTUNITY_CATEGORIES.includes(candidate.category)) missing.push('category');
  if (typeof candidate.opportunity !== 'string' || candidate.opportunity.trim() === '') missing.push('opportunity');
  if (typeof candidate.reason !== 'string' || candidate.reason.trim() === '') missing.push('reason');
  if (typeof candidate.requiredAction !== 'string' || candidate.requiredAction.trim() === '') {
    missing.push('requiredAction');
  }
  if (!IMPACT_CATEGORIES.includes(candidate.expectedImpactCategory)) missing.push('expectedImpactCategory');

  const magnitude = candidate.expectedImpactMagnitude;
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude < 1 || magnitude > 5) {
    missing.push('expectedImpactMagnitude');
  }

  if (!getClassificationById(candidate.actionClassification)) missing.push('actionClassification');

  return missing;
}

// Partitions candidates into structurally-complete (ranked normally, via
// rankGrowthOpportunities above - completely unchanged) and incomplete (returned under
// `unranked` with their exact missing_fields, never ranked, never invented). An honest
// partial result by construction: ranking never silently drops an incomplete
// candidate, and never silently promotes one by guessing its missing fields.
function rankAvailableGrowthOpportunities(candidates = []) {
  const fnName = 'rankAvailableGrowthOpportunities';
  if (!Array.isArray(candidates)) {
    throw new Error(`${fnName} requires \`candidates\` to be an array.`);
  }

  const ready = [];
  const unranked = [];

  candidates.forEach((candidate, index) => {
    const missingFields = findMissingRequiredFields(candidate);
    if (missingFields.length === 0) {
      ready.push(candidate);
    } else {
      unranked.push({ index, candidate, missing_fields: missingFields });
    }
  });

  const rankedResult = rankGrowthOpportunities(ready);

  const limitations = [];
  if (candidates.length === 0) {
    limitations.push('No candidates were supplied - nothing to rank.');
  } else if (unranked.length > 0) {
    limitations.push(
      `${unranked.length} of ${candidates.length} candidate(s) could not be ranked - required fields are ` +
        'missing (see unranked[].missing_fields for each). Nothing was invented or defaulted to rank them.'
    );
  }

  return {
    generated_date: rankedResult.generated_date,
    methodology: rankedResult.methodology,
    total_candidates: candidates.length,
    ranked: rankedResult.opportunities,
    unranked,
    limitations,
  };
}

// Fields a caller may explicitly override on a real draft (see
// agent/core/crossAgentContext.js's gatherGrowthOpportunityDrafts) before ranking -
// exactly the subjective judgment fields no draft ever carries (this file's own
// HONESTY GUARDS above explain why). `category` is included because a draft whose
// opportunity_type had no honest engine-category mapping is left as category: null
// (see gatherGrowthOpportunityDrafts) - the same kind of caller-must-supply gap.
const OVERRIDABLE_JUDGMENT_FIELDS = [
  'category',
  'expectedImpactCategory',
  'expectedImpactMagnitude',
  'actionClassification',
];

// Merges caller-supplied judgment-field overrides onto real drafts, keyed by each
// draft's own `opportunity` text (the only caller-facing identifier a draft carries).
// Only OVERRIDABLE_JUDGMENT_FIELDS above are ever taken from an override - every other
// field (opportunity, reason, evidence, requiredAction, verificationStatus - all real,
// upstream-supplied values) is relayed from the draft completely unchanged, even if an
// override object happens to also carry a same-named key. Never invents a value for a
// draft with no matching override, or for an override that omits a field - that
// draft/field is simply left exactly as the real draft (or gatherGrowthOpportunityDrafts's
// own engine-side null/missing) left it, to be reported as still-missing by
// rankAvailableGrowthOpportunities above.
function applyGrowthOpportunityOverrides(drafts, overrides = {}) {
  if (!Array.isArray(drafts)) {
    throw new Error('applyGrowthOpportunityOverrides requires `drafts` to be an array.');
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('applyGrowthOpportunityOverrides requires `overrides` to be a plain object.');
  }

  return drafts.map((draft) => {
    const override = overrides[draft.opportunity];
    const merged = { ...draft };
    delete merged.missing_for_ranking; // recomputed independently by rankAvailableGrowthOpportunities

    if (override && typeof override === 'object' && !Array.isArray(override)) {
      for (const field of OVERRIDABLE_JUDGMENT_FIELDS) {
        if (field in override) merged[field] = override[field];
      }
    }

    return merged;
  });
}

module.exports = {
  rankGrowthOpportunities,
  buildApprovalRequirement,
  rankAvailableGrowthOpportunities,
  applyGrowthOpportunityOverrides,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Growth Opportunity Engine (deterministic, mechanical only):\n');

  const result = rankGrowthOpportunities([
    {
      category: 'seo',
      opportunity: '(Example: target "waterproof hiking boots" keyword cluster)',
      reason: 'Caller-supplied placeholder: keyword cluster has rising search volume and low current coverage.',
      evidence: ['(placeholder keyword research report)'],
      expectedImpactCategory: 'traffic_visibility',
      expectedImpactMagnitude: 4,
      confidence: 'high',
      requiredAction: 'Add an on-page SEO section targeting the keyword cluster (caller-supplied placeholder).',
      actionClassification: 'recommendation',
    },
    {
      category: 'retention',
      opportunity: '(Example: re-engage lapsed customers with a win-back offer)',
      reason: 'Caller-supplied placeholder: a customer segment has not purchased in 6+ months.',
      evidence: [],
      expectedImpactCategory: 'customer_retention',
      expectedImpactMagnitude: 2,
      confidence: 'medium',
      requiredAction: 'Send a win-back email campaign to the lapsed segment (caller-supplied placeholder).',
      actionClassification: 'approval_required',
    },
    {
      category: 'advertising',
      opportunity: '(Example: increase budget on a high-ROAS ad set)',
      reason: 'Caller-supplied placeholder: one ad set is reportedly outperforming others.',
      evidence: [],
      expectedImpactCategory: 'revenue',
      expectedImpactMagnitude: 5,
      confidence: 'high',
      requiredAction: 'Increase daily budget on the ad set (caller-supplied placeholder).',
      actionClassification: 'externally_executable',
    },
  ]);

  console.log(JSON.stringify(result, null, 2));

  console.log('\nNo opportunity, reason, evidence, or impact estimate above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('This engine never executes a required_action automatically - acting on one is a separate, human-approved action via approvals/.');
}
