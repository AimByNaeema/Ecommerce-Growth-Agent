'use strict';

// The customer_research tool (tools/toolRegistry.js): connects the Chief/Orchestrator
// to agent/core/researchAgent.js's runCustomerMarketIntelligence() and
// deriveCustomerSegmentation(). Thin wrapper - see tools/marketResearchTool.js's
// header for the full rationale (structured passthrough, honest missing-input
// handling, never-fabricate guarantee) - identical here.
//
// researchParams.customerResearchMode selects which capability to run - one of
// 'segment_research' (default when omitted, the original behavior - composes
// caller-asserted customer segment records) or 'customer_segmentation' (structured
// ecommerce customer segmentation - mechanically derives a segment from purchase/
// order/engagement behavioral data; see deriveCustomerSegmentation's own header).
// One tool id covering both keeps tools/toolRegistry.js's existing, already-reserved
// shape intact - the same one-tool-many-capabilities pattern
// tools/seoAnalysisTool.js/marketingAnalysisTool.js/listingContentTool.js already use.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, an unknown customerResearchMode, or
//                       a required field was missing
//   status 'empty'   - valid input, but no evidence was supplied anywhere
//   status 'partial' - some records/segments have evidence, others don't
//   status 'success' - every composed record has evidence

const { runCustomerMarketIntelligence, deriveCustomerSegmentation } = require('../agent/core/researchAgent');

const MODE_HANDLERS = {
  segment_research: runCustomerMarketIntelligence,
  customer_segmentation: deriveCustomerSegmentation,
};

function deriveStatus(result) {
  const recordsMissingEvidence = result.limitations.filter((l) =>
    l.startsWith('No evidence was supplied for')
  ).length;
  const total = result.specialized_records.length;
  const recordsWithEvidence = total - recordsMissingEvidence;
  if (recordsWithEvidence === 0) return 'empty';
  if (recordsWithEvidence === total) return 'success';
  return 'partial';
}

function runCustomerResearchTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - customer_research requires structured parameters (e.g. segments, evidence) that a free-text objective cannot provide.',
    };
  }

  const { customerResearchMode = 'segment_research', ...params } = researchParams;
  const handler = MODE_HANDLERS[customerResearchMode];
  if (!handler) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown customerResearchMode: ${customerResearchMode}. Must be one of: ${Object.keys(MODE_HANDLERS).join(', ')}`,
    };
  }

  try {
    const result = handler(params);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runCustomerResearchTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - customer_research tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { segments: [{ needs: ['(placeholder need)'] }] },
    'no evidence supplied (empty)': {
      segments: [{ segmentDefinition: '(Example segment A)', needs: ['(placeholder need)'] }],
    },
    'mixed evidence (partial)': {
      segments: [
        { segmentDefinition: '(Example segment A)', needs: ['(placeholder need)'] },
        {
          segmentDefinition: '(Example segment B)',
          needs: ['(placeholder need)'],
          evidence: ['(placeholder source reference)'],
        },
      ],
    },
    'evidence supplied (success)': {
      segments: [
        {
          segmentDefinition: '(Example segment A)',
          needs: ['(placeholder need)'],
          evidence: ['(placeholder source reference)'],
        },
      ],
    },
    'customer_segmentation mode, missing segmentReference (failed)': {
      customerResearchMode: 'customer_segmentation',
    },
    'customer_segmentation mode, no evidence (empty)': {
      customerResearchMode: 'customer_segmentation',
      segmentReference: '(Example customer cohort)',
      orderFrequency: { orderCount: 6, daysSinceLastOrder: 100 },
      customerValue: { lifetimeValue: 620 },
    },
    'customer_segmentation mode, evidence supplied (success)': {
      customerResearchMode: 'customer_segmentation',
      segmentReference: '(Example customer cohort)',
      orderFrequency: { orderCount: 6, daysSinceLastOrder: 100 },
      customerValue: { lifetimeValue: 620 },
      evidence: ['(placeholder Shopify order history export)'],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runCustomerResearchTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
