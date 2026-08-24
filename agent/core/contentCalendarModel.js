'use strict';

// The shape one structured social content calendar entry conforms to. Schema and a
// couple of pure helpers only - no posting, scheduling, or publishing logic. No
// external social action is ever taken here - nothing in this module reads a social
// platform's API or writes to one; there is no post/publish/schedule function anywhere
// in this module, so a calendar entry built from this shape is never published or
// scheduled automatically. Acting on it is a separate, human-approved action via
// approvals/ (see approvals/README.md).
//
// Gets its own dedicated schema rather than widening agent/core/socialContentModel.js
// or agent/core/platformContentModel.js, because a calendar entry is a plan-level
// record (one entry per planned date) with fields neither of those carry (date,
// campaign, product) and without either's own richer per-piece fields (caption,
// hashtags, multiple hook/caption/CTA variations) - the same
// dedicated-schema-when-the-field-set-genuinely-differs precedent every other model in
// this specialist already established.
//
// `platform` reuses agent/core/socialContentModel.js's existing SOCIAL_PLATFORMS enum
// rather than redefining it - a calendar entry always plans for exactly one of the 5
// in-scope social platforms, never a platform beyond them.
//
// `campaign` is a plain string here (not a nested object) - when the caller wants to
// derive it from real Marketing Agent campaign context, that composition happens in
// agent/core/socialAdvertisingAgent.js's analyzeContentCalendar(), which reuses
// agent/core/marketingAgent.js's own retrieveMarketingData('campaign_plan', ...)
// directly rather than reimplementing campaign-plan logic here - this schema only
// carries the resulting reference string.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, the same cross-schema
// reuse precedent every other model in this project already established.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');
const { SOCIAL_PLATFORMS } = require('./socialContentModel');

const CONTENT_CALENDAR_FIELDS = [
  {
    id: 'entry_reference',
    title: 'Entry reference',
    type: 'string',
    description: 'A name or identifier for this calendar entry - no entry invented here.',
  },
  {
    id: 'date',
    title: 'Date',
    type: 'string',
    description: 'The planned posting date for this entry (caller-supplied, e.g. an ISO date) - never a fabricated schedule.',
  },
  {
    id: 'platform',
    title: 'Platform',
    type: `enum: ${SOCIAL_PLATFORMS.join(' | ')}`,
    description: 'Which social platform this entry is planned for - no platform beyond these 5 is valid here.',
  },
  {
    id: 'content_type',
    title: 'Content type',
    type: 'string',
    description: 'The kind of content planned (e.g. post, story, reel, video, pin) - caller-supplied only, since content types vary by platform and none is hardcoded here.',
  },
  {
    id: 'topic',
    title: 'Topic',
    type: 'string',
    description: 'What this planned piece of content is about.',
  },
  {
    id: 'hook',
    title: 'Hook',
    type: 'string',
    description: 'The planned opening line/hook for this entry - caller-supplied only, never invented.',
  },
  {
    id: 'cta',
    title: 'CTA',
    type: 'string',
    description: 'The planned call to action for this entry - caller-supplied only, never invented.',
  },
  {
    id: 'campaign',
    title: 'Campaign',
    type: 'string',
    description: 'Which real, already-defined campaign this entry belongs to - never invented; may be supplied directly or derived from Marketing Agent campaign context (see agent/core/socialAdvertisingAgent.js).',
  },
  {
    id: 'product',
    title: 'Product',
    type: 'string',
    description: 'Which real, already-configured product this entry is about - never invented.',
  },
  {
    id: 'kpi',
    title: 'KPI',
    type: 'array',
    description: 'The key performance indicator(s) this entry will be judged against - caller-supplied only, never a fabricated target number.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References backing this entry (e.g. prior post performance, research records), not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this entry has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = CONTENT_CALENDAR_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);

// Returns a blank content calendar entry conforming to CONTENT_CALENDAR_FIELDS. No
// real entry - callers fill it in.
function createEmptyContentCalendarRecord(entry_reference = '', date = '', platform = null) {
  return {
    entry_reference,
    date,
    platform,
    content_type: '',
    topic: '',
    hook: '',
    cta: '',
    campaign: '',
    product: '',
    kpi: [],
    evidence: [],
    verification_status: 'unverified',
  };
}

// Checks that a content calendar entry has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateContentCalendarShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = CONTENT_CALENDAR_FIELDS.map((field) => field.id);
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
  CONTENT_CALENDAR_FIELDS,
  createEmptyContentCalendarRecord,
  validateContentCalendarShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - content calendar model (schema only):\n');
  CONTENT_CALENDAR_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyContentCalendarRecord('(no entry set)', '(no date set)', 'instagram'), null, 2));
  console.log('\nNo entry is ever posted or scheduled here - this module has no post/publish/schedule function of any kind.');
}
