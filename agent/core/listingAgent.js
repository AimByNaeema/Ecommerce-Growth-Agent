'use strict';

// The Listing Agent (CLAUDE.md section 2, specialist #4: "Product listing content and
// optimization"). Supports 2 capabilities: listing content generation and marketplace
// listing formatting.
//
// Deterministic only - no AI API call, no external fetch (none is configured or called
// anywhere in this project). Callers supply already-structured evidence; this module's
// job is to validate it, compose it into the existing schemas
// (agent/core/listingContentModel.js, agent/core/marketplaceListingFormatModel.js -
// reused as-is, never duplicated), and grade it honestly - never to synthesize or
// guess a title, a benefit, a feature, an attribute, a variant, or a formatted field.
// Same philosophy and structure as agent/core/researchAgent.js, agent/core/
// productAgent.js, and agent/core/seoAgent.js: retrieval (build + validate records),
// analysis (flatten findings/evidence/source, derive honest limitations), and
// recommendation (relay only what the caller supplied) stay distinct, composed by one
// thin composeResult().
//
// Capability -> schema mapping:
//   - listing content composes agent/core/listingContentModel.js records: title,
//     description, benefits, features, selling points, FAQs, attributes, variants, and
//     a CTA - all in one record, all built only from caller-supplied input. See
//     listingContentModel.js's own header for why this is a dedicated schema rather
//     than a further widening of agent/core/listingOptimizationModel.js (SEO's file).
//
//     "Structured ecommerce listing generation" (generateListingContent's richer mode):
//     title/description/CTA may optionally be DERIVED - never invented - from other
//     specialists' already-produced structured output, via a fixed, honest precedence
//     order (resolveListingSources() below): an explicit field always wins; failing
//     that, title/description fall back to seoRecommendations (an
//     agent/core/listingOptimizationModel.js-shaped record, e.g. SEO's product_seo
//     output), description further falls back to productInfo.description (an
//     agent/core/productModel.js-shaped record), and CTA falls back to
//     brandInfo.tagline (the same {name, tagline, tone} shape
//     configuration/business.yaml's own brand: block already uses - see
//     tools/configValidator.js). customerSegment (an
//     agent/core/customerSegmentResearchModel.js-shaped record) is never used to
//     derive title/description/CTA text - only surfaced as findings and missing-
//     information context - since a segment's needs/motivations are evidence, not
//     listing copy. Every derivation step only ever RELAYS text some other specialist
//     or the caller already produced; nothing here writes a new sentence. Any of the 5
//     structured sources that is missing, and any output field that ends up empty
//     after applying precedence, is reported by name in the result's `limitations`
//     (this schema's existing "honest gaps" convention - see
//     agent/core/listingAgentResultModel.js - reused rather than adding a parallel
//     "missing information" field).
//   - marketplace format composes agent/core/marketplaceListingFormatModel.js records:
//     a deterministic, constraint-driven reformatting of an already-built listing
//     content record for one marketplace channel - truncation/mapping only, never new
//     content.
//
// Confidence: caller-asserted only, defaulting to 'unassessed' - same convention as
// every other module in this project. A 'verified' claim asserted without evidence is
// downgraded back to 'unverified' (same honesty guard as researchAgent.js's).
//
// Reuses agent/core/researchAgent.js directly rather than reimplementing:
// retrieveListingData delegates generic-kind entries to its retrieveResearchData, and
// recommendations pass through its deriveRecommendations - the same cross-agent reuse
// pattern agent/core/productAgent.js and agent/core/seoAgent.js already established.

const {
  createEmptyListingContentRecord,
  validateListingContentShape,
} = require('./listingContentModel');
const {
  createEmptyMarketplaceListingFormatRecord,
  validateMarketplaceListingFormatShape,
} = require('./marketplaceListingFormatModel');
const {
  LISTING_CAPABILITIES,
  createEmptyListingAgentResult,
  validateListingAgentResultShape,
} = require('./listingAgentResultModel');
const { retrieveResearchData, deriveRecommendations } = require('./researchAgent');

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

// Never guesses content - only normalizes a missing/singular value into the array
// shape every model already expects.
function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------
// Retrieval - builds and validates specialized records from raw caller-supplied
// entries. This IS "data retrieval" in this deterministic-only architecture (see
// module header) - no live product/content API is configured. Never invents an entry
// that wasn't supplied.
// ---------------------------------------------------------------------------------

