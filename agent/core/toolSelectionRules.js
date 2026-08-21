'use strict';

// Tool selection rules for the ONE agent: how it should choose and use tools. Rules
// only - no automatic tool-selection, scoring, or looping logic exists anywhere in
// this file. These rules are meant to be applied once the select_tools/execute_work
// stages (agent/core/agentContract.js) and real tool calling are implemented in later,
// explicitly-scoped prompts - this is not that engine.

const TOOL_SELECTION_RULES = [
  {
    id: 'use_only_relevant_tools',
    description:
      "Select only tools/toolRegistry.js entries whose category/description match the current objective - never call a tool unrelated to the task at hand.",
  },
  {
    id: 'avoid_unnecessary_tool_calls',
    description:
      "Don't call a tool when the needed information is already available (e.g. in memory/state/ or research/) - a tool call is a last resort, not a default.",
  },
  {
    id: 'reuse_valid_existing_information',
    description:
      "Before calling a tool, check for already-gathered, still-valid information (agent/core/researchRecordModel.js verification_status not 'outdated', agent/core/memoryRules.js reusable_findings) and reuse it instead of re-fetching.",
  },
  {
    id: 'avoid_duplicate_research',
    description:
      "Don't repeat research that already exists and is still valid - matches research/README.md's existing purpose for agent/core/researchRecordModel.js (topic + market + date + verification_status).",
  },
  {
    id: 'verify_tool_results',
    description:
      "Check a tool's output against the agent's verify_results stage (agent/core/agentContract.js) before relying on it - do not treat raw output as final without verification.",
  },
  {
    id: 'handle_tool_failures',
    description:
      "When a tool fails or returns nothing, handle it explicitly (matches agent/core/agentContract.js's handle_errors) rather than proceeding as if it succeeded or retrying silently forever.",
  },
  {
    id: 'never_invent_tool_results',
    description:
      'If a tool is unavailable, fails, or returns nothing, never fabricate a plausible-looking result in its place - report the gap honestly, the same convention already enforced in every research/analysis schema built so far.',
  },
  {
    id: 'stop_when_enough_evidence_exists',
    description:
      "Stop calling further tools once the gathered evidence is sufficient to answer the objective - don't call tools past the point of unnecessary confirmation.",
  },
];

function getToolSelectionRules() {
  return TOOL_SELECTION_RULES;
}

module.exports = { TOOL_SELECTION_RULES, getToolSelectionRules };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - tool selection rules:\n');
  TOOL_SELECTION_RULES.forEach((rule, index) => {
    console.log(`${index + 1}. [${rule.id}]`);
    console.log(`   ${rule.description}`);
  });
  console.log('\nRules only - no autonomous tool-selection optimization exists here yet.');
}
