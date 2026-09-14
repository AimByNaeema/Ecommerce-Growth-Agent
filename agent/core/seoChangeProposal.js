'use strict';

// SEO CHANGE PROPOSAL - "Review the SEO issues you found ... propose the safest way to fix the
// highest-priority ones, starting with the 3 most important products. Prepare the proposed changes
// for my approval, but do not make any changes yet."
//
// WHAT IT DOES. From research the Chief already completed on the real store - the Product read and
// the SEO/listing audit (storeOpportunityPrioritization.js's research basis) - it selects the most
// important products for the highest-priority SEO issues and proposes BEFORE/AFTER values for the
// SEO fields those issues name. It writes nothing, calls no model and reads no store.
//
// NOTHING IS INVENTED. An AFTER value is only ever derived from the same product's own stored text:
//   seo.title       <- the product title (or the current SEO title, when it is only too long),
//                      trimmed at a word boundary to the audit's own limit;
//   seo.description <- the product description's leading sentences (or the current SEO description,
//                      when it is only too long), trimmed at a word boundary to the audit's limit,
//                      and only when that yields at least the audit's minimum length.
// Anything that would need new wording or an owner's decision - rewriting a title, writing a
// description, choosing a product type or tags, deciding to publish - is listed per product as NOT
// PROPOSED, with the reason.
//
// THE GATES, UNCHANGED. Every proposal goes through the existing compliance engine plus the
// protected-mark detector - the same pair opportunityPreparationWorkflow.js applies to a listing
// draft - and a BLOCK is never put in front of a person. The Chief then creates one approval_required
// request per eligible product through approvals/approvalWorkflow.js. The request names
// seo_quality_check, a read tool, because approving it re-audits the proposed values: this system has
// no tool that writes Shopify SEO fields, so no approval here can change the store - and every
// proposal says so rather than implying otherwise.

const { createEmptyListingOptimizationRecord } = require('./listingOptimizationModel');
const { SEO_LENGTH_LIMITS } = require('./seoQualityChecker');
const { STORE_RESEARCH_BASIS } = require('./storeOpportunityPrioritization');
const { evaluateCompliance, summarizeComplianceForApproval } = require('../../compliance/complianceEngine');
const { detectProtectedMarks } = require('../../compliance/etsyIpRiskDetector');

const DEFAULT_PRODUCT_COUNT = 3;
const MAX_PRODUCT_COUNT = 10;
const PROPOSAL_KIND = 'seo_metadata';
const PROPOSAL_TOOL_ID = 'seo_quality_check';
const PROPOSAL_SPECIALIST_ID = 'seo';
const STORE_LISTING_DIMENSION = 'Store listing';

const STORE_WRITE_NOTE =
  'This system has no tool that writes Shopify SEO fields: approving a proposal records your decision and re-audits the proposed values, and nothing is written to the store. An approved change is applied in Shopify admin.';

const METHODOLOGY =
  'SEO issues are taken in the ranked order of the SEO/listing audit. Each product scores (N + 1 - rank) for every ranked SEO issue it has, ' +
  'where N is the number of ranked SEO issues. Published (ACTIVE) products come first, then the higher score, then more proposable changes, ' +
  'then store order. Only products with at least one change derivable from their own stored text are selected.';

const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collapse(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

// How many products the objective asks for ("the 3 most important products"), bounded; the default
// when it names none.
function requestedProductCount(objective) {
  const match = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[a-z-]+\s+){0,3}products?\b/i.exec(String(objective || ''));
  if (!match) return DEFAULT_PRODUCT_COUNT;
  const value = COUNT_WORDS[match[1].toLowerCase()] || Number(match[1]);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_PRODUCT_COUNT) : DEFAULT_PRODUCT_COUNT;
}

// Trims text to `max` characters at a word boundary. Never adds words, never adds an ellipsis.
function fitToLength(text, max) {
  const value = collapse(text);
  if (!value) return null;
  if (value.length <= max) return value;
  const window = value.slice(0, max + 1);
  const boundary = window.lastIndexOf(' ');
  const trimmed = (boundary > 0 ? window.slice(0, boundary) : value.slice(0, max)).replace(/[\s,;:|\-–—]+$/, '');
  return trimmed || null;
}

function deriveMetaTitle(sourceText) {
  return fitToLength(sourceText, SEO_LENGTH_LIMITS.META_TITLE_MAX_LENGTH);
}

