'use strict';

// Connects the Chief/Orchestrator to tools/toolRegistry.js and
// approvals/approvalArchitecture.js: for a given (specialist, tool) pair, determines
// whether the tool is available, whether that specialist has permission to use it, and
// whether approval is required - before anything is executed. This is CLAUDE.md
// section 3's "Permissions" shared infrastructure component: least-privilege access
// control, so a specialist only gets the tools its own domain actually owns.
//
// ROLE-BASED PERMISSIONS (READ/WRITE/EXECUTE): permission is now two independent
// gates, both required. (1) CATEGORY ownership (CATEGORY_TO_SPECIALIST/
// SPECIALIST_TO_CATEGORIES below) - which tool DOMAINS a specialist may touch at all.
// (2) ROLE operation permission (SPECIALIST_ROLE_PERMISSIONS below) - which
// tools/toolRegistry.js `operation` types ('read'/'write'/'execute') that specialist's
// role covers. A specialist can be denied a tool it would otherwise own by category if
// that tool's operation type falls outside its role - e.g. a hypothetical 'write'
// tool added to the 'research' category would still be denied to Research, whose role
// is READ-only, catching future mis-assigned tools rather than only checking today's
// actual tool set. This is a real, additional least-privilege boundary, not a
// restatement of category ownership.
//
// This module makes zero execution decisions of its own - no I/O, no tool calls. The
// Chief/Orchestrator (agent/core/orchestratorExecutionContract.js) must go through
// checkToolAccess() before ever invoking a tool executor; there is no separate,
// unguarded execution path. That is what "do not give the Chief unrestricted
// execution access" means in practice: every real dispatch is gated here first -
// availability, then category, then role/operation, then approval, always in that
// order, always before agent/core/orchestratorExecutionContract.js's TOOL_EXECUTORS is
// ever read.

const { getToolById } = require('../../tools/toolRegistry');
const { TOOL_CATEGORIES } = require('../../tools/toolRegistry');
const { AUTO_APPROVED_CLASSIFICATIONS, requiresApproval } = require('../../approvals/approvalArchitecture');

// Which TOOL_REGISTRY category each of the 7 approved specialists (see
// agent/core/specialistRegistry.js) is permitted to use. Categories not listed here
// (configuration, memory, verification) are shared infrastructure - handled directly
// by the orchestrator, not owned by any specialist (CLAUDE.md section 3).
const CATEGORY_TO_SPECIALIST = {
  products: 'product',
  research: 'research',
  customer_market_intelligence: 'research',
  seo: 'seo',
  listing: 'listing',
  marketing: 'marketing',
  social_advertising: 'social_advertising',
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

// business_configuration_retrieval, product_data_retrieval, and
// collection_data_retrieval are read-only GETs against Shopify (no writes, no side
// effects) - all three classified analysis_only.
// ai_reasoning_completion only ever produces a draft/suggestion for a human to
// consider (see
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
  market_research: 'analysis_only',
  competitor_research: 'analysis_only',
  customer_research: 'analysis_only',
  product_data_retrieval: 'analysis_only',
  collection_data_retrieval: 'analysis_only',
  keyword_research: 'analysis_only',
  seo_analysis: 'analysis_only',
  listing_content_generation: 'analysis_only',
  marketing_analysis: 'analysis_only',
  social_content_planning: 'analysis_only',
  paid_advertising_planning: 'analysis_only',
  social_media_strategy_generation: 'analysis_only',
  platform_content_generation: 'analysis_only',
  content_calendar_generation: 'analysis_only',
  advertising_strategy_planning: 'analysis_only',
  advertising_performance_analysis: 'analysis_only',
  analytics: 'analysis_only',
  analytics_data_retrieval: 'analysis_only',
};

// Which tools/toolRegistry.js `operation` types ('read'/'write'/'execute') each of
// the 7 approved specialists' ROLE covers - independent of, and in addition to,
// CATEGORY_TO_SPECIALIST above. Hand-declared (not derived from today's tool set) so
// it acts as a real ceiling: it reflects what each specialist's role actually needs to
// do, and would deny a future tool added to an owned category if that tool's
// operation falls outside the role, rather than silently expanding to match whatever
// tools happen to exist.
const SPECIALIST_ROLE_PERMISSIONS = {
  // Research: market/competitor/customer research and analysis only - never authors
  // new marketable content, never calls an external system.
  research: ['read'],
  // Product: catalog/opportunity analysis and scoring - reads and evaluates existing
  // product data; authoring new listing content is Listing's role, not Product's.
  product: ['read'],
  // SEO: keyword research and on-page SEO analysis - diagnostic only; it informs
  // Listing's content rewrites but never edits content itself.
  seo: ['read'],
  // Listing: its entire role is authoring new listing content and marketplace
  // formats - a pure content-creation role with no analysis tools of its own.
  listing: ['write'],
  // Marketing: its entire role is composing marketing strategy/campaign/offer
  // content - a content-creation role.
  marketing: ['write'],
  // Social & Advertising: composes social/ad content and strategy ('write') but also
  // analyzes past advertising performance ('read') - the one role needing both today.
  social_advertising: ['read', 'write'],
  // Analytics & Optimization: reads/analyzes store performance data - never authors
  // new marketable content itself.
  analytics_optimization: ['read'],
};

