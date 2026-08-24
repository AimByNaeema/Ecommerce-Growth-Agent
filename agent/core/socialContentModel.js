'use strict';

// The shape one structured social media content record conforms to. Schema and a
// couple of pure helpers only - no posting, scheduling, or publishing logic. No
// external social action (posting, scheduling, boosting) is ever taken here - nothing
// in this module reads a social platform's API or writes to one; there is no
// post/publish/schedule function anywhere in this module, so a content record built
// from this shape is never posted automatically. Acting on it is a separate,
// human-approved action via approvals/ (see approvals/README.md).
//
// One shared schema reused across all 5 social capabilities (CLAUDE.md section 2,
// specialist #6: Instagram, Facebook, TikTok, Pinterest, YouTube) - the `platform`
// field distinguishes which one a given record is for, the same "one schema, a field
// distinguishes" approach agent/core/marketingAnalysisModel.js uses across Marketing's
// marketing_strategy/offers/promotions/email_strategy capabilities. No platform beyond
// these 5 is a valid value here - a deliberate, narrow contract, not an open string.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, the same cross-schema
// reuse precedent agent/core/marketingAnalysisModel.js and agent/core/campaignPlanModel.js
// already established.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'pinterest', 'youtube'];

const SOCIAL_CONTENT_FIELDS = [
  {
    id: 'platform',
    title: 'Platform',
    type: `enum: ${SOCIAL_PLATFORMS.join(' | ')}`,
    description: 'Which social platform this content record is for - no platform beyond these 5 is valid here.',
  },
  {
    id: 'content_reference',
    title: 'Content reference',
    type: 'string',
    description: 'A name or identifier for the piece of content this record is for - no content invented here.',
  },
  {
    id: 'content_type',
    title: 'Content type',
    type: 'string',
    description: 'The kind of content this is (e.g. post, story, reel, video, pin) - caller-supplied only, since content types vary by platform and none is hardcoded here.',
  },
  {
    id: 'objective',
    title: 'Objective',
    type: 'string',
    description: 'The goal this content is meant to achieve.',
  },
  {
    id: 'target_audience',
    title: 'Target audience',
    type: 'string',
    description: 'Who this content targets, echoing agent/core/customerSegmentResearchModel.js segment_definition.',
  },
  {
    id: 'caption',
    title: 'Caption',
    type: 'string',
    description: 'The content\'s copy/caption text.',
  },
  {
    id: 'hashtags',
    title: 'Hashtags',
    type: 'array',
    description: 'Hashtags associated with this content - caller-supplied only, never invented.',
  },
  {
    id: 'posting_schedule',
    title: 'Posting schedule',
    type: 'string',
    description: 'When this content is planned to post - caller-supplied only, never a fabricated date/time.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References backing this record (e.g. prior post performance, research records), not full documents.',
  },
  {
    id: 'expected_outcome',
    title: 'Expected outcome',
    type: 'string',
    description: 'What this content is expected to achieve - caller-supplied only, never a fabricated performance figure.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this record has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = SOCIAL_CONTENT_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);

// Returns a blank social content record conforming to SOCIAL_CONTENT_FIELDS. No real
// content - callers fill it in.
function createEmptySocialContentRecord(platform = null, content_reference = '') {
  return {
    platform,
    content_reference,
    content_type: '',
    objective: '',
    target_audience: '',
    caption: '',
    hashtags: [],
    posting_schedule: '',
    evidence: [],
    expected_outcome: '',
    verification_status: 'unverified',
  };
}

// Checks that a social content record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateSocialContentShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = SOCIAL_CONTENT_FIELDS.map((field) => field.id);
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

  if ('platform' in record && record.platform !== null && !SOCIAL_PLATFORMS.includes(record.platform)) {
    errors.push(`platform must be one of: ${SOCIAL_PLATFORMS.join(', ')}`);
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
  SOCIAL_PLATFORMS,
  SOCIAL_CONTENT_FIELDS,
  createEmptySocialContentRecord,
  validateSocialContentShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - social content model (schema only):\n');
  SOCIAL_CONTENT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptySocialContentRecord('instagram', '(no content set)'), null, 2));
  console.log('\nNo content is ever posted here - this module has no post/publish/schedule function of any kind.');
}
