'use strict';

// The seo_quality_check tool (tools/toolRegistry.js): connects the Chief/Orchestrator to
// agent/core/seoQualityChecker.js's checkSeoQuality(), the one implemented SEO engine
// that had no route into normal Chief dispatch. Thin wrapper - no dimension logic is
// added or restated here, only structured input handling, one engine call, and an
// honest outcome status, matching tools/offerRecommendationTool.js's convention exactly.
//
// WHY A SEPARATE TOOL RATHER THAN THE seoAnalysisTool.js MODE. The engine composes its
// OWN result schema (agent/core/seoQualityCheckModel.js: dimension_status, quality_score,
// dimension_gaps), not the shared SEO envelope (agent/core/seoAgentResultModel.js) every
// other seo_analysis capability returns - checkSeoQuality() audits an already-built
// listingOptimizationModel.js record, it does not build one. The same precedent
// tools/marketQuestionDiscoveryTool.js, tools/seoContentGenerationTool.js, and
// tools/offerRecommendationTool.js already set: a capability whose output is not its
// specialist agent's envelope gets its own tool id.
//
// Returns { status, result, error } - never throws. For ONE caller-supplied listingRecord:
//   status 'failed'  - no researchParams supplied, or the engine rejected the input
//                       (an invalid listingRecord/keywordRecords)
//   status 'empty'   - valid input, but no dimension had anything real to check
//   status 'partial' - valid input, some but not all dimensions are fully covered
//   status 'success' - valid input, every dimension is fully covered

const {
  checkSeoQuality,
  checkSeoQualityOnAvailableData,
  checkStoreListingFields,
  labelForDimension,
} = require('../agent/core/seoQualityChecker');

// The engine already computes its own honest tri-state in quality_score.status
// ('empty' | 'partial' | 'success') - reused as-is rather than recomputed here, the
// same way tools/offerRecommendationTool.js's readStatus() reuses coverage_score.status.
function readStatus(result) {
  return result.quality_score.status;
}