// The orchestrator's own shared-infrastructure access (specialistId === null) - not a
// specialist role. Needs 'read' (business_configuration_retrieval, the not-yet-
// implemented memory_retrieval/verification) and 'write' (ai_reasoning_completion, a
// drafted completion). No shared-infrastructure tool is 'execute' today.
const SHARED_INFRASTRUCTURE_ROLE_PERMISSIONS = ['read', 'write'];

// Whether a specialist's role (by id) covers a given tool operation type. Mirrors
// isSpecialistPermittedForCategory's null-handling exactly: specialistId === null is
// the orchestrator's own shared-infrastructure access, not a specialist.
function isOperationPermittedForSpecialist(specialistId, operation) {
  if (specialistId === null || specialistId === undefined) {
    return SHARED_INFRASTRUCTURE_ROLE_PERMISSIONS.includes(operation);
  }
  const allowedOperations = SPECIALIST_ROLE_PERMISSIONS[specialistId] || [];
  return allowedOperations.includes(operation);
}

// AUTO_APPROVED_CLASSIFICATIONS and requiresApproval() are imported from
// approvals/approvalArchitecture.js above - that module is now the single source of
// truth for which classifications may proceed automatically (the
// 'approval_required_by_default' policy rule), reused here rather than duplicated.
// AUTO_APPROVED_CLASSIFICATIONS is re-exported below unchanged so existing callers of
// this module keep working.

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
// approval classification, decides availability -> category permission -> role
// (operation) permission -> approval, in that order (an unavailable tool can't
// meaningfully be "permitted"; a category-permitted tool may still be denied by role;
// a fully permitted tool may still need approval). Exported directly (not just via
// checkToolAccess) so it can be exercised against tool shapes tools/toolRegistry.js
// does not currently contain any example of yet - e.g. every real, implemented tool
// today happens to already fall inside its owning specialist's role, so there is no
// real role-denied or approval_required tool to test end-to-end against; this keeps
// those branches honestly testable without inventing a new tool in the registry.
function evaluateToolAccess({ specialistId, tool, classification = null }) {
  if (!tool) {
    return {
      tool_id: null,
      available: false,
      category_permitted: null,
      operation_permitted: null,
      permitted: false,
      operation: null,
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
      category_permitted: null,
      operation_permitted: null,
      permitted: null,
      operation: tool.operation || null,
      approval_required: null,
      classification: null,
      decision: 'unavailable',
      reason: `Tool '${tool.id}' is registered but not yet implemented.`,
    };
  }

  const categoryPermitted = isSpecialistPermittedForCategory(specialistId, tool.category);
  if (!categoryPermitted) {
    return {
      tool_id: tool.id,
      available: true,
      category_permitted: false,
      operation_permitted: null,
      permitted: false,
      operation: tool.operation || null,
      approval_required: null,
      classification: null,
      decision: 'denied',
      reason: `Specialist '${specialistId || '(shared infrastructure)'}' is not permitted to use tools in category '${tool.category}'.`,
    };
  }

  const operationPermitted = isOperationPermittedForSpecialist(specialistId, tool.operation);
  if (!operationPermitted) {
    const allowedOperations =
      specialistId === null || specialistId === undefined
        ? SHARED_INFRASTRUCTURE_ROLE_PERMISSIONS
        : SPECIALIST_ROLE_PERMISSIONS[specialistId] || [];
    return {
      tool_id: tool.id,
      available: true,
      category_permitted: true,
      operation_permitted: false,
      permitted: false,
      operation: tool.operation || null,
      approval_required: null,
      classification: null,
      decision: 'denied',
      reason: `Specialist '${specialistId || '(shared infrastructure)'}'s role does not permit '${tool.operation}' operations (its role allows: ${allowedOperations.join(', ') || 'none'}).`,
    };
  }

  const approvalRequired = requiresApproval(classification);
  if (approvalRequired) {
    return {
      tool_id: tool.id,
      available: true,
      category_permitted: true,
      operation_permitted: true,
      permitted: true,
      operation: tool.operation || null,
      approval_required: true,
      classification: classification || null,
      decision: 'approval_required',
      reason: `Executing '${tool.id}' requires explicit approval before it can proceed.`,
    };
  }

  return {
    tool_id: tool.id,
    available: true,
    category_permitted: true,
    operation_permitted: true,
    permitted: true,
    operation: tool.operation || null,
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
  SPECIALIST_ROLE_PERMISSIONS,
  SHARED_INFRASTRUCTURE_ROLE_PERMISSIONS,
  isSpecialistPermittedForCategory,
  isOperationPermittedForSpecialist,
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

  console.log('\nRole-based (READ/WRITE/EXECUTE) denial example - no real tool triggers this today, so evaluateToolAccess is exercised directly:');
  const roleDenied = evaluateToolAccess({
    specialistId: 'research',
    tool: { id: 'hypothetical_write_tool', status: 'implemented', category: 'research', operation: 'write' },
    classification: 'analysis_only',
  });
  console.log(`  Research's role is READ-only - a hypothetical WRITE tool in its own category -> decision: ${roleDenied.decision} (${roleDenied.reason})`);
}