function buildListingContentRecord(entry, fnName) {
  requireNonEmptyString(entry.productReference, 'productReference', fnName);
  const record = createEmptyListingContentRecord(entry.productReference);
  record.product_title = entry.productTitle || '';
  record.description = entry.description || '';
  record.benefits = normalizeArray(entry.benefits);
  record.features = normalizeArray(entry.features);
  record.selling_points = normalizeArray(entry.sellingPoints);
  record.faqs = normalizeArray(entry.faqs);
  record.attributes = normalizeArray(entry.attributes);
  record.variants = normalizeArray(entry.variants);
  record.cta = entry.cta || '';

  const validation = validateListingContentShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid listing content record: ${validation.errors.join('; ')}`);
  }
  return record;
}

// Deterministic truncation only - never generates new text. Returns the source string
// unchanged (plus a note only if it was actually truncated) when no length constraint
// is supplied for that field.
function truncateField(sourceValue, maxLength, fieldLabel, constraintsApplied) {
  const value = sourceValue || '';
  if (typeof maxLength !== 'number' || maxLength <= 0 || value.length <= maxLength) {
    return value;
  }
  constraintsApplied.push(`${fieldLabel} truncated to ${maxLength} characters.`);
  return value.slice(0, maxLength);
}

function buildMarketplaceFormatRecord(entry, fnName) {
  requireNonEmptyString(entry.marketplace, 'marketplace', fnName);
  requireNonEmptyString(entry.productReference, 'productReference', fnName);
  const sourceListing = entry.sourceListing || {};
  const constraints = entry.constraints || {};

  const record = createEmptyMarketplaceListingFormatRecord(entry.marketplace, entry.productReference);
  const constraintsApplied = [];
  record.formatted_title = truncateField(
    sourceListing.productTitle,
    constraints.maxTitleLength,
    'Title',
    constraintsApplied
  );
  record.formatted_description = truncateField(
    sourceListing.description,
    constraints.maxDescriptionLength,
    'Description',
    constraintsApplied
  );
  record.formatted_attributes = normalizeArray(sourceListing.attributes);
  record.format_constraints_applied = constraintsApplied;

  const validation = validateMarketplaceListingFormatShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid marketplace listing format record: ${validation.errors.join('; ')}`);
  }
  return record;
}

const RECORD_BUILDERS = {
  listing_content: buildListingContentRecord,
  marketplace_format: buildMarketplaceFormatRecord,
};

// Exported for reuse (mirrors agent/core/seoAgent.js's retrieveSeoData). 'generic'
// delegates straight to researchAgent.js's retrieveResearchData rather than
// reimplementing it - the only "external source" in this architecture is the caller's
// own structured input either way.
function retrieveListingData(kind, entries, fnName) {
  if (kind === 'generic') {
    return retrieveResearchData('generic', entries, fnName);
  }
  const builder = RECORD_BUILDERS[kind];
  if (!builder) {
    throw new Error(`retrieveListingData received an unknown record kind: ${kind}`);
  }
  return entries.map((entry) => builder(entry, fnName));
}

// ---------------------------------------------------------------------------------
// Analysis - optional supporting evidence for either capability, reusing
// researchAgent.js's generic record builder directly (same pattern
// agent/core/productAgent.js's buildDimension and agent/core/seoAgent.js's
// buildOnPageEvidence already established) rather than reimplementing generic evidence
// handling here.
// ---------------------------------------------------------------------------------

function buildSupportingEvidence(evidenceEntries, fnName) {
  const records = retrieveResearchData('generic', normalizeArray(evidenceEntries), fnName);
  const evidence = records.filter((record) => record.finding).map((record) => record.finding);
  const source = records.flatMap((record) => record.source);
  return { evidence, source };
}

