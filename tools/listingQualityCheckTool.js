'use strict';

// The listing_quality_check tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/listingQualityChecker.js's checkListingQuality(),
// the one implemented Listing engine that had no route into normal Chief dispatch. Thin
// wrapper - no dimension logic is added or restated here, only structured input
// handling, one engine call, and an honest outcome status, matching
// tools/offerRecommendationTool.js's convention exactly.
//
// WHY A SEPARATE TOOL RATHER THAN THE listingContentTool.js MODE. The engine composes
// its OWN result schema (agent/core/listingQualityCheckModel.js: dimension_status,
// quality_score, dimension_gaps), not agent/core/listingAgentResultModel.js's shared
// envelope - checkListingQuality() audits an already-built listingContentModel.js
// record, it does not build one. The same precedent tools/marketQuestionDiscoveryTool.js,
// tools/seoContentGenerationTool.js, and tools/offerRecommendationTool.js already set: a
// capability whose output is not its specialist agent's envelope gets its own tool id.
//
// operation: 'write' (see tools/toolRegistry.js) - not because this tool authors
// content, but because agent/core/toolPermissions.js's SPECIALIST_ROLE_PERMISSIONS
// scopes Listing to ['write'] only ("a pure content-creation role with no analysis
// tools of its own"). tools/offerRecommendationTool.js already set this exact
// precedent for Marketing's identical write-only role: an audit capability is still
// registered under its owning specialist's one permitted operation type, rather than
// being denied role access over a label.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or the engine rejected the input
//                       (an invalid listingRecord/keywordRecords)
//   status 'empty'   - valid input, but no dimension had anything real to check
//   status 'partial' - valid input, some but not all dimensions are fully covered
//   status 'success' - valid input, every dimension is fully covered

const { checkListingQuality } = require('../agent/core/listingQualityChecker');

// The engine already computes its own honest tri-state in quality_score.status
// ('empty' | 'partial' | 'success') - reused as-is rather than recomputed here, the
// same way tools/offerRecommendationTool.js's readStatus() reuses coverage_score.status.
function readStatus(result) {
  return result.quality_score.status;
}

function runListingQualityCheckTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - listing_quality_check requires structured parameters (a listingRecord, plus any keywordRecords/factualAttributes/customerObjections) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = checkListingQuality(researchParams);
    return { status: readStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runListingQualityCheckTool };

if (require.main === module) {
  const { createEmptyListingContentRecord } = require('../agent/core/listingContentModel');

  console.log('Smart E-Commerce Growth AI Agent - listing_quality_check tool:\n');

  const emptyListing = createEmptyListingContentRecord('(Example insulated jacket)');

  const cases = {
    'no researchParams': undefined,
    'missing listingRecord (failed)': { keywordRecords: [] },
    'nothing supplied for any dimension (empty)': { listingRecord: emptyListing },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runListingQualityCheckTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    if (outcome.result) console.log(`  coverage: ${outcome.result.quality_score.percentage}%`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('This tool never rewrites listing content or publishes anything - it audits an already-built record only.');
}
