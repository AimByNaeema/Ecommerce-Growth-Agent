'use strict';

// The workflow that turns real analytics data into a verified result, composing
// agent/core/analyticsModel.js (DATA), agent/core/opportunityAnalysisModel.js and
// agent/core/growthOpportunityModel.js (OPPORTUNITY), agent/core/listingOptimizationModel.js /
// agent/core/marketingAnalysisModel.js / agent/core/growthOpportunityModel.js
// (RECOMMENDATION), and agent/core/researchRecordModel.js's verification_status
// convention (VERIFICATION). Process foundation only - no stage performs a real
// calculation or decision; each description names where one belongs.
//
// STATEMENT_TYPES is the taxonomy the agent must use to label every claim it makes
// along this chain. Hypotheses (the `opportunity` and `expected_impact` stages) are
// never presented as facts - they stay labeled `hypothesis` until the `verification`
// stage confirms or refutes them against real outcomes.

const STATEMENT_TYPES = [
  {
    id: 'observed_fact',
    title: 'Observed fact',
    description: 'A directly observed data point, taken as-is from a real source (e.g. agent/core/analyticsModel.js metrics) - not computed or judged.',
  },
  {
    id: 'calculated_result',
    title: 'Calculated result',
    description: 'A value derived from observed facts through a defined calculation (e.g. a rate, total, or trend) - still objective, but derived rather than directly observed.',
  },
  {
    id: 'interpretation',
    title: 'Interpretation',
    description: 'A qualitative reading of what observed facts/calculated results mean in context - a labeled judgment, not a raw number.',
  },
  {
    id: 'hypothesis',
    title: 'Hypothesis',
    description: 'An unproven possible explanation or prediction (e.g. why something happened, what might happen next) - never presented as a fact until verified.',
  },
  {
    id: 'recommendation',
    title: 'Recommendation',
    description: 'A suggested action for a human to consider - always downstream of the above, never a fact or a guarantee of outcome.',
  },
];

const ANALYTICS_INSIGHT_STAGES = [
  {
    id: 'data',
    title: 'DATA',
    description: 'Gather real data (agent/core/analyticsModel.js snapshot categories) - statement type: observed_fact only; nothing here is computed or judged.',
  },
  {
    id: 'finding',
    title: 'FINDING',
    description: 'Derive a finding from the gathered data (e.g. a total, rate, or trend) - statement type: calculated_result, still objective and traceable to the source data.',
  },
  {
    id: 'interpretation',
    title: 'INTERPRETATION',
    description: 'Explain what the finding means in context (echoing agent/core/marketResearchModel.js, agent/core/customerSegmentResearchModel.js) - statement type: interpretation, a labeled judgment, not a fact.',
  },
  {
    id: 'opportunity',
    title: 'OPPORTUNITY',
    description: 'Identify a possible opportunity the interpretation suggests (echoing agent/core/opportunityAnalysisModel.js, agent/core/growthOpportunityModel.js) - statement type: hypothesis; unproven, never stated as confirmed.',
  },
  {
    id: 'recommendation',
    title: 'RECOMMENDATION',
    description: 'Propose a concrete action addressing the opportunity (echoing agent/core/listingOptimizationModel.js, agent/core/marketingAnalysisModel.js, agent/core/growthOpportunityModel.js) - statement type: recommendation; acting on it requires approval (see approvals/approvalArchitecture.js).',
  },
  {
    id: 'expected_impact',
    title: 'EXPECTED IMPACT',
    description: 'State the anticipated effect of the recommendation, if taken - statement type: hypothesis about a future outcome, never a guaranteed or fabricated performance number.',
  },
  {
    id: 'verification',
    title: 'VERIFICATION',
    description: 'Check the actual outcome against the expected impact once the recommendation has been acted on (see agent/core/researchRecordModel.js verification_status convention) - turns a hypothesis into a confirmed or refuted result, never left ambiguous.',
  },
];

function getStatementTypeById(id) {
  return STATEMENT_TYPES.find((entry) => entry.id === id);
}

function getAnalyticsInsightWorkflow() {
  return ANALYTICS_INSIGHT_STAGES;
}

module.exports = {
  STATEMENT_TYPES,
  ANALYTICS_INSIGHT_STAGES,
  getStatementTypeById,
  getAnalyticsInsightWorkflow,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - analytics insight workflow (foundation only):\n');

  console.log('Statement types the agent must distinguish:');
  STATEMENT_TYPES.forEach((entry, index) => {
    console.log(`${index + 1}. [${entry.id}] ${entry.title}`);
    console.log(`   ${entry.description}`);
  });

  console.log('\nWorkflow stages:');
  ANALYTICS_INSIGHT_STAGES.forEach((stage, index) => {
    console.log(`${index + 1}. [${stage.id}] ${stage.title}`);
    console.log(`   ${stage.description}`);
  });

  console.log('\nHypotheses (opportunity, expected_impact) are never presented as facts - only verification confirms or refutes them.');
}