// Resolves generateListingContent's 5 optional structured composition sources
// (productInfo, targetMarket, customerSegment, seoRecommendations, brandInfo - see
// module header) into final title/description/CTA/market values, plus an honest
// missing-information list and supporting findings. Every resolved value is a direct
// RELAY of already-supplied text via a fixed precedence order - never a newly written
// sentence. Reports each missing structured source and each output field that still
// ends up empty, so nothing is silently absent.
function resolveListingSources(params) {
  const { productInfo, targetMarket, customerSegment, seoRecommendations, brandInfo } = params;
  const missing = [];
  const additionalFindings = [];

  if (!productInfo) missing.push('No product information was supplied.');
  if (!targetMarket && !params.market) missing.push('No target market was supplied.');

  if (!customerSegment) {
    missing.push('No customer segment was supplied.');
  } else {
    if (customerSegment.segment_definition) {
      additionalFindings.push(`Customer segment: ${customerSegment.segment_definition}`);
    }
    for (const need of normalizeArray(customerSegment.needs)) {
      additionalFindings.push(`Customer segment need: ${need}`);
    }
    for (const motivation of normalizeArray(customerSegment.buying_motivations)) {
      additionalFindings.push(`Customer segment buying motivation: ${motivation}`);
    }
  }

  if (!seoRecommendations) {
    missing.push('No SEO recommendations were supplied.');
  } else {
    for (const keyword of normalizeArray(seoRecommendations.keywords)) {
      additionalFindings.push(`SEO-recommended keyword: ${keyword}`);
    }
  }

  if (!brandInfo) missing.push('No brand information was supplied.');

  const resolvedProductTitle = params.productTitle || (seoRecommendations && seoRecommendations.product_title) || '';
  if (!resolvedProductTitle) {
    missing.push('No title could be derived - supply productTitle or seoRecommendations.product_title.');
  }

  const resolvedDescription = params.description
    || (seoRecommendations && seoRecommendations.description)
    || (productInfo && productInfo.description)
    || '';
  if (!resolvedDescription) {
    missing.push('No description could be derived - supply description, seoRecommendations.description, or productInfo.description.');
  }

  const resolvedCta = params.cta || (brandInfo && brandInfo.tagline) || '';
  if (!resolvedCta) {
    missing.push('No CTA could be derived - supply cta or brandInfo.tagline.');
  }

  const resolvedMarket = params.market || targetMarket || '';

  return { resolvedProductTitle, resolvedDescription, resolvedCta, resolvedMarket, missing, additionalFindings };
}

// ---------------------------------------------------------------------------------
// Composition - a thin assembler: applies the verified-without-evidence honesty guard,
// builds the common agent/core/listingAgentResultModel.js envelope, and validates it.
// The only place either capability's result gets combined into one common shape.
// ---------------------------------------------------------------------------------