// The description's leading whole sentences that fit the limit; a single over-long sentence is trimmed
// at a word boundary. null when the result would be shorter than the audit's minimum.
function deriveMetaDescription(description) {
  const value = collapse(description);
  const min = SEO_LENGTH_LIMITS.META_DESCRIPTION_MIN_LENGTH;
  const max = SEO_LENGTH_LIMITS.META_DESCRIPTION_MAX_LENGTH;
  if (value.length < min) return null;
  let built = '';
  for (const sentence of value.match(/[^.!?]+(?:[.!?]+|$)/g) || [value]) {
    const next = collapse(`${built} ${sentence}`);
    if (next.length > max) break;
    built = next;
  }
  const result = built.length >= min ? built : fitToLength(value, max);
  return result && result.length >= min ? result : null;
}

function splitLabel(full) {
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(String(full));
  return match ? { label: match[1], text: match[2] } : { label: STORE_LISTING_DIMENSION, text: String(full) };
}

function metadataField(text) {
  const match = /\b(meta_title|meta_description|url_slug)\b/.exec(text);
  return match ? match[1] : null;
}

function notProposedReason(label, text) {
  if (label === STORE_LISTING_DIMENSION) return 'A store listing decision (product type, tags, vendor or publishing) is the owner\'s to make; no value is proposed.';
  if (label === 'Title') return 'Changing the product title itself needs owner-written wording; no new title is proposed.';
  if (label === 'Content quality') return 'Writing or expanding the description needs owner-written content; none is invented.';
  if (metadataField(text) === 'url_slug') return 'Changing the URL handle affects existing links and is the owner\'s decision; no handle is proposed.';
  return `No field value is proposed for this ${label} issue.`;
}

