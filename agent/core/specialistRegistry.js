'use strict';

// The registry of specialist agents the Chief/Orchestrator may eventually delegate
// to (CLAUDE.md section 2: 1 Orchestrator + 7 controlled specialist agents/modules).
// This is a registry FOUNDATION only, mirroring tools/toolRegistry.js's pattern: a
// descriptive list plus small read-only lookup helpers - there is no
// select/dispatch/execute logic anywhere in this file. 'research' is now the first
// implemented specialist (see agent/core/researchAgent.js, connected to the tool
// system via tools/marketResearchTool.js, tools/competitorResearchTool.js, and
// tools/customerResearchTool.js) - the other 6 specialists remain 'not_implemented',
// with only the schema/pipeline foundations described in agent/core/*Model.js and
// workflows/*.js.
//
// This is a single shared list for the Orchestrator to select from - it does not
// itself select anything. See agent/core/orchestratorExecutionContract.js's
// selectSpecialist(), which this registry exists to support.

const SPECIALIST_STATUSES = ['not_implemented', 'implemented'];

const SPECIALIST_REGISTRY = [
  {
    id: 'research',
    title: 'Research',
    description: 'Market, competitor, and customer/market-intelligence research.',
    status: 'implemented',
  },
  {
    id: 'product',
    title: 'Product',
    description: 'Product catalog analysis and opportunity research.',
    status: 'not_implemented',
  },
  {
    id: 'seo',
    title: 'SEO',
    description: 'Search visibility analysis and keyword research.',
    status: 'not_implemented',
  },
  {
    id: 'listing',
    title: 'Listing',
    description: 'Product listing content and optimization.',
    status: 'not_implemented',
  },
  {
    id: 'marketing',
    title: 'Marketing',
    description: 'Campaign ideas, copy, and marketing strategy.',
    status: 'not_implemented',
  },
  {
    id: 'social_advertising',
    title: 'Social & Advertising',
    description: 'Social media and paid advertising.',
    status: 'not_implemented',
  },
  {
    id: 'analytics_optimization',
    title: 'Analytics & Optimization',
    description: 'Store performance, growth metrics, and optimization recommendations.',
    status: 'not_implemented',
  },
];

function getSpecialistRegistry() {
  return SPECIALIST_REGISTRY;
}

function getSpecialistById(id) {
  return SPECIALIST_REGISTRY.find((specialist) => specialist.id === id);
}

function getSpecialistsByStatus(status) {
  return SPECIALIST_REGISTRY.filter((specialist) => specialist.status === status);
}

module.exports = {
  SPECIALIST_STATUSES,
  SPECIALIST_REGISTRY,
  getSpecialistRegistry,
  getSpecialistById,
  getSpecialistsByStatus,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - specialist registry (foundation only):\n');
  for (const specialist of SPECIALIST_REGISTRY) {
    console.log(`  - ${specialist.id} (${specialist.status}): ${specialist.title}`);
    console.log(`      ${specialist.description}`);
  }
  const implementedCount = getSpecialistsByStatus('implemented').length;
  console.log(`\n${SPECIALIST_REGISTRY.length} specialists registered, ${implementedCount} implemented - registry foundation only.`);
  console.log('No specialist is ever called from this file - there is no select/dispatch logic here.');
}
