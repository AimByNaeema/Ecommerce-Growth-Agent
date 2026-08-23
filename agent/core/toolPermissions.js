'use strict';

// Connects the Chief/Orchestrator to tools/toolRegistry.js and
// approvals/approvalArchitecture.js: for a given (specialist, tool) pair, determines
// whether the tool is available, whether that specialist has permission to use it, and
// whether approval is required - before anything is executed. This is CLAUDE.md
// section 3's "Permissions" shared infrastructure component: least-privilege access
// control, so a specialist only gets the tools its own domain actually owns.
//
// This module makes zero execution decisions of its own - no I/O, no tool calls. The
// Chief/Orchestrator (agent/core/orchestratorExecutionContract.js) must go through
// checkToolAccess() before ever invoking a tool executor; there is no separate,
// unguarded execution path. That is what "do not give the Chief unrestricted
// execution access" means in practice: every real dispatch is gated here first.

const { getToolById } = require('../../tools/toolRegistry');
const { TOOL_CATEGORIES } = require('../../tools/toolRegistry');

// Which TOOL_REGISTRY category each of the 7 approved specialists (see
// agent/core/specialistRegistry.js) is permitted to use. Categories not listed here
// (configuration, memory, verification) are shared infrastructure - handled directly
// by the orchestrator, not owned by any specialist (CLAUDE.md section 3). 'listing'
// and 'social_advertising' have no category in TOOL_REGISTRY today, so neither
// specialist is granted any tool category yet - a real, honest gap, not an oversight.
const CATEGORY_TO_SPECIALIST = {
  products: 'product',
  research: 'research',
  customer_market_intelligence: 'research',
  seo: 'seo',
  marketing: 'marketing',
  analytics: 'analytics_optimization',
};

// The reverse of CATEGORY_TO_SPECIALIST: which categories (if any) a given specialist
// is permitted to use. Derived, not duplicated data.
const SPECIALIST_TO_CATEGORIES = Object.entries(CATEGORY_TO_SPECIALIST).reduce(
  (map, [category, specialistId]) => {
    if (!map[specialistId]) map[specialistId] = [];
    map[specialistId].push(category);
    return map;
  },
  {}
);

// The TOOL_CATEGORIES not owned by any specialist - handled by the orchestrator
// itself (a null/absent specialistId in checkToolAccess).
const SHARED_INFRASTRUCTURE_CATEGORIES = TOOL_CATEGORIES.filter(
  (category) => !(category in CATEGORY_TO_SPECIALIST)
);

// business_configuration_retrieval is a read-only GET against Shopify (no writes, no
// side effects) - classified analysis_only. ai_reasoning_completion only ever
// produces a draft/suggestion for a human to consider (see
// approvals/approvalArchitecture.js's own description of 'recommendation':
// "producing the suggestion needs no approval; acting on it does") - it never
// publishes, sends, or changes anything by itself, so generating the text needs no
// approval even though a future action built on it might. Both are distinct from a
// future write-capable tool that would need approval_required/externally_executable.
// A tool with no entry here is treated as requiring approval by default (never
// silently auto-approved) - see APPROVAL_POLICY_RULES's 'approval_required_by_default'
// rule in approvals/approvalArchitecture.js.
const TOOL_CLASSIFICATIONS = {
  business_configuration_retrieval: 'analysis_only',
  ai_reasoning_completion: 'recommendation',
};

// Approval classifications that may proceed automatically. Anything else
// (approval_required, externally_executable, or no classification at all) must stop
// and surface an approval requirement rather than execute.
const AUTO_APPROVED_CLASSIFICATIONS = ['analysis_only', 'recommendation'];

