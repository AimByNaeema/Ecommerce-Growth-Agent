'use strict';

// Execution bounds for the Chief/Orchestrator (agent/core/orchestratorExecutionContract.js):
// caps on array-based research input size per call ("bounded research calls") and on
// plan steps per run ("bounded agent iterations"). Both are shared-infrastructure
// concerns (CLAUDE.md section 3's "Cost/token controls") distinct from
// agent/core/tokenControls.js (Claude output-token budget) and
// agent/core/toolResultCache.js (result memoization) - this module is about bounding
// the SIZE and COUNT of work a single run may attempt, not about tokens or caching.
//
// Same conservative-default/env-override convention as agent/core/tokenControls.js's
// getMaxTokensPerCall()/getMaxTokensPerRun(): a safety ceiling, not an asserted
// business policy. Every check here reports an honest, actionable reason and refuses
// outright - never silently truncates an array or silently drops a plan step, per
// agent/core/toolSelectionRules.js's handle_tool_failures rule (explicit, not silent).

// Max entries any single top-level array field in a tool call's research_params may
// contain, overridable via MAX_ARRAY_FIELD_ENTRIES. Applies generically to every
// research-style task's entry array (markets[], competitors[], keywords[],
// segments[], metrics[], opportunities[], entries[], etc.) without needing to know
// each task's specific field name.
function getMaxArrayFieldEntries() {
  const envOverride = Number(process.env.MAX_ARRAY_FIELD_ENTRIES);
  return envOverride > 0 ? envOverride : 100;
}

// Max plan steps (one per distinct routed specialist/shared-infrastructure target)
// one runOrchestratorContract() run may execute, overridable via
// MAX_PLAN_STEPS_PER_RUN. Routing already dedupes to at most ROUTING_TARGETS.length
// (11 today) via planRouting()'s own dedup logic, so this is a real, tested ceiling
// rather than an implicit consequence of that dedup - comfortably above today's
// natural maximum so no real objective is ever affected.
function getMaxPlanStepsPerRun() {
  const envOverride = Number(process.env.MAX_PLAN_STEPS_PER_RUN);
  return envOverride > 0 ? envOverride : 20;
}

// Walks researchParams' own top-level keys; refuses (never truncates) the first
// Array value whose length exceeds getMaxArrayFieldEntries(). Returns
// { allowed: true, reason: null } when researchParams is absent/not an object (no
// array fields to check) or every array field is within bounds.
function checkArrayFieldBounds(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return { allowed: true, reason: null, field: null, length: null, max: null };
  }

  const max = getMaxArrayFieldEntries();
  for (const [field, value] of Object.entries(researchParams)) {
    if (Array.isArray(value) && value.length > max) {
      return {
        allowed: false,
        field,
        length: value.length,
        max,
        reason: `research_params.${field} has ${value.length} entries, exceeding the maximum of ${max} allowed per call - split this into multiple calls instead of one unbounded request.`,
      };
    }
  }

  return { allowed: true, reason: null, field: null, length: null, max: null };
}

// Refuses (never silently truncates the plan to the first N targets) when a routed
// plan would exceed getMaxPlanStepsPerRun(). Returns { allowed: true, reason: null }
// when within bounds.
function checkPlanStepBounds(targetCount) {
  const max = getMaxPlanStepsPerRun();
  if (typeof targetCount === 'number' && targetCount > max) {
    return {
      allowed: false,
      count: targetCount,
      max,
      reason: `This objective routed to ${targetCount} plan steps, exceeding the maximum of ${max} allowed per run - split it into smaller, more specific objectives instead of one run that spans this many targets.`,
    };
  }
  return { allowed: true, reason: null, count: targetCount, max };
}

module.exports = {
  getMaxArrayFieldEntries,
  getMaxPlanStepsPerRun,
  checkArrayFieldBounds,
  checkPlanStepBounds,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - execution bounds (array-size + plan-step ceilings):\n');
  console.log(`Max entries per array field: ${getMaxArrayFieldEntries()}`);
  console.log(`Max plan steps per run: ${getMaxPlanStepsPerRun()}\n`);

  console.log('Array-field bound example (within limit):');
  console.log(JSON.stringify(checkArrayFieldBounds({ keywords: ['a', 'b', 'c'] }), null, 2));

  console.log('\nArray-field bound example (over limit):');
  console.log(
    JSON.stringify(checkArrayFieldBounds({ keywords: new Array(getMaxArrayFieldEntries() + 1).fill('placeholder') }), null, 2)
  );

  console.log('\nPlan-step bound example (within limit):');
  console.log(JSON.stringify(checkPlanStepBounds(5), null, 2));

  console.log('\nPlan-step bound example (over limit):');
  console.log(JSON.stringify(checkPlanStepBounds(getMaxPlanStepsPerRun() + 1), null, 2));
}
