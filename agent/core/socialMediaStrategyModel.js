'use strict';

// The shape one structured social media strategy record conforms to. Schema and a
// couple of pure helpers only - no posting, scheduling, publishing, or spend logic. No
// external social/advertising action is ever taken here - nothing in this module reads
// a social/ads platform's API or writes to one; there is no execute/launch/publish
// function anywhere in this module, so a strategy record built from this shape never
// acts on its own. Acting on it is a separate, human-approved action via approvals/
// (see approvals/README.md).
//
// Gets its own dedicated schema rather than widening agent/core/socialContentModel.js
// or agent/core/adCampaignModel.js, because a strategy is a higher-level, cross-platform
// plan (content pillars, posting cadence, campaign themes, KPIs) rather than a single
// piece of content or a single ad campaign - the same
// dedicated-schema-when-the-field-set-genuinely-differs precedent
// agent/core/campaignPlanModel.js already established relative to
// agent/core/marketingAnalysisModel.js.
//
// `platform_selection` reuses the same SOCIAL_PLATFORMS/AD_PLATFORMS enums
// agent/core/socialContentModel.js and agent/core/adCampaignModel.js already define,
// rather than redefining a third platform list - a strategy may select from any of the
// 8 platforms already in scope (CLAUDE.md section 2, specialist #6), never a platform
// beyond them.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, the same cross-schema
// reuse precedent every other model in this project already established.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');
const { SOCIAL_PLATFORMS } = require('./socialContentModel');
const { AD_PLATFORMS } = require('./adCampaignModel');

const STRATEGY_PLATFORMS = [...SOCIAL_PLATFORMS, ...AD_PLATFORMS];

const SOCIAL_MEDIA_STRATEGY_FIELDS = [
  {
    id: 'strategy_reference',
    title: 'Strategy reference',
    type: 'string',
    description: 'A name or identifier for the strategy this record is for - no strategy invented here.',
  },
  {
    id: 'objective',
    title: 'Objective',
    type: 'string',
    description: 'The goal this social media strategy is meant to achieve.',
  },
  {
    id: 'audience',
    title: 'Audience',
    type: 'string',
    description: 'Who this strategy targets, echoing agent/core/customerSegmentResearchModel.js segment_definition.',
  },
  {
    id: 'content_pillars',
    title: 'Content pillars',
    type: 'array',
    description: 'The core, recurring subject areas this strategy is built around - caller-supplied only, never invented.',
  },
  {
    id: 'platform_selection',
    title: 'Platform selection',
    type: 'array',
    description: `Which of the 8 in-scope platforms this strategy targets (${STRATEGY_PLATFORMS.join(', ')}) - no platform beyond these is valid here.`,
  },
  {
    id: 'posting_strategy',
    title: 'Posting strategy',
    type: 'string',
    description: 'How and when content is planned to post (e.g. cadence, timing) - caller-supplied only, never a fabricated schedule.',
  },
  {
    id: 'content_themes',
    title: 'Content themes',
    type: 'array',
    description: 'Recurring topics/themes this strategy\'s content will cover - caller-supplied only, never invented.',
  },
  {
    id: 'campaign_themes',
    title: 'Campaign themes',
    type: 'array',
    description: 'Themes tied to specific campaigns or periods (e.g. seasonal, launch-driven) - caller-supplied only, never invented.',
  },
  {
    id: 'kpis',
    title: 'KPIs',
    type: 'array',
    description: 'The key performance indicator(s) this strategy will be judged against - caller-supplied only, never a fabricated target number.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References backing this strategy (e.g. prior performance data, research records), not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this strategy record has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = SOCIAL_MEDIA_STRATEGY_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank social media strategy record conforming to
// SOCIAL_MEDIA_STRATEGY_FIELDS. No real strategy - callers fill it in.
function createEmptySocialMediaStrategyRecord(strategy_reference = '') {
  return {
    strategy_reference,
    objective: '',
    audience: '',
    content_pillars: [],
    platform_selection: [],
    posting_strategy: '',
    content_themes: [],
    campaign_themes: [],
    kpis: [],
    evidence: [],
    verification_status: 'unverified',
  };
}

// Checks that a social media strategy record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateSocialMediaStrategyShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = SOCIAL_MEDIA_STRATEGY_FIELDS.map((field) => field.id);
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

  if ('platform_selection' in record && Array.isArray(record.platform_selection)) {
    for (const platform of record.platform_selection) {
      if (!STRATEGY_PLATFORMS.includes(platform)) {
        errors.push(`platform_selection entries must each be one of: ${STRATEGY_PLATFORMS.join(', ')}`);
        break;
      }
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
  STRATEGY_PLATFORMS,
  SOCIAL_MEDIA_STRATEGY_FIELDS,
  createEmptySocialMediaStrategyRecord,
  validateSocialMediaStrategyShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - social media strategy model (schema only):\n');
  SOCIAL_MEDIA_STRATEGY_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptySocialMediaStrategyRecord('(no strategy set)'), null, 2));
  console.log('\nNo strategy is ever executed here - this module has no execute/launch/publish function of any kind.');
}
