'use strict';

// The shape one structured advertising strategy record conforms to. Schema and a
// couple of pure helpers only - no campaign execution, spending, or launch logic. No
// external advertising action (spending budget, launching a campaign) is ever taken
// here - nothing in this module reads a paid-ads platform's API or writes to one;
// there is no execute/launch/spend function anywhere in this module, so a strategy
// record built from this shape is never acted on automatically. Acting on it is a
// separate, human-approved action via approvals/ (see approvals/README.md).
//
// Gets its own dedicated schema rather than widening agent/core/adCampaignModel.js or
// agent/core/socialMediaStrategyModel.js, because this is a pre-launch strategic plan
// for one advertising campaign - it needs fields neither of those carries (offer,
// creative_angle, ad_copy, testing_plan), and unlike adCampaignModel.js it is not
// pinned to one of the 3 ad platforms (a strategy precedes platform selection), and
// unlike socialMediaStrategyModel.js it is not a cross-platform organic+paid content
// plan (content pillars, posting cadence) - it is advertising-only, with creative and
// testing dimensions neither existing schema carries. The same
// dedicated-schema-when-the-field-set-genuinely-differs precedent
// agent/core/campaignPlanModel.js already established relative to
// agent/core/marketingAnalysisModel.js.
//
// `budget_recommendation` is always a caller-supplied description, never a fabricated
// number - the same discipline agent/core/adCampaignModel.js's own `budget` field
// applies, and it is explicitly a *recommendation*, not a committed spend: this module
// never spends advertising budget.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, the same cross-schema
// reuse precedent every other model in this project already established.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const ADVERTISING_STRATEGY_FIELDS = [
  {
    id: 'strategy_reference',
    title: 'Strategy reference',
    type: 'string',
    description: 'A name or identifier for the advertising strategy this record is for - no strategy invented here.',
  },
  {
    id: 'campaign_objective',
    title: 'Campaign objective',
    type: 'string',
    description: 'The goal this advertising campaign is meant to achieve.',
  },
  {
    id: 'audience',
    title: 'Audience',
    type: 'string',
    description: 'Who this campaign targets, echoing agent/core/customerSegmentResearchModel.js segment_definition.',
  },
  {
    id: 'offer',
    title: 'Offer',
    type: 'string',
    description: 'The offer this campaign advertises (e.g. discount, bundle, promotion) - caller-supplied only, never invented.',
  },
  {
    id: 'creative_angle',
    title: 'Creative angle',
    type: 'string',
    description: 'The core creative angle/positioning this campaign\'s ads take - caller-supplied only, never invented.',
  },
  {
    id: 'ad_copy',
    title: 'Ad copy',
    type: 'array',
    description: 'Ad copy variants for this campaign - caller-supplied only, never invented.',
  },
  {
    id: 'cta',
    title: 'CTA',
    type: 'string',
    description: 'The call to action this campaign asks its audience to take.',
  },
  {
    id: 'budget_recommendation',
    title: 'Budget recommendation',
    type: 'string',
    description: 'A recommended budget as caller-supplied - never a fabricated number, and never spent or committed by this module.',
  },
  {
    id: 'kpi',
    title: 'KPI',
    type: 'array',
    description: 'The key performance indicator(s) this campaign will be judged against - caller-supplied only, never a fabricated target number.',
  },
  {
    id: 'testing_plan',
    title: 'Testing plan',
    type: 'array',
    description: 'What will be tested (e.g. creative angles, ad copy variants, audiences) and how - caller-supplied only, never invented.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References backing this strategy (e.g. prior campaign results, research records), not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this strategy record has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = ADVERTISING_STRATEGY_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank advertising strategy record conforming to
// ADVERTISING_STRATEGY_FIELDS. No real strategy - callers fill it in.
function createEmptyAdvertisingStrategyRecord(strategy_reference = '') {
  return {
    strategy_reference,
    campaign_objective: '',
    audience: '',
    offer: '',
    creative_angle: '',
    ad_copy: [],
    cta: '',
    budget_recommendation: '',
    kpi: [],
    testing_plan: [],
    evidence: [],
    verification_status: 'unverified',
  };
}

// Checks that an advertising strategy record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateAdvertisingStrategyShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = ADVERTISING_STRATEGY_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) {
      errors.push(`missing field: ${id}`);
    }
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) {
      errors.push(`unexpected field: ${id}`);
    }
  }

  for (const id of ARRAY_FIELD_IDS) {
    if (id in record && !Array.isArray(record[id])) {
      errors.push(`${id} must be an array`);
    }
  }

  if (
    'verification_status' in record &&
    !RESEARCH_VERIFICATION_STATUSES.includes(record.verification_status)
  ) {
    errors.push(`verification_status must be one of: ${RESEARCH_VERIFICATION_STATUSES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  ADVERTISING_STRATEGY_FIELDS,
  createEmptyAdvertisingStrategyRecord,
  validateAdvertisingStrategyShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - advertising strategy model (schema only):\n');
  ADVERTISING_STRATEGY_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyAdvertisingStrategyRecord('(no strategy set)'), null, 2));
  console.log('\nNo budget is ever spent and no campaign is ever launched here - this module has no execute/launch/spend function of any kind.');
}
