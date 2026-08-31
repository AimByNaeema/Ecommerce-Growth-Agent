'use strict';

// The marketing_analysis tool (tools/toolRegistry.js): connects the Chief/Orchestrator
// to agent/core/marketingAgent.js's 8 capabilities. Thin wrapper - no new marketing
// logic is added here, only structured input handling, capability dispatch, and an
// honest outcome status, matching tools/seoAnalysisTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (marketingChannel,
// campaign, segments, opportunities, evidence, etc.) must arrive via
// executionRequest.research_params (the same optional passthrough every research/SEO/
// listing tool uses). When it's missing, this tool reports that honestly instead of
// guessing parameters from the objective text.
//
// researchParams.marketingCapability selects which capability to run - one of
// 'marketing_strategy' (default when omitted), 'audience_segmentation', 'offers',
// 'promotions', 'retention', 'campaign_planning', 'email_strategy',
// 'conversion_opportunities', or 'marketing_opportunity_ranking'. One tool id
// covering all 9 capabilities keeps tools/toolRegistry.js's existing,
// already-reserved shape intact.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, an unknown marketingCapability, or
//                       a required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied anywhere
//   status 'success' - valid input, every underlying record ended up evidence-backed
//   status 'partial' - valid input, some but not all records ended up evidence-backed

const {
  analyzeMarketingStrategy,
  analyzeAudienceSegmentation,
  analyzeOffers,
  analyzePromotions,
  analyzeRetention,
  analyzeCampaignPlanning,
  analyzeEmailStrategy,
  analyzeConversionOpportunities,
  analyzeMarketingOpportunities,
} = require('../agent/core/marketingAgent');

const CAPABILITY_HANDLERS = {
  marketing_strategy: analyzeMarketingStrategy,
  audience_segmentation: analyzeAudienceSegmentation,
  offers: analyzeOffers,
  promotions: analyzePromotions,
  retention: analyzeRetention,
  campaign_planning: analyzeCampaignPlanning,
  email_strategy: analyzeEmailStrategy,
  conversion_opportunities: analyzeConversionOpportunities,
  marketing_opportunity_ranking: analyzeMarketingOpportunities,
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

function runMarketingAnalysisTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - marketing_analysis requires structured parameters (e.g. marketingChannel, evidence) that a free-text objective cannot provide.',
    };
  }

  const { marketingCapability = 'marketing_strategy', ...params } = researchParams;
  const handler = CAPABILITY_HANDLERS[marketingCapability];
  if (!handler) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown marketingCapability: ${marketingCapability}. Must be one of: ${Object.keys(CAPABILITY_HANDLERS).join(', ')}`,
    };
  }

  try {
    const result = handler(params);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runMarketingAnalysisTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - marketing_analysis tool:\n');

  const cases = {
    'no researchParams': undefined,
    'unknown marketingCapability (failed)': { marketingCapability: 'not_a_real_capability' },
    'missing required field (failed)': { marketingChannel: '' },
    'no evidence supplied (empty)': {
      marketingChannel: 'email',
      campaign: '(Example winter jacket launch)',
      objective: 'Drive awareness (caller-supplied placeholder).',
    },
    'evidence supplied (success)': {
      marketingChannel: 'email',
      campaign: '(Example winter jacket launch)',
      objective: 'Drive awareness (caller-supplied placeholder).',
      evidence: ['(placeholder prior-campaign result)'],
    },
    'audience segmentation capability': {
      marketingCapability: 'audience_segmentation',
      segments: [{ segmentDefinition: 'Budget-conscious weekend hikers (caller-supplied placeholder).' }],
    },
    'retention capability': {
      marketingCapability: 'retention',
      productReference: '(Example insulated jacket)',
      recommendation: 'Send a "we miss you" offer (caller-supplied placeholder).',
    },
    'conversion opportunities capability': {
      marketingCapability: 'conversion_opportunities',
      opportunities: [{ opportunityType: 'cross_selling', productReference: '(Example insulated jacket)' }],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runMarketingAnalysisTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