function composeResult({
  capability,
  topic,
  market,
  findings,
  evidence,
  source,
  confidence,
  limitations,
  recommendations,
  verificationStatus,
  researchDate,
  specializedRecords,
}) {
  const finalLimitations = [...limitations];
  const anyEvidenceSupplied = evidence.length > 0 || source.length > 0;

  let finalVerificationStatus = verificationStatus || 'unverified';
  if (finalVerificationStatus === 'verified' && !anyEvidenceSupplied) {
    finalVerificationStatus = 'unverified';
    finalLimitations.push('Verification status was downgraded to unverified because no evidence or source was supplied.');
  }

  const result = createEmptyListingAgentResult(capability, topic);
  result.market = market || '';
  result.findings = findings;
  result.evidence = evidence;
  result.source = source;
  result.confidence = confidence || 'unassessed';
  result.limitations = finalLimitations;
  result.recommendations = deriveRecommendations(recommendations);
  result.verification_status = finalVerificationStatus;
  result.research_date = researchDate || todayIsoDate();
  result.specialized_records = specializedRecords;

  const validation = validateListingAgentResultShape(result);
  if (!validation.valid) {
    throw new Error(`Composed Listing agent result failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

// ---------------------------------------------------------------------------------
// One function per supported capability.
// ---------------------------------------------------------------------------------

function generateListingContent(params = {}) {
  const fnName = 'generateListingContent';
  const sources = resolveListingSources(params);
  const record = buildListingContentRecord(
    { ...params, productTitle: sources.resolvedProductTitle, description: sources.resolvedDescription, cta: sources.resolvedCta },
    fnName
  );
  const { evidence, source } = buildSupportingEvidence(params.evidence, fnName);

  const limitations = [
    'No live product data or content-generation tool is configured; this result reflects only caller-supplied evidence.',
    'No AI/content-generation logic writes new copy - title/description/CTA reflect only the highest-priority caller-supplied source (explicit field > SEO recommendation > product info > brand tagline), relayed as-is, never independently written.',
    'No product specification is invented or altered - every benefit, feature, selling point, FAQ, attribute, variant, and CTA above is composed only from caller-supplied structured input.',
    'This is a suggestion only - applying it to the real listing requires a separate, human-approved action (see approvals/); nothing here is automatically published.',
    ...sources.missing,
  ];
  if (evidence.length === 0 && source.length === 0) {
    limitations.push(`No evidence was supplied for ${record.product_reference}.`);
  }

  const findings = [...record.benefits, ...record.selling_points, ...sources.additionalFindings];

  return composeResult({
    capability: 'listing_content',
    topic: params.topic || `Listing content: ${record.product_reference}`,
    market: sources.resolvedMarket,
    findings,
    evidence,
    source,
    confidence: params.confidence,
    limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: [record],
  });
}

function formatForMarketplace(params = {}) {
  const fnName = 'formatForMarketplace';
  const record = buildMarketplaceFormatRecord(params, fnName);
  const { evidence, source } = buildSupportingEvidence(params.evidence, fnName);

  const limitations = [
    'No live marketplace-formatting tool or channel connection is configured; formatting is deterministic truncation/mapping of caller-supplied content only.',
    'No product specification is invented or altered - this reformats caller-supplied listing content only.',
    'This is a suggestion only - publishing it to a real marketplace channel requires a separate, human-approved action (see approvals/); nothing here is automatically published.',
  ];
  if (record.format_constraints_applied.length === 0) {
    limitations.push('No format constraints were supplied; content was carried through unchanged.');
  }

  return composeResult({
    capability: 'marketplace_format',
    topic: params.topic || `Marketplace format (${record.marketplace}): ${record.product_reference}`,
    market: params.market || '',
    findings: [...record.format_constraints_applied],
    evidence,
    source,
    confidence: params.confidence,
    limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: [record],
  });
}

const LISTING_CAPABILITY_HANDLERS = {
  listing_content: generateListingContent,
  marketplace_format: formatForMarketplace,
};

// The single entry point: dispatches by capability to the matching function above.
// Never guesses an unrecognized capability - throws a clear error instead.
function runListingAgent({ capability, ...params } = {}) {
  const handler = LISTING_CAPABILITY_HANDLERS[capability];
  if (!handler) {
    throw new Error(`Unknown Listing capability: ${capability}. Must be one of: ${LISTING_CAPABILITIES.join(', ')}`);
  }
  return handler(params);
}

module.exports = {
  generateListingContent,
  formatForMarketplace,
  runListingAgent,
  retrieveListingData,
  resolveListingSources,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Listing Agent (deterministic, evidence-composition only):\n');

  const samples = [
    () =>
      generateListingContent({
        productReference: '(Example insulated jacket)',
        productTitle: 'Insulated Hiking Jacket - placeholder',
        description: 'Caller-supplied placeholder description text.',
        benefits: ['Keeps you warm on cold hikes (caller-supplied placeholder).'],
        features: ['Waterproof shell (caller-supplied placeholder).'],
        sellingPoints: ['Lighter than comparable jackets (caller-supplied placeholder).'],
        faqs: [{ question: 'Is it machine washable?', answer: 'Yes, cold wash only (caller-supplied placeholder).' }],
        attributes: [{ name: 'material', value: 'ripstop nylon (caller-supplied placeholder)' }],
        variants: [{ variant_reference: '(Example variant: size M)', title: 'Medium', differentiators: 'Fits 5\'8"-5\'11" (caller-supplied placeholder).' }],
        evidence: [{ topic: 'Product spec sheet', finding: 'Shell fabric is ripstop nylon (caller-supplied placeholder).', source: ['(placeholder spec sheet source)'] }],
      }),
    () =>
      generateListingContent({
        productReference: '(Example insulated jacket)',
        productInfo: { description: 'Caller-supplied placeholder product description from agent/core/productModel.js.' },
        targetMarket: 'European Union',
        customerSegment: {
          segment_definition: 'Budget-conscious weekend hikers (caller-supplied placeholder).',
          needs: ['Reliable warmth without a premium price tag (caller-supplied placeholder).'],
          buying_motivations: ['Upcoming winter hiking trip (caller-supplied placeholder).'],
        },
        seoRecommendations: {
          product_title: 'Insulated Hiking Jacket | SEO-recommended title (caller-supplied placeholder)',
          keywords: ['insulated hiking jacket'],
        },
        brandInfo: { name: '(Example brand)', tagline: 'Gear up. Head out. (caller-supplied placeholder)', tone: 'friendly, direct' },
      }),
    () =>
      formatForMarketplace({
        marketplace: 'etsy',
        productReference: '(Example insulated jacket)',
        sourceListing: {
          productTitle: 'Insulated Hiking Jacket - a very long placeholder title meant to exceed a typical marketplace character limit for demonstration purposes',
          description: 'Caller-supplied placeholder description text.',
          attributes: [{ name: 'material', value: 'ripstop nylon (caller-supplied placeholder)' }],
        },
        constraints: { maxTitleLength: 80 },
      }),
  ];

  for (const sample of samples) {
    const result = sample();
    console.log(`--- ${result.capability} ---`);
    console.log(JSON.stringify(result, null, 2));
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('No product specification is ever invented by this module.');
}
