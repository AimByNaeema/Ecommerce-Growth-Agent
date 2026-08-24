'use strict';

// The analytics tool (tools/toolRegistry.js): connects the Chief/Orchestrator to
// agent/core/analyticsAgent.js's 10 capabilities using CALLER-SUPPLIED evidence. Thin
// wrapper - no new analytics logic is added here, only structured input handling,
// capability dispatch, and an honest outcome status, matching
// tools/marketingAnalysisTool.js's convention exactly. For LIVE, read-only Shopify
// data instead of caller-supplied evidence, see tools/analyticsDataTool.js - the two
// tools call the same agent/core/analyticsAgent.js capability functions, just with
// data from a different source.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (reportingPeriod, summary,
// actualMetrics/calculatedMetrics/estimatedMetrics, opportunities, evidence, etc.)
// must arrive via executionRequest.research_params (the same optional passthrough
// every research/SEO/listing/marketing/social tool uses). When it's missing, this
// tool reports that honestly instead of guessing parameters from the objective text.
//
// researchParams.analyticsCapability selects which capability to run - one of 'sales'
// (default when omitted), 'products', 'customers', 'conversion', 'traffic',
// 'marketing', 'advertising', 'inventory', 'growth_opportunities', or 'insights'
// (the analytics insight engine - see agent/core/insightEngine.js and
// agent/core/insightModel.js: given raw metric-comparison entries, returns only the
// significant ones as metric/current_state/comparison/possible_cause/opportunity/
// recommendation/confidence/evidence records, never asserting a possible_cause as a
// confirmed cause without supporting evidence). One tool id covering all 10
// capabilities keeps tools/toolRegistry.js's existing, already-reserved shape intact.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, an unknown analyticsCapability, or
//                       a required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied anywhere
//   status 'success' - valid input, every underlying record ended up evidence-backed
//   status 'partial' - valid input, some but not all records ended up evidence-backed

const {
  analyzeSales,
  analyzeProducts,
  analyzeCustomers,
  analyzeConversion,
  analyzeTraffic,
  analyzeMarketingAnalytics,
  analyzeAdvertisingAnalytics,
  analyzeInventory,
  analyzeGrowthOpportunities,
  analyzeInsights,
} = require('../agent/core/analyticsAgent');

const CAPABILITY_HANDLERS = {
  sales: analyzeSales,
  products: analyzeProducts,
  customers: analyzeCustomers,
  conversion: analyzeConversion,
  traffic: analyzeTraffic,
  marketing: analyzeMarketingAnalytics,
  advertising: analyzeAdvertisingAnalytics,
  inventory: analyzeInventory,
  growth_opportunities: analyzeGrowthOpportunities,
  insights: analyzeInsights,
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

function runAnalyticsTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - analytics requires structured parameters (e.g. reportingPeriod, summary, metrics, evidence) that a free-text objective cannot provide.',
    };
  }

  const { analyticsCapability = 'sales', ...params } = researchParams;
  const handler = CAPABILITY_HANDLERS[analyticsCapability];
  if (!handler) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown analyticsCapability: ${analyticsCapability}. Must be one of: ${Object.keys(CAPABILITY_HANDLERS).join(', ')}`,
    };
  }

  try {
    const result = handler(params);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runAnalyticsTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - analytics tool:\n');

  const cases = {
    'no researchParams': undefined,
    'unknown analyticsCapability (failed)': { analyticsCapability: 'not_a_real_capability' },
    'no evidence supplied (empty)': {
      reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
      summary: 'Total revenue up 8% quarter-over-quarter (caller-supplied placeholder).',
    },
    'evidence supplied (success)': {
      reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
      summary: 'Total revenue up 8% quarter-over-quarter (caller-supplied placeholder).',
      evidence: [{ topic: 'Sales report', finding: 'Q1 sales export (caller-supplied placeholder).', source: ['(placeholder sales dashboard export)'] }],
    },
    'products capability': {
      analyticsCapability: 'products',
      reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
      summary: 'The insulated jacket line is the top-selling category (caller-supplied placeholder).',
    },
    'advertising capability': {
      analyticsCapability: 'advertising',
      reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
      summary: 'Meta Ads ROAS improved after the creative refresh (caller-supplied placeholder).',
    },
    'inventory capability': {
      analyticsCapability: 'inventory',
      reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
      summary: 'Insulated jacket stock is running low (caller-supplied placeholder).',
    },
    'growth opportunities capability': {
      analyticsCapability: 'growth_opportunities',
      opportunities: [{ opportunityType: 'cross_selling', productReference: '(Example insulated jacket)' }],
    },
    'insights capability (causation-honesty guard demoed)': {
      analyticsCapability: 'insights',
      metrics: [
        {
          metric: 'total_revenue',
          currentValue: 128400,
          comparisonValue: 109000,
          comparisonLabel: 'previous quarter',
          unit: 'USD',
          possibleCause: 'A site-wide promotion ran during this period (caller-supplied placeholder).',
          confidence: 'high',
          evidence: ['(placeholder promo campaign log)'],
        },
        {
          metric: 'checkout_conversion_rate',
          currentValue: 1.9,
          comparisonValue: 2.8,
          comparisonLabel: 'previous quarter',
          unit: '%',
          possibleCause: 'A checkout redesign may have introduced friction (caller-supplied placeholder, unconfirmed).',
          confidence: 'high',
        },
      ],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runAnalyticsTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
