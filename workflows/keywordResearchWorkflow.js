'use strict';

// The ordered process that turns a product/category into a concise, evidence-based set
// of agent/core/seoResearchModel.js keyword records. Composes agent/core/productModel.js
// (the product/category being researched), agent/core/customerSegmentResearchModel.js
// (customer intent signals), agent/core/seoResearchModel.js (the structured per-keyword
// output shape), and agent/core/researchRecordModel.js (the evidence convention) - a
// multi-step process combining existing capability modules, which is what workflows/
// is for.
//
// No search volume or competition metric is invented anywhere in this workflow -
// agent/core/seoResearchModel.js has no numeric metric field to fabricate a value into,
// and every stage below draws only on cited evidence. Where no real data exists for a
// field, it is marked unavailable (or left at its unassessed/empty default), never
// guessed. This workflow stops once the structured seoResearchModel.js result is
// produced - no stage ranks, scores, or decides anything.
const KEYWORD_RESEARCH_STAGES = [
  {
    id: 'understand_product_category',
    title: 'Understand the product/category',
    description:
      'Establish the product/category this keyword research is for, grounded in agent/core/productModel.js (product_identity, category) or configuration/business.yaml product_categories - never invented.',
  },
  {
    id: 'identify_customer_intent',
    title: 'Identify customer intent',
    description:
      'Identify the customer intent(s) relevant to that product/category, informed by agent/core/customerSegmentResearchModel.js (needs, problems, buying_motivations) where available.',
  },
  {
    id: 'identify_relevant_keywords',
    title: 'Identify relevant keywords',
    description:
      'Surface candidate keywords relevant to the product/category and identified intents, each eventually recorded as an agent/core/seoResearchModel.js record (keyword, search_intent). No search volume or competition metric is invented at this stage.',
  },
  {
    id: 'group_keywords_by_intent',
    title: 'Group keywords by intent',
    description:
      'Group the identified keywords by their agent/core/seoResearchModel.js search_intent value, so the result reflects intent clusters, not a flat list.',
  },
  {
    id: 'identify_opportunities',
    title: 'Identify opportunities',
    description:
      'Assess each keyword/group for opportunity (agent/core/seoResearchModel.js opportunity, competition) using only real, cited evidence - never a fabricated numeric search-volume/competition metric. Where no real data exists, the field is marked unavailable, not guessed.',
  },
  {
    id: 'record_evidence',
    title: 'Record evidence',
    description:
      "Record the source/evidence backing each keyword's assessment (agent/core/seoResearchModel.js source, research_date), following agent/core/researchRecordModel.js's evidence convention.",
  },
  {
    id: 'produce_structured_result',
    title: 'Produce a concise structured result',
    description:
      "Compile the grouped, evidence-backed keywords into a concise structured result - a set of agent/core/seoResearchModel.js records - leaving confidence/relevance at 'unassessed' and any other field marked unavailable wherever real data was missing - never assumed.",
  },
];

function getKeywordResearchWorkflow() {
  return KEYWORD_RESEARCH_STAGES;
}

module.exports = {
  KEYWORD_RESEARCH_STAGES,
  getKeywordResearchWorkflow,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - keyword research workflow (conceptual only):\n');
  KEYWORD_RESEARCH_STAGES.forEach((stage, index) => {
    console.log(`${index + 1}. [${stage.id}] ${stage.title}`);
    console.log(`   ${stage.description}`);
  });
  console.log('\nNo search volume or competition metric is invented anywhere in this workflow.');
  console.log('Unavailable data is marked unavailable, never guessed - no automated ranking, scoring, or decision is produced.');
}