// Before/after changes for one product, from its own stored text and the audit's recommendations.
function proposeChangesFor(source, recommendations) {
  const changes = [];
  const notProposed = [];
  const parsed = recommendations.map((full) => ({ full, ...splitLabel(full) }));
  const metadataFields = new Set(parsed.filter((entry) => entry.label === 'Metadata').map((entry) => metadataField(entry.text)).filter(Boolean));

  for (const entry of parsed) {
    const field = metadataField(entry.text);
    // "[Missing information] metadata.meta_title is missing." restates a Metadata recommendation.
    if (entry.label === 'Missing information' && field && metadataFields.has(field)) continue;

    if (entry.label === 'Metadata' && field === 'meta_title') {
      const current = collapse(source.seo_title);
      const tooLong = current.length > SEO_LENGTH_LIMITS.META_TITLE_MAX_LENGTH;
      const after = tooLong ? deriveMetaTitle(current) : deriveMetaTitle(source.title);
      if (after && after !== current) {
        changes.push({
          field: 'meta_title',
          shopify_field: 'seo.title',
          issue: entry.full,
          before: current,
          after,
          after_length: after.length,
          derived_from: tooLong ? 'current SEO title' : 'product title',
          method: `Taken from the ${tooLong ? 'current SEO title' : 'product title'} and trimmed at a word boundary to ${SEO_LENGTH_LIMITS.META_TITLE_MAX_LENGTH} characters or fewer.`,
        });
      } else {
        notProposed.push({ issue: entry.full, reason: 'No SEO title within the limit can be derived from this product\'s own stored text.' });
      }
      continue;
    }

    if (entry.label === 'Metadata' && field === 'meta_description') {
      const current = collapse(source.seo_description);
      const tooLong = current.length > SEO_LENGTH_LIMITS.META_DESCRIPTION_MAX_LENGTH;
      const after = tooLong ? fitToLength(current, SEO_LENGTH_LIMITS.META_DESCRIPTION_MAX_LENGTH) : deriveMetaDescription(source.description);
      if (after && after !== current) {
        changes.push({
          field: 'meta_description',
          shopify_field: 'seo.description',
          issue: entry.full,
          before: current,
          after,
          after_length: after.length,
          derived_from: tooLong ? 'current SEO description' : 'product description',
          method: `Taken from the ${tooLong ? 'current SEO description' : 'product description\'s leading sentences'} and trimmed at a word boundary to ${SEO_LENGTH_LIMITS.META_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
        });
      } else {
        notProposed.push({
          issue: entry.full,
          reason:
            `The product description has ${collapse(source.description).length} characters - too few to derive a meta description of at least ` +
            `${SEO_LENGTH_LIMITS.META_DESCRIPTION_MIN_LENGTH} characters without writing new content.`,
        });
      }
      continue;
    }

    notProposed.push({ issue: entry.full, reason: notProposedReason(entry.label, entry.text) });
  }
  return { changes, notProposed };
}

function checkProposalCompliance(source, changes, sourceRunId) {
  const content = [collapse(source.title), ...changes.map((change) => change.after)].filter(Boolean).join('\n');
  const verdict = evaluateCompliance({
    content,
    content_type: 'seo_metadata_proposal',
    content_reference: `seo-proposal-${source.shopify_product_id || source.product_reference}`,
    provenance: {
      source: 'shopify_product_fields',
      generator: 'agent/core/seoChangeProposal.js',
      evidence: [sourceRunId ? `Completed research run ${sourceRunId}` : 'Research basis read in this run'],
      supported_facts: [collapse(source.title), collapse(source.description), collapse(source.seo_title), collapse(source.seo_description)].filter(Boolean),
    },
    platform_context: { platform: 'shopify', surface: 'product_seo' },
    required_checks: ['provenance', 'unsupported_claims', 'prohibited_content'],
  });
  const summary = summarizeComplianceForApproval(verdict);
  const marks = detectProtectedMarks(content);
  if (marks.length === 0) return summary;
  // A protected mark is a hard stop - never reworded around, never sent for approval.
  return {
    ...summary,
    compliance_status: 'BLOCK',
    eligible_for_human_approval: false,
    blocking_findings: [
      ...summary.blocking_findings,
      ...marks.map((mark) => ({ check_type: 'ip_indicators', rule_id: 'protected_mark_indicator', reason: `Protected mark indicator '${mark.mark}' appears in this proposal.` })),
    ],
  };
}

function findBasisStep(steps, basis) {
  return (
    asArray(steps).find(
      (step) =>
        isPlainObject(step) &&
        step.selected_specialist &&
        step.selected_specialist.id === basis.specialistId &&
        step.inputs &&
        step.inputs.capability_id === basis.capabilityId &&
        step.completion_state === 'complete' &&
        isPlainObject(step.outputs) &&
        step.outputs.status === 'success'
    ) || null
  );
}

function storeFieldsFor(source) {
  const fields = isPlainObject(source.store_fields) ? source.store_fields : null;
  if (!fields) return null;
  return {
    product_reference: source.product_reference,
    product_type: fields.product_type,
    vendor: fields.vendor,
    tags: Array.isArray(fields.tags) ? [...fields.tags] : fields.tags,
    status: fields.status,
    unavailable_fields: asArray(fields.unavailable_fields),
  };
}

// The listing record with the proposed values applied, for the post-approval re-audit.
function proposedListingRecord(source, changes) {
  const record = createEmptyListingOptimizationRecord(source.product_reference);
  const after = (field, fallback) => {
    const change = changes.find((entry) => entry.field === field);
    return change ? change.after : fallback;
  };
  record.product_title = collapse(source.title);
  record.description = typeof source.description === 'string' ? source.description : '';
  record.metadata.meta_title = after('meta_title', collapse(source.seo_title));
  record.metadata.meta_description = after('meta_description', collapse(source.seo_description));
  record.metadata.url_slug = collapse(source.handle);
  return record;
}

function proposeSeoChanges({ steps = [], priorities = null, objective = '', businessId = null, sourceRunId = null, storeReference = null } = {}) {
  const requested = requestedProductCount(objective);
  const base = {
    kind: PROPOSAL_KIND,
    platform: 'shopify',
    source_run_id: sourceRunId,
    requested_products: requested,
    methodology: METHODOLOGY,
    store_writes: 0,
  };
  const productStep = findBasisStep(steps, STORE_RESEARCH_BASIS[0]);
  const seoStep = findBasisStep(steps, STORE_RESEARCH_BASIS[1]);
  if (!productStep || !seoStep || !isPlainObject(seoStep.outputs.result)) {
    return {
      ...base,
      seo_issues: [],
      products: [],
      limitations: ['No completed Product read and SEO/listing audit is in the research, so no SEO change could be proposed.', STORE_WRITE_NOTE],
    };
  }

  const seoIssues = asArray(priorities && priorities.opportunities).filter(
    (opportunity) => isPlainObject(opportunity) && opportunity.dimension !== STORE_LISTING_DIMENSION
  );
  const issueRank = new Map(seoIssues.map((opportunity, index) => [`[${opportunity.dimension}] ${opportunity.issue}`, index + 1]));
  const sources = new Map();
  asArray(productStep.outputs.listing_sources).forEach((source, index) => {
    if (isPlainObject(source) && typeof source.product_reference === 'string') sources.set(source.product_reference, { source, index });
  });

  const candidates = [];
  let needOwnerInput = 0;
  for (const check of asArray(seoStep.outputs.result.checks)) {
    if (!isPlainObject(check) || check.status === 'failed') continue;
    const found = sources.get(check.subject_reference);
    if (!found) continue;
    const seoRecommendations = asArray(check.result && check.result.recommendations).filter((text) => typeof text === 'string');
    const storeRecommendations = asArray(check.store_listing && check.store_listing.recommendations).filter((text) => typeof text === 'string');
    const score = seoRecommendations.reduce((sum, text) => (issueRank.has(text) ? sum + (seoIssues.length + 1 - issueRank.get(text)) : sum), 0);
    if (score === 0) continue;
    const { changes, notProposed } = proposeChangesFor(found.source, [...seoRecommendations, ...storeRecommendations]);
    if (changes.length === 0) {
      needOwnerInput += 1;
      continue;
    }
    const status = isPlainObject(found.source.store_fields) ? found.source.store_fields.status || null : null;
    candidates.push({ source: found.source, index: found.index, status, score, changes, notProposed });
  }

  candidates.sort(
    (a, b) =>
      (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) ||
      b.score - a.score ||
      b.changes.length - a.changes.length ||
      a.index - b.index
  );

  const fieldGaps = isPlainObject(seoStep.outputs.result.field_gaps) ? seoStep.outputs.result.field_gaps : null;
  const products = candidates.slice(0, requested).map((candidate, position) => {
    const { source, changes, notProposed } = candidate;
    const compliance = checkProposalCompliance(source, changes, sourceRunId);
    const approvalEligible = compliance.compliance_status !== 'BLOCK';
    const storeFields = storeFieldsFor(source);
    return {
      rank: position + 1,
      product_reference: source.product_reference,
      shopify_product_id: source.shopify_product_id || null,
      status: candidate.status,
      priority_score: candidate.score,
      proposed_changes: changes,
      not_proposed: notProposed,
      compliance,
      approval_eligible: approvalEligible,
      approval_id: null,
      approval_reason:
        `Proposed SEO changes for "${source.product_reference}" (${changes.map((change) => change.shopify_field).join(', ')}), ` +
        `derived only from this product's own stored text. Compliance returned ${compliance.compliance_status}. ${STORE_WRITE_NOTE}`,
      execution_request: {
        business_id: businessId || null,
        specialist_id: PROPOSAL_SPECIALIST_ID,
        objective: `Re-audit the approved SEO proposal for "${source.product_reference}". Nothing is written to the store.`,
        compliance,
        research_params: {
          proposal_kind: PROPOSAL_KIND,
          platform: 'shopify',
          product_reference: source.product_reference,
          shopify_product_id: source.shopify_product_id || null,
          proposed_changes: changes,
          source_run_id: sourceRunId,
          // The opaque reference of the store these values were read from (researchContext.js), so the
          // proposal can only ever be applied to that store.
          store_reference: storeReference || null,
          store_write_note: STORE_WRITE_NOTE,
          listingRecords: [proposedListingRecord(source, changes)],
          listingStoreFields: [storeFields],
          ...(fieldGaps ? { listingFieldGaps: fieldGaps } : {}),
        },
      },
    };
  });

  const limitations = [STORE_WRITE_NOTE];
  if (products.length < requested) {
    limitations.push(
      `Only ${products.length} product(s) have an SEO change that can be derived from their own stored text; ${requested} were requested and the list is not padded.`
    );
  }
  if (needOwnerInput > 0) {
    limitations.push(`${needOwnerInput} other product(s) have ranked SEO issues that need owner-written content, so no change is proposed for them.`);
  }
  if (products.some((product) => !product.approval_eligible)) {
    limitations.push('A proposal that compliance BLOCKED is shown but not sent for approval.');
  }

  return {
    ...base,
    seo_issues: seoIssues.map((opportunity, index) => ({
      rank: index + 1,
      issue: `[${opportunity.dimension}] ${opportunity.issue}`,
      affected_products: opportunity.estimated_impact ? opportunity.estimated_impact.affected_products : null,
      audited_products: opportunity.estimated_impact ? opportunity.estimated_impact.audited_products : null,
    })),
    products,
    limitations,
  };
}

module.exports = {
  PROPOSAL_KIND,
  PROPOSAL_TOOL_ID,
  PROPOSAL_SPECIALIST_ID,
  STORE_WRITE_NOTE,
  requestedProductCount,
  deriveMetaTitle,
  deriveMetaDescription,
  proposeSeoChanges,
};
