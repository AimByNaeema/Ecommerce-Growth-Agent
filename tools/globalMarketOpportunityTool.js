'use strict';

// The global_market_opportunity_analysis tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to workflows/globalEcommerceMarketResearchWorkflow.js's
// compareGlobalMarkets() - structured global ecommerce market opportunity analysis
// across 9 evidence-backed dimensions (country, category, demand, competition,
// pricing, trends, customer_need, risk, opportunity) per market/country row. Thin
// wrapper - no new composition logic is added here, only structured input handling
// and an honest outcome status, same convention as tools/marketResearchTool.js and
// tools/competitorResearchTool.js.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured research input (markets, topic)
// must arrive via executionRequest.research_params (an optional passthrough). When
// it's missing, this tool reports that honestly instead of guessing parameters from
// the objective text.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or compareGlobalMarkets() threw
//                       (e.g. a required field was missing)
//   status 'empty'   - valid input, but no row has evidence in any of its 9 facets
//   status 'partial' - some rows/facets have evidence, others don't
//   status 'success' - every row has evidence in every one of its 9 facets

const { compareGlobalMarkets } = require('../workflows/globalEcommerceMarketResearchWorkflow');

// A row's 9 facets: 5 scalar (has_evidence boolean) and 4 entry-list (status enum).
// "Complete" means every one of the 9 shows real evidence - never inferred, only read
// off the structural signals compareGlobalMarkets() itself already computed.
function isRowComplete(row) {
  return (
    row.category.has_evidence &&
    row.demand_signals.has_evidence &&
    row.trends.has_evidence &&
    row.risks.has_evidence &&
    row.opportunities.has_evidence &&
    row.competition.status === 'success' &&
    row.pricing.status === 'success' &&
    row.customer_need.status === 'success' &&
    row.products.status === 'success'
  );
}

function rowHasAnyEvidence(row) {
  return (
    row.category.has_evidence ||
    row.demand_signals.has_evidence ||
    row.trends.has_evidence ||
    row.risks.has_evidence ||
    row.opportunities.has_evidence ||
    row.competition.status !== 'empty' ||
    row.pricing.status !== 'empty' ||
    row.customer_need.status !== 'empty' ||
    row.products.status !== 'empty'
  );
}

function deriveStatus(result) {
  const rows = result.comparison;
  const completeRows = rows.filter(isRowComplete).length;
  if (completeRows === rows.length) return 'success';
  const rowsWithAnyEvidence = rows.filter(rowHasAnyEvidence).length;
  if (rowsWithAnyEvidence === 0) return 'empty';
  return 'partial';
}

function runGlobalMarketOpportunityTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - global_market_opportunity_analysis requires structured parameters (e.g. markets, topic) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = compareGlobalMarkets(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runGlobalMarketOpportunityTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - global_market_opportunity_analysis tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { topic: 'Outdoor apparel expansion' },
    'no evidence supplied (empty)': {
      markets: [{ country: 'US', market: 'North America', category: 'outdoor apparel' }],
    },
    'mixed evidence (partial)': {
      markets: [
        {
          country: 'DE',
          market: 'European Union',
          category: 'outdoor apparel',
          demandSignals: ['(placeholder demand signal)'],
          evidence: ['(placeholder market evidence reference)'],
        },
        { country: 'US', market: 'North America', category: 'outdoor apparel' },
      ],
    },
    'evidence supplied for every facet (success)': {
      markets: [
        {
          country: 'DE',
          market: 'European Union',
          category: 'outdoor apparel',
          demandSignals: ['(placeholder demand signal)'],
          trends: ['(placeholder trend)'],
          risks: ['(placeholder risk)'],
          opportunities: ['(placeholder opportunity)'],
          evidence: ['(placeholder market evidence reference)'],
          customerSegments: [
            {
              segmentDefinition: '(placeholder segment)',
              needs: ['(placeholder need)'],
              evidence: ['(placeholder segment evidence reference)'],
            },
          ],
          competitors: [
            {
              competitor: '(Example Co.)',
              pricingEvidence: ['(placeholder pricing evidence reference)'],
              strengths: ['(placeholder strength)'],
              source: ['(placeholder competitor source reference)'],
            },
          ],
          products: [
            {
              productIdentity: '(Example product)',
              pricing: { currency: 'EUR', cost: '40', price: '90' },
              source: ['(placeholder product source reference)'],
            },
          ],
        },
      ],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runGlobalMarketOpportunityTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