// Whether a specialist (by id) is permitted to use a given TOOL_REGISTRY category.
// specialistId === null represents the orchestrator's own shared-infrastructure
// access, not a specialist - it is only permitted for SHARED_INFRASTRUCTURE_CATEGORIES.
function isSpecialistPermittedForCategory(specialistId, category) {
  if (specialistId === null || specialistId === undefined) {
    return SHARED_INFRASTRUCTURE_CATEGORIES.includes(category);
  }
  const permittedCategories = SPECIALIST_TO_CATEGORIES[specialistId] || [];
  return permittedCategories.includes(category);
}

// The pure decision function: given an already-resolved tool (or null) and its
// approval classification, decides availability -> permission -> approval, in that
// order (an unavailable tool can't meaningfully be "permitted"; a permitted tool may
// still need approval). Exported directly (not just via checkToolAccess) so it can be
// exercised against tool shapes tools/toolRegistry.js does not currently contain any
// example of yet - today's only implemented tool happens to be auto-approved, so
// there is no real approval_required tool to test end-to-end against; this keeps that
// branch honestly testable without inventing a new tool in the registry.
function evaluateToolAccess({ specialistId, tool, classification = null }) {
  if (!tool) {
    return {
      tool_id: null,
      available: false,
      permitted: false,
      approval_required: null,
      classification: null,
      decision: 'unavailable',
      reason: 'Unknown tool.',
    };
  }

  const available = tool.status === 'implemented';
  if (!available) {
    return {
      tool_id: tool.id,
      available: false,
      permitted: null,
      approval_required: null,
      classification: null,
      decision: 'unavailable',
      reason: `Tool '${tool.id}' is registered but not yet implemented.`,
    };
  }

  const permitted = isSpecialistPermittedForCategory(specialistId, tool.category);
  if (!permitted) {
    return {
      tool_id: tool.id,
      available: true,
      permitted: false,
      approval_required: null,
      classification: null,
      decision: 'denied',
      reason: `Specialist '${specialistId || '(shared infrastructure)'}' is not permitted to use tools in category '${tool.category}'.`,
    };
  }

  const approvalRequired = !classification || !AUTO_APPROVED_CLASSIFICATIONS.includes(classification);
  if (approvalRequired) {
    return {
      tool_id: tool.id,
      available: true,
      permitted: true,
      approval_required: true,
      classification: classification || null,
      decision: 'approval_required',
      reason: `Executing '${tool.id}' requires explicit approval before it can proceed.`,
    };
  }

  return {
    tool_id: tool.id,
    available: true,
    permitted: true,
    approval_required: false,
    classification,
    decision: 'allowed',
    reason: null,
  };
}

// The real, registry-backed API: resolves the tool by id (tools/toolRegistry.js) and
// its classification (TOOL_CLASSIFICATIONS above), then delegates to
// evaluateToolAccess(). This is what agent/core/orchestratorExecutionContract.js calls
// before ever executing a tool.
function checkToolAccess({ specialistId, toolId }) {
  const tool = getToolById(toolId);
  const classification = tool ? (TOOL_CLASSIFICATIONS[tool.id] || null) : null;
  return evaluateToolAccess({ specialistId, tool, classification });
}

module.exports = {
  CATEGORY_TO_SPECIALIST,
  SPECIALIST_TO_CATEGORIES,
  SHARED_INFRASTRUCTURE_CATEGORIES,
  TOOL_CLASSIFICATIONS,
  AUTO_APPROVED_CLASSIFICATIONS,
  isSpecialistPermittedForCategory,
  evaluateToolAccess,
  checkToolAccess,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - tool permissions (Chief/Orchestrator access control):\n');
  const examples = [
    { specialistId: null, toolId: 'business_configuration_retrieval' },
    { specialistId: 'marketing', toolId: 'business_configuration_retrieval' },
    { specialistId: 'product', toolId: 'product_research' },
    { specialistId: 'seo', toolId: 'not_a_real_tool' },
  ];
  for (const example of examples) {
    const result = checkToolAccess(example);
    console.log(`checkToolAccess(${JSON.stringify(example)}) ->`);
    console.log(`  decision: ${result.decision}${result.reason ? ` (${result.reason})` : ''}`);
  }
}
