'use strict';

// The shape one structured campaign plan record conforms to. Schema and a couple of
// pure helpers only - no campaign execution, scheduling, or sending logic. No external
// marketing action (sending a message, launching a campaign, posting an ad) is ever
// taken here - nothing in this module reads external marketing platforms or writes to
// one; there is no execute/send/launch function anywhere in this module, so a campaign
// plan built from this shape is never launched automatically. Acting on a plan is a
// separate, human-approved action via approvals/ (see approvals/README.md).
//
// Distinct from agent/core/marketingAnalysisModel.js (reused as-is by
// agent/core/marketingAgent.js's marketing_strategy/offers/promotions/email_strategy
// capabilities): a full campaign plan needs fields none of those 4 capabilities need
// (creative_direction, cta, kpi, measurement_plan), so campaign_planning gets its own
// dedicated schema here rather than further widening the shared one - the same
// dedicated-schema-when-the-field-set-genuinely-differs precedent
// agent/core/listingContentModel.js already established relative to
// agent/core/listingOptimizationModel.js.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, extending the same
// cross-schema reuse precedent as agent/core/marketingAnalysisModel.js and
// agent/core/growthOpportunityModel.js.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const CAMPAIGN_PLAN_FIELDS = [
  {
    id: 'campaign_reference',
    title: 'Campaign reference',
    type: 'string',
    description: 'A name or identifier for the campaign this plan is for - no campaign invented here.',
  },
  {
    id: 'objective',
    title: 'Objective',
    type: 'string',
    description: 'The goal this campaign is meant to achieve.',
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
    description: 'Any real, already-configured offer or promotion this campaign carries - never invented.',
  },
  {
    id: 'message',
    title: 'Message',
    type: 'string',
    description: 'The core marketing message.',
  },
  {
    id: 'channel',
    title: 'Channel',
    type: 'string',
    description: 'Which marketing channel this campaign runs on - from configuration/business.yaml marketing_channels or explicit task requirements, never hardcoded.',
  },
  {
    id: 'creative_direction',
    title: 'Creative direction',
    type: 'string',
    description: 'Guidance for the campaign\'s visual/creative execution (e.g. tone, imagery style) - caller-supplied only, never invented.',
  },
  {
    id: 'cta',
    title: 'CTA',
    type: 'string',
    description: 'The call to action this campaign asks the audience to take.',
  },
  {
    id: 'kpi',
    title: 'KPI',
    type: 'array',
    description: 'The key performance indicator(s) this campaign will be judged against (e.g. click-through rate, conversion rate) - caller-supplied only, never a fabricated target number.',
  },
  {
    id: 'measurement_plan',
    title: 'Measurement plan',
    type: 'array',
    description: 'How the campaign\'s KPIs will actually be tracked/measured (e.g. which tool, what cadence) - caller-supplied only, never invented.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References backing this plan (e.g. prior campaign results, research records), not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this plan has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = CAMPAIGN_PLAN_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);

// Returns a blank campaign plan record conforming to CAMPAIGN_PLAN_FIELDS. No real
// campaign data - callers fill it in.
function createEmptyCampaignPlanRecord(campaign_reference = '') {
  return {
    campaign_reference,
    objective: '',
    audience: '',
    offer: '',
    message: '',
    channel: '',
    creative_direction: '',
    cta: '',
    kpi: [],
    measurement_plan: [],
    evidence: [],
    verification_status: 'unverified',
  };
}

// Checks that a campaign plan record has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateCampaignPlanShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = CAMPAIGN_PLAN_FIELDS.map((field) => field.id);
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
  CAMPAIGN_PLAN_FIELDS,
  createEmptyCampaignPlanRecord,
  validateCampaignPlanShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - campaign plan model (schema only):\n');
  CAMPAIGN_PLAN_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyCampaignPlanRecord('(no campaign set)'), null, 2));
  console.log('\nNo campaign is ever launched here - this module has no execute/send/launch function of any kind.');
}
