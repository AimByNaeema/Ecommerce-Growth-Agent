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
// Standalone deliverable, not wired into tools/toolRegistry.js or
// agent/core/orchestratorExecutionContract.js - the same deliberate scope choice
// agent/core/offerRecommendationEngine.js, agent/core/productOpportunityScoringEngine.js,
// agent/core/productRecommendationEngine.js, agent/core/seoQualityChecker.js, and
// agent/core/listingQualityChecker.js already made (a ranking engine that composes
// existing structured input, directly callable, not part of a 7-capability
// dispatcher). It does not call into any specialist agent itself - whoever calls this
// engine (a workflow, the orchestrator, or a human) is responsible for gathering
// candidates from the relevant specialists first. A future, explicitly-scoped prompt
// can wire it in and/or automate candidate gathering if wanted.
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

module.exports = {
  rankGrowthOpportunities,
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
