'use strict';

// The ordered conceptual pipeline of a future product research capability - a
// specialization of the ONE agent's product work, living here (not agent/core/)
// because it's a capability module, per CLAUDE.md's "every capability is a module
// living under the relevant top-level folder."
//
// This defines WHAT the capability conceptually does, and in what order - not HOW,
// mirroring agent/core/agentContract.js. No stage here performs real work: no HTTP
// calls, no external research API, no scraping. No external source is configured
// today - if/when one is, that configuration would be added explicitly by a later,
// scoped prompt, not invented here. No stage fabricates results: where a stage would
// eventually produce a finding, it does so through
// agent/core/researchRecordModel.js's existing confidence/verification_status fields,
// which default to 'unassessed'/'unverified' until real evidence supports otherwise.
const PRODUCT_RESEARCH_STAGES = [
  {
    id: 'discover_opportunities',
    title: 'Discover product opportunities',
    description:
      'Surface candidate product opportunities worth evaluating. Each candidate is shaped like an agent/core/productModel.js record, starting with research_status: "not_researched".',
  },
  {
    id: 'collect_evidence',
    title: 'Collect evidence',
    description:
      "Gather supporting evidence for a candidate opportunity, recorded as agent/core/researchRecordModel.js records (source, finding). Only uses sources explicitly present in configuration - none is configured today, so this stage has nothing to call yet.",
  },
  {
    id: 'compare_opportunities',
    title: 'Compare opportunities',
    description:
      'Compare multiple candidate opportunities against each other using the evidence collected so far - a cross-opportunity judgment, not a single-opportunity one.',
  },
  {
    id: 'identify_demand_signals',
    title: 'Identify demand signals',
    description:
      'Identify signals indicating customer demand for a candidate opportunity, recorded as evidence (agent/core/researchRecordModel.js finding).',
  },
  {
    id: 'identify_competition',
    title: 'Identify competition',
    description:
      'Identify existing competitors or alternatives for a candidate opportunity, recorded as evidence (agent/core/researchRecordModel.js finding).',
  },
  {
    id: 'identify_market_fit',
    title: 'Identify market fit',
    description:
      "Assess how well a candidate opportunity fits the business's target markets and customers (configuration/business.yaml; agent/core/productModel.js market/target_customer).",
  },
  {
    id: 'record_confidence',
    title: 'Record confidence',
    description:
      "Record how confident the findings are (agent/core/researchRecordModel.js confidence) - never fabricated or assumed. Stays 'unassessed' until real evidence supports a higher confidence level.",
  },
];

function getProductResearchArchitecture() {
  return PRODUCT_RESEARCH_STAGES;
}

module.exports = { PRODUCT_RESEARCH_STAGES, getProductResearchArchitecture };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - product research architecture (conceptual only):\n');
  PRODUCT_RESEARCH_STAGES.forEach((stage, index) => {
    console.log(`${index + 1}. [${stage.id}] ${stage.title}`);
    console.log(`   ${stage.description}`);
  });
  console.log('\nNo external research API is called and no source is configured today.');
  console.log('No result here is fabricated - findings stay unassessed/unverified until real evidence exists.');
}
