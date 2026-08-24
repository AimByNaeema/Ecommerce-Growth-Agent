'use strict';

// The listing_content_generation tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/listingAgent.js's generateListingContent() and
// formatForMarketplace(). Thin wrapper - no new listing-content logic is added here,
// only structured input handling, capability dispatch, and an honest outcome status,
// matching tools/seoAnalysisTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (productReference,
// productTitle, benefits, evidence, etc.) must arrive via
// executionRequest.research_params (the same optional passthrough every research/SEO
// tool uses). When it's missing, this tool reports that honestly instead of guessing
// parameters from the objective text.
//
// researchParams.listingCapability selects which capability to run - one of
// 'listing_content' (default when omitted) or 'marketplace_format'.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, an unknown listingCapability, or a
//                       required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied anywhere
//   status 'success' - valid input, evidence-backed
//   status 'partial' - valid input, but no format constraints were supplied
//                       (marketplace_format only) or only partial evidence was found

const { generateListingContent, formatForMarketplace } = require('../agent/core/listingAgent');

const CAPABILITY_HANDLERS = {
  listing_content: generateListingContent,
  marketplace_format: formatForMarketplace,
};

function deriveStatus(result) {
  const missingEvidence = result.limitations.some((l) =>
    l.startsWith('No evidence was supplied for')
  );
  if (missingEvidence) return 'empty';

  const missingConstraints = result.limitations.some((l) =>
    l.startsWith('No format constraints were supplied')
  );
  if (missingConstraints) return 'partial';

  return 'success';
}

function runListingContentTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - listing_content_generation requires structured parameters (e.g. productReference, evidence) that a free-text objective cannot provide.',
    };
  }

  const { listingCapability = 'listing_content', ...params } = researchParams;
  const handler = CAPABILITY_HANDLERS[listingCapability];
  if (!handler) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown listingCapability: ${listingCapability}. Must be one of: ${Object.keys(CAPABILITY_HANDLERS).join(', ')}`,
    };
  }

  try {
    const result = handler(params);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runListingContentTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - listing_content_generation tool:\n');

  const cases = {
    'no researchParams': undefined,
    'unknown listingCapability (failed)': { listingCapability: 'not_a_real_capability' },
    'missing required field (failed)': { productReference: '' },
    'no evidence supplied (empty)': {
      productReference: '(Example insulated jacket)',
      productTitle: 'Insulated Hiking Jacket - placeholder',
      benefits: ['Keeps you warm (caller-supplied placeholder).'],
    },
    'evidence supplied (success)': {
      productReference: '(Example insulated jacket)',
      productTitle: 'Insulated Hiking Jacket - placeholder',
      benefits: ['Keeps you warm (caller-supplied placeholder).'],
      evidence: [{ topic: 'Product spec sheet', finding: 'Shell fabric is ripstop nylon.', source: ['(placeholder spec sheet source)'] }],
    },
    'marketplace format, no constraints (partial)': {
      listingCapability: 'marketplace_format',
      marketplace: 'etsy',
      productReference: '(Example insulated jacket)',
      sourceListing: { productTitle: 'Insulated Hiking Jacket - placeholder' },
    },
    'marketplace format, with constraints (success)': {
      listingCapability: 'marketplace_format',
      marketplace: 'etsy',
      productReference: '(Example insulated jacket)',
      sourceListing: { productTitle: 'Insulated Hiking Jacket - placeholder' },
      constraints: { maxTitleLength: 10 },
      evidence: [{ topic: 'Product spec sheet', finding: 'Shell fabric is ripstop nylon.', source: ['(placeholder spec sheet source)'] }],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runListingContentTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
