'use strict';

// The approval architecture for the ONE agent: how future actions are classified, and
// the policy governing when explicit human approval is required. Classification list
// + policy rules only - no classification engine, no execution logic, and no external
// service is connected anywhere in this file. `getClassificationById` is a read-only
// lookup, mirroring tools/toolRegistry.js's getToolById - it does not classify a real
// action, it only looks up one of the 4 defined classes by id.

const ACTION_CLASSIFICATIONS = [
  {
    id: 'analysis_only',
    title: 'Analysis-only',
    description:
      'Actions that only read/analyze existing data and produce a structured record (e.g. research, opportunity analysis, marketing analysis) - no external effect, no approval needed.',
  },
  {
    id: 'recommendation',
    title: 'Recommendation',
    description:
      'Actions that produce a suggestion for a human to consider (e.g. agent/core/listingOptimizationModel.js, agent/core/growthOpportunityModel.js records) - producing the suggestion needs no approval; acting on it does, per the classes below.',
  },
  {
    id: 'approval_required',
    title: 'Approval-required',
    description:
      'Actions that would change something (e.g. publishing content, applying a suggested listing title) but are not yet wired to an external system - must go through approvals/ for explicit human sign-off before proceeding.',
  },
  {
    id: 'externally_executable',
    title: 'Externally executable',
    description:
      'Actions that would call or change an external system (e.g. the connected Shopify store) - the most consequential class; always approval-required by default, and none can run today since no external service is connected yet.',
  },
];

// The policy governing when approval is required, regardless of which class an
// action falls into.
const APPROVAL_POLICY_RULES = [
  {
    id: 'approval_required_by_default',
    description:
      "External or potentially consequential actions (approval_required, externally_executable) require explicit approval before they proceed, unless a later, explicitly-scoped configuration setting permits otherwise. analysis_only and recommendation actions need no approval to produce their output.",
  },
  {
    id: 'never_silent_consequential_action',
    description:
      'The agent must never silently perform a consequential external action - if approval is missing, the action stops and is surfaced via approvals/, never executed quietly.',
  },
];

function getClassificationById(id) {
  return ACTION_CLASSIFICATIONS.find((entry) => entry.id === id);
}

// Classifications that may proceed automatically, per the 'approval_required_by_default'
// policy rule above. Anything else (approval_required, externally_executable, or no
// classification at all) requires explicit human approval before it proceeds -
// mechanically encoded by requiresApproval() below, rather than living only as prose.
// This is the single source of truth agent/core/toolPermissions.js reuses (never
// redefines) for its own AUTO_APPROVED_CLASSIFICATIONS re-export.
const AUTO_APPROVED_CLASSIFICATIONS = ['analysis_only', 'recommendation'];

function requiresApproval(classificationId) {
  return !classificationId || !AUTO_APPROVED_CLASSIFICATIONS.includes(classificationId);
}

module.exports = {
  ACTION_CLASSIFICATIONS,
  APPROVAL_POLICY_RULES,
  AUTO_APPROVED_CLASSIFICATIONS,
  getClassificationById,
  requiresApproval,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - approval architecture:\n');

  console.log('Action classifications:');
  ACTION_CLASSIFICATIONS.forEach((entry, index) => {
    console.log(`${index + 1}. [${entry.id}] ${entry.title}`);
    console.log(`   ${entry.description}`);
  });

  console.log('\nApproval policy:');
  APPROVAL_POLICY_RULES.forEach((rule, index) => {
    console.log(`${index + 1}. [${rule.id}]`);
    console.log(`   ${rule.description}`);
  });

  console.log('\nNo external service is connected here - externally_executable actions cannot run today.');
}
