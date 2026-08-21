'use strict';

// The ordered process that turns gathered evidence into a structured product opportunity
// analysis. Composes products/productResearchArchitecture.js (how evidence gets
// gathered) with agent/core/opportunityAnalysisModel.js (the structured output shape) and
// agent/core/researchRecordModel.js (the evidence/finding shape) - a multi-step process
// combining existing capability modules, which is what workflows/ is for.
//
// This workflow stops once the structured opportunityAnalysisModel.js record is
// produced. No stage here scores, ranks, or decides anything - no automated
// recommendation/verdict. That is left to a later, explicitly-scoped prompt, or to a
// human via approvals/.
const PRODUCT_OPPORTUNITY_ANALYSIS_STAGES = [
  {
    id: 'assess_demand',
    title: 'Assess demand',
    description:
      'Evaluate customer demand for the candidate using evidence gathered so far (products/productResearchArchitecture.js identify_demand_signals), producing agent/core/opportunityAnalysisModel.js demand.',
  },
  {
    id: 'assess_competition',
    title: 'Assess competition',
    description:
      'Evaluate existing competitors or alternatives using evidence gathered so far (products/productResearchArchitecture.js identify_competition), producing agent/core/opportunityAnalysisModel.js competition.',
  },
  {
    id: 'assess_customer_fit',
    title: 'Assess customer fit',
    description:
      "Evaluate fit with the business's target customer (agent/core/productModel.js target_customer), producing agent/core/opportunityAnalysisModel.js customer_fit.",
  },
  {
    id: 'assess_differentiation',
    title: 'Assess differentiation',
    description:
      'Evaluate how the candidate differs from existing alternatives identified during assess_competition, producing agent/core/opportunityAnalysisModel.js differentiation.',
  },
  {
    id: 'assess_market_relevance',
    title: 'Assess market relevance',
    description:
      "Evaluate fit with the business's target markets (configuration/business.yaml; agent/core/productModel.js market), using products/productResearchArchitecture.js identify_market_fit, producing agent/core/opportunityAnalysisModel.js market_relevance.",
  },
  {
    id: 'assess_commercial_potential',
    title: 'Assess commercial potential',
    description:
      "Evaluate the candidate's commercial potential using the evidence gathered so far, producing agent/core/opportunityAnalysisModel.js commercial_potential.",
  },
  {
    id: 'assess_risks',
    title: 'Assess risks',
    description:
      'Evaluate risks identified for the candidate using the evidence gathered so far, producing agent/core/opportunityAnalysisModel.js risks.',
  },
  {
    id: 'assess_evidence_quality',
    title: 'Assess evidence quality',
    description:
      'Evaluate how strong and complete the evidence backing the above assessments is (agent/core/researchRecordModel.js confidence/verification_status across the records used), producing agent/core/opportunityAnalysisModel.js evidence_quality.',
  },
];

function getProductOpportunityAnalysisWorkflow() {
  return PRODUCT_OPPORTUNITY_ANALYSIS_STAGES;
}

module.exports = {
  PRODUCT_OPPORTUNITY_ANALYSIS_STAGES,
  getProductOpportunityAnalysisWorkflow,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - product opportunity analysis workflow (conceptual only):\n');
  PRODUCT_OPPORTUNITY_ANALYSIS_STAGES.forEach((stage, index) => {
    console.log(`${index + 1}. [${stage.id}] ${stage.title}`);
    console.log(`   ${stage.description}`);
  });
  console.log('\nNo automated recommendation, score, or verdict is produced - only the structured,');
  console.log('evidence-based agent/core/opportunityAnalysisModel.js record.');
}
