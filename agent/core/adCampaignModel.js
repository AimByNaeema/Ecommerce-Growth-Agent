'use strict';

// The shape one structured paid ad campaign record conforms to. Schema and a couple of
// pure helpers only - no campaign execution, spending, or launch logic. No external
// advertising action (launching a campaign, spending budget, submitting an ad) is ever
// taken here - nothing in this module reads a paid-ads platform's API or writes to
// one; there is no execute/launch/spend function anywhere in this module, so an ad
// campaign record built from this shape is never launched automatically. Acting on it
// is a separate, human-approved action via approvals/ (see approvals/README.md).
//
// One shared schema reused across all 3 advertising capabilities (CLAUDE.md section 2,
// specialist #6: Meta Ads, Google Ads, TikTok Ads) - the `platform` field distinguishes
// which one a given record is for. Gets its own dedicated schema rather than widening
// agent/core/socialContentModel.js, because a paid campaign needs fields organic
// content doesn't (budget, bidding_strategy) - the same
// dedicated-schema-when-the-field-set-genuinely-differs precedent
// agent/core/campaignPlanModel.js already established relative to
// agent/core/marketingAnalysisModel.js. No platform beyond these 3 is a valid value
// here - a deliberate, narrow contract, not an open string.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, the same cross-schema
// reuse precedent agent/core/campaignPlanModel.js already established.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const AD_PLATFORMS = ['meta_ads', 'google_ads', 'tiktok_ads'];

const AD_CAMPAIGN_FIELDS = [
  {
    id: 'platform',
    title: 'Platform',
    type: `enum: ${AD_PLATFORMS.join(' | ')}`,
    description: 'Which paid advertising platform this campaign record is for - no platform beyond these 3 is valid here.',
  },
  {
    id: 'campaign_reference',
    title: 'Campaign reference',
    type: 'string',
    description: 'A name or identifier for the campaign this record is for - no campaign invented here.',
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
    description: 'Who/what this campaign targets, echoing agent/core/customerSegmentResearchModel.js segment_definition.',
  },
  {
    id: 'budget',
    title: 'Budget',
    type: 'string',
    description: 'The campaign\'s budget/spend as caller-supplied - never a fabricated number.',
  },
  {
    id: 'ad_creative',
    title: 'Ad creative',
    type: 'string',
    description: 'The ad\'s creative/copy direction - caller-supplied only, never invented.',
  },
  {
    id: 'bidding_strategy',
    title: 'Bidding strategy',
    type: 'string',
    description: 'How this campaign bids (e.g. cost-per-click, cost-per-acquisition target) - caller-supplied only, never invented.',
  },
  {
    id: 'cta',
    title: 'CTA',
    type: 'string',
    description: 'The call to action this campaign asks its audience to take.',
  },
  {
    id: 'kpi',
    title: 'KPI',
    type: 'array',
    description: 'The key performance indicator(s) this campaign will be judged against - caller-supplied only, never a fabricated target number.',
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
    description: 'References backing this campaign record (e.g. prior campaign results, research records), not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this campaign record has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = AD_CAMPAIGN_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);

// Returns a blank ad campaign record conforming to AD_CAMPAIGN_FIELDS. No real
// campaign data - callers fill it in.
function createEmptyAdCampaignRecord(platform = null, campaign_reference = '') {
  return {
    platform,
    campaign_reference,
    objective: '',
    audience: '',
    budget: '',
    ad_creative: '',
    bidding_strategy: '',
    cta: '',
    kpi: [],
    measurement_plan: [],
    evidence: [],
    verification_status: 'unverified',
  };
}

// Checks that an ad campaign record has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateAdCampaignShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = AD_CAMPAIGN_FIELDS.map((field) => field.id);
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

  if ('platform' in record && record.platform !== null && !AD_PLATFORMS.includes(record.platform)) {
    errors.push(`platform must be one of: ${AD_PLATFORMS.join(', ')}`);
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
  AD_PLATFORMS,
  AD_CAMPAIGN_FIELDS,
  createEmptyAdCampaignRecord,
  validateAdCampaignShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - ad campaign model (schema only):\n');
  AD_CAMPAIGN_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyAdCampaignRecord('meta_ads', '(no campaign set)'), null, 2));
  console.log('\nNo campaign is ever launched here - this module has no execute/launch/spend function of any kind.');
}
