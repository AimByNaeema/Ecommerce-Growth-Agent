'use strict';

// The seo_analysis tool (tools/toolRegistry.js): connects the Chief/Orchestrator to
// agent/core/seoAgent.js's analyzeProductSeo(), analyzeCollectionSeo(),
// analyzeContentSeo(), analyzeOnPageSeo(), and analyzeSeoOpportunities(). Thin wrapper
// - no new SEO-analysis logic is added here, only structured input handling, capability
// dispatch, and an honest outcome status, matching tools/marketResearchTool.js's
// convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (productReference,
// collectionReference, keywords, evidence, etc.) must arrive via
// executionRequest.research_params (the same optional passthrough every research/SEO
// tool uses). When it's missing, this tool reports that honestly instead of guessing
// parameters from the objective text.
//
// researchParams.seoCapability selects which capability to run - one of
// 'product_seo' (default when omitted), 'collection_seo', 'content_seo',
// 'on_page_seo', 'seo_opportunity_analysis', or 'information_gap_analysis'. One tool id
// covering 6 capabilities keeps tools/toolRegistry.js's existing, already-reserved shape
// intact - the Information Gap Finder deliberately reuses this entry rather than adding
// a second SEO tool for what is another mode of the same SEO analysis.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, an unknown seoCapability, or a
//                       required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied anywhere
//   status 'success' - valid input, every underlying record ended up evidence-backed
//   status 'partial' - valid input, some but not all records ended up evidence-backed

const {
  analyzeProductSeo,
  analyzeCollectionSeo,
  analyzeContentSeo,
  analyzeOnPageSeo,
  analyzeSeoOpportunities,
  analyzeInformationGaps,
} = require('../agent/core/seoAgent');

const CAPABILITY_HANDLERS = {
  product_seo: analyzeProductSeo,
  collection_seo: analyzeCollectionSeo,
  content_seo: analyzeContentSeo,
  on_page_seo: analyzeOnPageSeo,
  seo_opportunity_analysis: analyzeSeoOpportunities,
  information_gap_analysis: analyzeInformationGaps,
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

function runSeoAnalysisTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - seo_analysis requires structured parameters (e.g. productReference, evidence) that a free-text objective cannot provide.',
    };
  }

  const { seoCapability = 'product_seo', ...params } = researchParams;
  const handler = CAPABILITY_HANDLERS[seoCapability];
  if (!handler) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown seoCapability: ${seoCapability}. Must be one of: ${Object.keys(CAPABILITY_HANDLERS).join(', ')}`,
    };
  }

  try {
    const result = handler(params);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runSeoAnalysisTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - seo_analysis tool:\n');

  const cases = {
    'no researchParams': undefined,
    'unknown seoCapability (failed)': { seoCapability: 'not_a_real_capability' },
    'missing required field (failed)': { productReference: '' },
    'no evidence supplied (empty)': {
      productReference: '(Example insulated jacket)',
      internalOptimizationOpportunities: ['Meta description missing target keyword.'],
    },
    'evidence supplied (success)': {
      productReference: '(Example insulated jacket)',
      internalOptimizationOpportunities: ['Meta description missing target keyword.'],
      evidence: [{ topic: 'On-page audit', finding: 'Meta description is empty.', source: ['(placeholder audit source)'] }],
    },
    'collection SEO capability': {
      seoCapability: 'collection_seo',
      collectionReference: '(Example outdoor apparel collection)',
    },
    'SEO opportunity analysis capability': {
      seoCapability: 'seo_opportunity_analysis',
      keywords: [{ keyword: 'insulated hiking jacket', opportunity: 'Rising interest.' }],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runSeoAnalysisTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
