'use strict';

// The ordered process that connects a product to a content recommendation:
// PRODUCT -> CUSTOMER -> PROBLEM/NEED -> SEARCH/INTEREST -> CONTENT OPPORTUNITY ->
// CONTENT RECOMMENDATION -> VERIFICATION. Composes agent/core/productModel.js,
// agent/core/customerSegmentResearchModel.js, agent/core/seoResearchModel.js,
// agent/core/marketingAnalysisModel.js, and agent/core/researchRecordModel.js - a
// multi-step process combining existing capability modules, which is what workflows/
// is for.
//
// Nothing here publishes anything - there is no publish/post/send function anywhere
// in this file to gate. Turning a content recommendation into a real, published piece
// of content is a separate, human-approved action via approvals/ (see
// approvals/README.md), never automatic. No business fact (about the product, the
// customer, or their problems) is invented anywhere - every stage below only
// references existing records; none is fabricated here.
const CONTENT_MARKETING_STAGES = [
  {
    id: 'understand_product',
    title: 'PRODUCT - Understand the product',
    description:
      'Establish which product this content marketing work is for, grounded in agent/core/productModel.js (product_identity, category, target_customer) - never invented.',
  },
  {
    id: 'identify_customer',
    title: 'CUSTOMER - Identify the customer',
    description:
      "Identify the customer segment this product's content should reach, grounded in agent/core/productModel.js target_customer and agent/core/customerSegmentResearchModel.js (segment_definition) - never invented.",
  },
  {
    id: 'identify_problem_or_need',
    title: 'PROBLEM/NEED - Identify the problem or need',
    description:
      'Identify the customer problem or need this content should address, drawn from agent/core/customerSegmentResearchModel.js (needs, problems) - never invented.',
  },
  {
    id: 'identify_search_interest',
    title: 'SEARCH/INTEREST - Identify search interest',
    description:
      'Identify what the customer searches for or is interested in related to that problem/need, recorded as agent/core/seoResearchModel.js records (keyword, search_intent).',
  },
  {
    id: 'identify_content_opportunity',
    title: 'CONTENT OPPORTUNITY - Identify the content opportunity',
    description:
      'Identify a content opportunity connecting the search/interest signals to the product, using only real, cited evidence (agent/core/seoResearchModel.js opportunity) - never a fabricated business fact.',
  },
  {
    id: 'produce_content_recommendation',
    title: 'CONTENT RECOMMENDATION - Produce a content recommendation',
    description:
      "Produce a concise content recommendation (angle, message) for the opportunity, shaped like agent/core/marketingAnalysisModel.js's message/objective fields. A recommendation only - nothing here publishes it; publishing any content is a separate, human-approved action via approvals/.",
  },
  {
    id: 'verify_recommendation',
    title: 'VERIFICATION - Verify the recommendation',
    description:
      "Verify the recommendation is grounded in real evidence gathered across the prior stages before it is used, following agent/core/researchRecordModel.js's confidence/verification_status convention - stays unverified/unassessed until real evidence supports otherwise.",
  },
];

function getContentMarketingWorkflow() {
  return CONTENT_MARKETING_STAGES;
}

module.exports = {
  CONTENT_MARKETING_STAGES,
  getContentMarketingWorkflow,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - content marketing workflow (conceptual only):\n');
  CONTENT_MARKETING_STAGES.forEach((stage, index) => {
    console.log(`${index + 1}. [${stage.id}] ${stage.title}`);
    console.log(`   ${stage.description}`);
  });
  console.log('\nNo business fact is invented anywhere in this workflow, and nothing here is ever');
  console.log('published automatically - publishing content requires a separate, human-approved action.');
}
