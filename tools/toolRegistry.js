'use strict';

// The registry of tools the Chief/Orchestrator may call. This is a registry
// FOUNDATION plus two real, callable tools: a descriptive list plus small read-only
// lookup helpers - there is still no register/execute/dispatch function anywhere in
// this file (that lives in agent/core/orchestratorExecutionContract.js, gated by
// agent/core/toolPermissions.js), so tools are not called *from here*.
// business_configuration_retrieval and ai_reasoning_completion are the two entries
// actually implemented (see tools/businessConfigurationRetrieval.js and
// tools/aiReasoningCompletion.js) - the other 11 tools remain 'not_implemented'.
//
// This is a single shared list for the ONE agent - every entry is a capability that
// agent can eventually use, never a separate agent, persona, or system prompt. See
// agent/core/agentContract.js's select_tools stage, which this registry exists to
// support.

const TOOL_CATEGORIES = [
  'configuration',
  'products',
  'research',
  'customer_market_intelligence',
  'seo',
  'marketing',
  'analytics',
  'ai_reasoning',
  'memory',
  'verification',
];

const TOOL_STATUSES = ['not_implemented', 'implemented'];

const TOOL_REGISTRY = [
  {
    id: 'business_configuration_retrieval',
    title: 'Business configuration retrieval',
    description:
      "Retrieve the connected Shopify store's shop identity (name, domain, email) via integrations/adapters/shopifyClient.js's getShopInfo() - see tools/businessConfigurationRetrieval.js.",
    category: 'configuration',
    status: 'implemented',
  },
  {
    id: 'product_data_retrieval',
    title: 'Product data retrieval',
    description:
      'Retrieve product data conforming to agent/core/productModel.js from data/products/.',
    category: 'products',
    status: 'not_implemented',
  },
  {
    id: 'product_research',
    title: 'Product research',
    description:
      'Run product research per the products/productResearchArchitecture.js pipeline.',
    category: 'products',
    status: 'not_implemented',
  },
  {
    id: 'market_research',
    title: 'Market research',
    description:
      'Produce market research records conforming to agent/core/marketResearchModel.js.',
    category: 'research',
    status: 'not_implemented',
  },
  {
    id: 'customer_research',
    title: 'Customer research',
    description:
      'Produce customer segment research records conforming to agent/core/customerSegmentResearchModel.js.',
    category: 'customer_market_intelligence',
    status: 'not_implemented',
  },
  {
    id: 'competitor_research',
    title: 'Competitor research',
    description:
      'Produce competitor research records conforming to agent/core/competitorResearchModel.js.',
    category: 'research',
    status: 'not_implemented',
  },
  {
    id: 'keyword_research',
    title: 'Keyword research',
    description:
      'Run the workflows/keywordResearchWorkflow.js pipeline to produce agent/core/seoResearchModel.js records.',
    category: 'seo',
    status: 'not_implemented',
  },
  {
    id: 'seo_analysis',
    title: 'SEO analysis',
    description:
      'Analyze listing SEO/optimization opportunities per agent/core/listingOptimizationModel.js.',
    category: 'seo',
    status: 'not_implemented',
  },
  {
    id: 'marketing_analysis',
    title: 'Marketing analysis',
    description:
      'Produce marketing analysis records conforming to agent/core/marketingAnalysisModel.js.',
    category: 'marketing',
    status: 'not_implemented',
  },
  {
    id: 'analytics',
    title: 'Analytics',
    description:
      'Retrieve or compute store performance/growth metrics (see analytics/README.md).',
    category: 'analytics',
    status: 'not_implemented',
  },
  {
    id: 'ai_reasoning_completion',
    title: 'AI reasoning completion',
    description:
      "Run one structured Claude completion (instruction + optional context) via agent/core/claudeClient.js's sendMessage() - see tools/aiReasoningCompletion.js. Every call is capped/budgeted by agent/core/tokenControls.js.",
    category: 'ai_reasoning',
    status: 'implemented',
  },
  {
    id: 'memory_retrieval',
    title: 'Memory retrieval',
    description:
      'Retrieve persisted state from memory/state/ per agent/core/memoryRules.js and agent/core/stateModel.js.',
    category: 'memory',
    status: 'not_implemented',
  },
  {
    id: 'verification',
    title: 'Verification',
    description:
      "Verify results/evidence per agent/core/researchRecordModel.js's confidence/verification_status convention and the agent contract's verify_results stage.",
    category: 'verification',
    status: 'not_implemented',
  },
];

function getToolRegistry() {
  return TOOL_REGISTRY;
}

function getToolById(id) {
  return TOOL_REGISTRY.find((tool) => tool.id === id);
}

function getToolsByCategory(category) {
  return TOOL_REGISTRY.filter((tool) => tool.category === category);
}

function getToolsByStatus(status) {
  return TOOL_REGISTRY.filter((tool) => tool.status === status);
}

module.exports = {
  TOOL_CATEGORIES,
  TOOL_STATUSES,
  TOOL_REGISTRY,
  getToolRegistry,
  getToolById,
  getToolsByCategory,
  getToolsByStatus,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - tool registry (foundation only):\n');
  for (const category of TOOL_CATEGORIES) {
    const toolsInCategory = getToolsByCategory(category);
    if (toolsInCategory.length === 0) continue;
    console.log(`[${category}]`);
    for (const tool of toolsInCategory) {
      console.log(`  - ${tool.id} (${tool.status}): ${tool.title}`);
      console.log(`      ${tool.description}`);
    }
  }
  const implementedCount = getToolsByStatus('implemented').length;
  console.log(`\n${TOOL_REGISTRY.length} tools registered, ${implementedCount} implemented - registry foundation only.`);
  console.log('No tool is ever called from this file - dispatch lives in agent/core/orchestratorExecutionContract.js, gated by agent/core/toolPermissions.js.');
}
