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
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or the engine rejected the input
//                       (an invalid listingRecord/keywordRecords)
//   status 'empty'   - valid input, but no dimension had anything real to check
//   status 'partial' - valid input, some but not all dimensions are fully covered
//   status 'success' - valid input, every dimension is fully covered

const { checkSeoQuality } = require('../agent/core/seoQualityChecker');

// The engine already computes its own honest tri-state in quality_score.status
// ('empty' | 'partial' | 'success') - reused as-is rather than recomputed here, the
// same way tools/offerRecommendationTool.js's readStatus() reuses coverage_score.status.
function readStatus(result) {
  return result.quality_score.status;
}

// The one call into the checker, shared by the single and batch paths.
function checkOne(params) {
  try {
    const result = checkSeoQuality(params);
    return { status: readStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

// BATCH: listingRecords, one per real store product (agent/core/crossAgentContext.js's
// Product -> SEO relay). Each record is audited by the same checker, independently - one
// invalid record fails only itself. The overall status is honest about the mix: 'success'
// only when every product fully succeeded, 'failed' only when every product failed.
function aggregateStatus(checks) {
  if (checks.every((check) => check.status === 'success')) return 'success';
  if (checks.every((check) => check.status === 'failed')) return 'failed';
  if (checks.every((check) => check.status === 'empty')) return 'empty';
  return 'partial';
}

function runBatch(researchParams) {
  const { listingRecords, listingFieldGaps = null, keywordRecords, factualAttributes, researchDate } = researchParams;
  const checks = listingRecords.map((listingRecord) => {
    const outcome = checkOne({ listingRecord, keywordRecords, factualAttributes, researchDate });
    const subjectReference =
      listingRecord && typeof listingRecord === 'object' && typeof listingRecord.product_reference === 'string'
        ? listingRecord.product_reference
        : null;
    return { subject_reference: subjectReference, ...outcome };
  });
  const statusCounts = { success: 0, partial: 0, empty: 0, failed: 0 };
  for (const check of checks) statusCounts[check.status] += 1;
  return {
    status: aggregateStatus(checks),
    result: { products_checked: checks.length, status_counts: statusCounts, checks, field_gaps: listingFieldGaps },
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