// The one call into the checker for a single caller-supplied record.
function checkOne(params) {
  try {
    const result = checkSeoQuality(params);
    return { status: readStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------------
// BATCH: the store audit - listingRecords, one per real store product (agent/core/
// crossAgentContext.js's Product -> SEO relay).
//
// WHAT THE STATUS MEANS HERE. It used to be the listings' own quality verdict, so a store
// whose products had any finding - and every real product has, because keyword research,
// search intent and internal links are not store fields - came back 'partial'. The
// orchestrator reads a tool's 'partial' as "evidence was missing" (validateResult ->
// 'unverified' -> step 'blocked'), so the Chief reported SEO as FAILED with "Required
// information is missing" although the audit had run on every real product. A finding about
// a listing is the audit's RESULT, not missing input. So the batch status now reports the
// AUDIT:
//   'success' - every product was audited on the data the store provides
//   'partial' - some products could not be audited (e.g. an invalid record)
//   'failed'  - no product could be audited
//   'empty'   - products were supplied but none carried anything to check
// and the verdict lives in the result: listings passing / needing attention, per-product
// findings, the most common recommendations, and every dimension or field that was NOT
// assessed with the reason it has no source.
// ---------------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// The inputs the relay declared as having no source for this product: the fields no store
// product carries, the checker inputs a store audit is never given, and the fields the read
// did not return for this particular product.
function declaredUnavailableInputs(listingFieldGaps, subjectReference) {
  if (!listingFieldGaps || typeof listingFieldGaps !== 'object') return [];
  const unread = asArray(listingFieldGaps.not_returned_by_read)
    .filter((entry) => entry && entry.product_reference === subjectReference)
    .flatMap((entry) => asArray(entry.fields).map((field) => ({ field, reason: 'The store read did not return this field for this product.' })));
  return [
    ...asArray(listingFieldGaps.not_on_store_product),
    ...asArray(listingFieldGaps.inputs_without_store_source),
    ...unread,
  ].filter((entry) => entry && typeof entry.field === 'string' && typeof entry.reason === 'string' && entry.reason.trim());
}

function auditOne(listingRecord, storeFields, sharedParams, listingFieldGaps) {
  const subjectReference =
    listingRecord && typeof listingRecord === 'object' && typeof listingRecord.product_reference === 'string'
      ? listingRecord.product_reference
      : null;
  try {
    const audited = checkSeoQualityOnAvailableData({
      ...sharedParams,
      listingRecord,
      unavailableInputs: declaredUnavailableInputs(listingFieldGaps, subjectReference),
    });
    return {
      subject_reference: subjectReference,
      status: audited.assessed_status,
      result: audited.check,
      not_assessed: audited.not_assessed,
      store_listing: storeFields ? checkStoreListingFields(storeFields) : null,
      error: null,
    };
  } catch (err) {
    return { subject_reference: subjectReference, status: 'failed', result: null, not_assessed: [], store_listing: null, error: err.message };
  }
}

function auditStatus(checks) {
  if (checks.every((check) => check.status === 'failed')) return 'failed';
  if (checks.some((check) => check.status === 'failed')) return 'partial';
  const nothingToCheck = (check) => check.status === 'empty' && !(check.store_listing && check.store_listing.status !== 'empty');
  if (checks.every(nothingToCheck)) return 'empty';
  return 'success';
}

function needsAttention(check) {
  if (check.status === 'failed') return false;
  const listingFindings = check.result ? check.result.recommendations.length > 0 : false;
  const storeFindings = check.store_listing ? check.store_listing.recommendations.length > 0 : false;
  return check.status !== 'success' || listingFindings || storeFindings;
}

// The recommendations shared by the most products, with how many products each applies to.
function commonRecommendations(checks, limit) {
  const counts = new Map();
  for (const check of checks) {
    const own = new Set([
      ...(check.result ? check.result.recommendations : []),
      ...(check.store_listing ? check.store_listing.recommendations : []),
    ]);
    for (const text of own) counts.set(text, (counts.get(text) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([recommendation, products]) => ({ recommendation, products }));
}

// Every dimension not assessed for at least one product, with its reason and how many.
function notAssessedAcrossProducts(checks) {
  const byDimension = new Map();
  for (const check of checks) {
    for (const entry of check.not_assessed) {
      const existing = byDimension.get(entry.dimension);
      if (existing) existing.products += 1;
      else byDimension.set(entry.dimension, { dimension: entry.dimension, label: labelForDimension(entry.dimension), reason: entry.reason, products: 1 });
    }
  }
  return [...byDimension.values()];
}

function composeSummary({ total, audited, passing, attention, failedCount, notAssessed, common, notRequested }) {
  const parts = [
    `Audited ${audited} of ${total} store product listing(s) on the data the store provides: ${passing} pass every assessable check and ${attention} need attention.`,
  ];
  if (failedCount > 0) parts.push(`${failedCount} could not be audited.`);
  if (common.length > 0) {
    parts.push(`Most common: ${common.slice(0, 3).map((entry) => `${entry.recommendation} (${entry.products})`).join('; ')}.`);
  }
  if (notAssessed.length > 0) {
    parts.push(`Not assessed, because the store has no source for them: ${notAssessed.map((entry) => entry.label).join(', ')}.`);
  }
  if (notRequested.length > 0) {
    parts.push(`Not read from the store: ${notRequested.map((entry) => entry.field).join(', ')}.`);
  }
  return parts.join(' ');
}

function runBatch(researchParams) {
  const { listingRecords, listingFieldGaps = null, listingStoreFields = null, keywordRecords, factualAttributes, researchDate } = researchParams;
  const sharedParams = { keywordRecords, factualAttributes, researchDate };
  const storeFields = asArray(listingStoreFields);
  const checks = listingRecords.map((listingRecord, index) => auditOne(listingRecord, storeFields[index] || null, sharedParams, listingFieldGaps));

  const statusCounts = { success: 0, partial: 0, empty: 0, failed: 0 };
  for (const check of checks) statusCounts[check.status] += 1;
  const failedCount = statusCounts.failed;
  const attention = checks.filter(needsAttention).length;
  const audited = checks.length - failedCount;
  const notAssessed = notAssessedAcrossProducts(checks);
  const common = commonRecommendations(checks, 10);
  const notRequested = listingFieldGaps && typeof listingFieldGaps === 'object' ? asArray(listingFieldGaps.not_requested_by_read) : [];

  return {
    status: auditStatus(checks),
    result: {
      products_checked: checks.length,
      status_counts: statusCounts,
      listings_passing: audited - attention,
      listings_needing_attention: attention,
      recommendations: common.map((entry) => `${entry.recommendation} (${entry.products} of ${checks.length} products)`),
      common_recommendations: common,
      not_assessed: notAssessed,
      summary: composeSummary({ total: checks.length, audited, passing: audited - attention, attention, failedCount, notAssessed, common, notRequested }),
      checks,
      field_gaps: listingFieldGaps,
    },
    error: null,
  };
}

function runSeoQualityCheckTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - seo_quality_check requires structured parameters (a listingRecord, plus any keywordRecords/factualAttributes) that a free-text objective cannot provide.',
    };
  }

  // A single caller-supplied listingRecord keeps its existing behaviour exactly.
  if (!researchParams.listingRecord && Array.isArray(researchParams.listingRecords)) {
    if (researchParams.listingRecords.length === 0) {
      return { status: 'failed', result: null, error: 'listingRecords was supplied but empty - there is no listing to check.' };
    }
    return runBatch(researchParams);
  }

  return checkOne(researchParams);
}

module.exports = { runSeoQualityCheckTool };

if (require.main === module) {
  const { createEmptyListingOptimizationRecord } = require('../agent/core/listingOptimizationModel');

  console.log('Smart E-Commerce Growth AI Agent - seo_quality_check tool:\n');

  const emptyListing = createEmptyListingOptimizationRecord('(Example insulated jacket)');

  const cases = {
    'no researchParams': undefined,
    'missing listingRecord (failed)': { keywordRecords: [] },
    'nothing supplied for any dimension (empty)': { listingRecord: emptyListing },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runSeoQualityCheckTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    if (outcome.result) console.log(`  coverage: ${outcome.result.quality_score.percentage}%`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('This tool never rewrites SEO content or publishes anything - it audits an already-built record only.');
}
