'use strict';

// The shape one structured platform-aware content generation record conforms to.
// Schema and a couple of pure helpers only - no posting, scheduling, or publishing
// logic. No external social action is ever taken here - nothing in this module reads a
// social platform's API or writes to one; there is no post/publish/schedule function
// anywhere in this module, so a content record built from this shape is never
// published automatically. Acting on it is a separate, human-approved action via
// approvals/ (see approvals/README.md).
//
// Gets its own dedicated schema rather than widening agent/core/socialContentModel.js,
// because ecommerce content generation needs 7 distinct creative-element dimensions
// (hooks, captions, CTAs, content ideas, short-form video concepts, carousel concepts,
// creative briefs) that socialContentModel.js's single `caption` field was never meant
// to carry - the same dedicated-schema-when-the-field-set-genuinely-differs precedent
// agent/core/campaignPlanModel.js and agent/core/socialMediaStrategyModel.js already
// established.
//
// `platform` reuses agent/core/socialContentModel.js's existing SOCIAL_PLATFORMS enum
// rather than redefining it - content here is always generated for exactly one of the
// 5 in-scope social platforms, and every one of the 7 creative-element fields below is
// understood to already be adapted to that platform (its format, length, and tone
// conventions) by whoever supplied it - this module never invents or rewrites content
// to "fit" a platform on its own; it only requires the platform to be named so the
// adaptation is explicit and auditable, and records `platform_adaptation_notes` as a
// caller-supplied explanation of how/why the content fits that platform.
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it, the same cross-schema
// reuse precedent every other model in this project already established.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');
const { SOCIAL_PLATFORMS } = require('./socialContentModel');

const PLATFORM_CONTENT_FIELDS = [
  {
    id: 'platform',
    title: 'Platform',
    type: `enum: ${SOCIAL_PLATFORMS.join(' | ')}`,
    description: 'Which social platform this content is generated for and adapted to - no platform beyond these 5 is valid here.',
  },
  {
    id: 'content_reference',
    title: 'Content reference',
    type: 'string',
    description: 'A name or identifier for the content generation request this record is for - no content invented here.',
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
    id: 'hooks',
    title: 'Hooks',
    type: 'array',
    description: 'Opening lines/hooks meant to grab attention in the first seconds - caller-supplied only, never invented.',
  },
  {
    id: 'captions',
    title: 'Captions',
    type: 'array',
    description: 'Caption variations for this content - caller-supplied only, never invented.',
  },
  {
    id: 'ctas',
    title: 'CTAs',
    type: 'array',
    description: 'Call-to-action variations for this content - caller-supplied only, never invented.',
  },
  {
    id: 'content_ideas',
    title: 'Content ideas',
    type: 'array',
    description: 'Broader content ideas/concepts for this platform - caller-supplied only, never invented.',
  },
  {
    id: 'short_form_video_concepts',
    title: 'Short-form video concepts',
    type: 'array',
    description: 'Concept descriptions for short-form video content (e.g. Reels, TikToks, Shorts) - caller-supplied only, never invented.',
  },
  {
    id: 'carousel_concepts',
    title: 'Carousel concepts',
    type: 'array',
    description: 'Concept descriptions for multi-slide/carousel content - caller-supplied only, never invented.',
  },
  {
    id: 'creative_briefs',
    title: 'Creative briefs',
    type: 'array',
    description: 'Creative direction briefs (e.g. tone, visual style, constraints) guiding this content - caller-supplied only, never invented.',
  },
  {
    id: 'platform_adaptation_notes',
    title: 'Platform adaptation notes',
    type: 'string',
    description: 'How/why this content is adapted to the selected platform (e.g. aspect ratio, length limit, tone convention) - caller-supplied only, never a fabricated platform rule.',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'References backing this content (e.g. prior post performance, research records), not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this content record has been checked against current reality.',
  },
];

const ARRAY_FIELD_IDS = PLATFORM_CONTENT_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);

// Returns a blank platform content record conforming to PLATFORM_CONTENT_FIELDS. No
// real content - callers fill it in.
function createEmptyPlatformContentRecord(platform = null, content_reference = '') {
  return {
    platform,
    content_reference,
    objective: '',
    target_audience: '',
    hooks: [],
    captions: [],
    ctas: [],
    content_ideas: [],
    short_form_video_concepts: [],
    carousel_concepts: [],
    creative_briefs: [],
    platform_adaptation_notes: '',
    evidence: [],
    verification_status: 'unverified',
  };
}

// Checks that a platform content record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validatePlatformContentShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = PLATFORM_CONTENT_FIELDS.map((field) => field.id);
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
  PLATFORM_CONTENT_FIELDS,
  createEmptyPlatformContentRecord,
  validatePlatformContentShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - platform content model (schema only):\n');
  PLATFORM_CONTENT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyPlatformContentRecord('instagram', '(no content set)'), null, 2));
  console.log('\nNo content is ever published here - this module has no post/publish/schedule function of any kind.');
}
