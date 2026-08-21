'use strict';

const fs = require('fs');
const path = require('path');

// The ONE agent must never be handed everything (full conversation history, the whole
// project, the entire product catalog, all memory, the full research database, all
// business data, or the whole tool registry) on every task. This defines WHERE each
// kind of context lives so a future retrieval step can pull only the relevant slice.
// This is a boundary map only - it does not implement retrieval, filtering, ranking,
// or search. See agent/core/agentContract.js for the lifecycle stages that will
// eventually use these boundaries (inspect_configuration, retrieve_context,
// inspect_memory_state, select_tools).
const CONTEXT_BOUNDARIES = [
  {
    id: 'task_context',
    title: 'Task context',
    locations: ['data/tasks/'],
    description:
      "The current task's own transient working data - not other tasks', and not the full conversation history.",
  },
  {
    id: 'business_context',
    title: 'Business context',
    locations: ['configuration/', 'data/business/'],
    description:
      "This business's settings (configuration/business.yaml, once configured) and operational data (excluding its product catalog, which has its own boundary) - never another business's, never the full config of every business.",
  },
  {
    id: 'product_context',
    title: 'Product context',
    locations: ['data/products/'],
    description:
      "This business's product catalog, retrieved as a relevant slice (a product, a category) - never the entire catalog at once.",
  },
  {
    id: 'research_context',
    title: 'Research context',
    locations: ['research/'],
    description:
      'Gathered market/competitor/trend research relevant to the current task - not the full research database.',
  },
  {
    id: 'memory_context',
    title: 'Memory context',
    locations: ['memory/state/'],
    description:
      "Persisted state relevant to the current task and business - not all memory across every business or session.",
  },
  {
    id: 'tool_context',
    title: 'Tool context',
    locations: ['tools/'],
    description:
      'Only the tool definition(s) selected for the current task - not the entire tool registry.',
  },
];

function getContextBoundaries() {
  return CONTEXT_BOUNDARIES;
}

module.exports = { CONTEXT_BOUNDARIES, getContextBoundaries };

if (require.main === module) {
  const repoRoot = path.join(__dirname, '..', '..');
  console.log('Smart E-Commerce Growth AI Agent - context boundaries (organizational only):\n');
  CONTEXT_BOUNDARIES.forEach((boundary, index) => {
    console.log(`${index + 1}. [${boundary.id}] ${boundary.title}`);
    for (const location of boundary.locations) {
      const exists = fs.existsSync(path.join(repoRoot, location));
      console.log(`   location: ${location} (${exists ? 'exists' : 'MISSING'})`);
    }
    console.log(`   ${boundary.description}`);
  });
}
