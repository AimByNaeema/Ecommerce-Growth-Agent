'use strict';

// THE ONE DECISION: may this action execute, on the agent's own initiative, right now?
//
// Every gate this project has ever built already answers a PIECE of that question -
// agent/core/toolPermissions.js (who may use which tool, on which platform),
// compliance/complianceEngine.js (is the content permissible), approvals/
// approvalArchitecture.js (has a human really signed off), agent/core/tokenControls.js
// and agent/core/usageLimits.js (has this run spent its budget). Each is consulted at a
// different point by a different caller, and NOTHING joined them into a single answer.
// Worse, nothing could stop the agent at all: before this module there was no kill switch
// anywhere in the repository.
//
// This module is that join, and that stop. It composes the existing gates in a fixed
// order and returns one structured decision. It does not re-implement any of them.
//
// WHAT THIS MODULE IS NOT:
//   - It is NOT an executor. It returns a decision and performs no action of any kind.
//   - It is NOT an approval mechanism. It never verifies, produces, satisfies, or
//     manufactures a human approval. It requires no crypto, imports none, and calls none -
//     approvals/approvalArchitecture.js remains the sole authority on whether a human
//     really signed a decision, and this file is not permitted to have a second opinion.
//     APPROVAL_REQUIRED here means "go to that gate", never "I approved it".
//   - It is NOT a second risk taxonomy. The 4 action classes come from
//     approvals/approvalArchitecture.js, reused exactly as agent/core/toolPermissions.js
//     already reuses them.
//   - It is NOT a second usage ledger. The daily spend comes from
//     agent/core/dailyUsageAccounting.js, which reads what usage/usageTracker.js already
//     wrote. Nothing here counts or meters anything.
//   - It is NOT a scheduler, monitor, circuit breaker, or autonomous loop. Those are
//     separate, explicitly-scoped work. This is the gate they will have to call.
//
// IT CAN ONLY EVER BE MORE RESTRICTIVE THAN TODAY. It returns ALLOW exactly where the
// existing gates already would, and it adds new ways to say no. Nothing downstream is
// weakened, and no existing path is changed - which is also why NOTHING CALLS THIS YET:
// the only genuinely autonomous callers (scheduler, monitor, autonomy loop) are out of
// scope, so there is nothing autonomous in this project for it to gate. That is the
// honest state, reported rather than papered over by inventing a caller.
//
// FAIL-CLOSED IS THE WHOLE DESIGN. Missing configuration, an unparseable kill switch, an
// unreadable run store, an unstated compliance verdict, an unrecognized platform, and an
// unexpected exception anywhere in evaluation all produce BLOCK. There is no path through
// this file where "I could not tell" comes out as "yes".
//
// NO SECRET REACHES THE OUTPUT. Every string in a decision is built here from ids,
// enum codes and numbers. The kill switch's raw environment value is never returned or
// logged (only whether it parsed). A supplied human-approval object is read for its
// verification flag and its request id and NOTHING else - its signature and nonce are
// never copied out. Credentials are never read at all: this module makes no adapter call
// and looks at no credential, because a credential has never been evidence of permission
// in this project (see configuration/business.example.yaml's enabled_platforms).

const path = require('path');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('./toolPermissions');
const { requiresApproval } = require('../../approvals/approvalArchitecture');
const { checkTokenBudget, getMaxTokensPerRun } = require('./tokenControls');
const { checkUsageLimits } = require('./usageLimits');
const { readDailyUsage } = require('./dailyUsageAccounting');
const configValidator = require('../../tools/configValidator');
const businessRegistry = require('../../configuration/businessRegistry');

// The default single-business configuration, same path expression
// agent/core/orchestratorExecutionContract.js already uses for it.
const DEFAULT_BUSINESS_CONFIG_PATH = path.join(__dirname, '..', '..', 'configuration', 'business.yaml');

// ---------------------------------------------------------------------------------
// The vocabulary. Exported so a caller (and a test) can switch on codes rather than on
// prose, and so no consumer has to hardcode a string this file might later reword.
// ---------------------------------------------------------------------------------

const POLICY_DECISIONS = ['ALLOW', 'APPROVAL_REQUIRED', 'BLOCK'];

// The gates, in evaluation order. The first non-pass decides the outcome; later gates are
// reported as 'skipped' so a reader can see exactly how far evaluation got.
const POLICY_GATES = [
  { id: 'business_identity', description: 'The action names a business this project can resolve.' },
  { id: 'policy_data', description: 'The kill-switch value parses and the business configuration loads and is well-formed.' },
  { id: 'compliance', description: 'A compliance verdict was stated, and it is not BLOCK.' },
  { id: 'tool_authorization', description: "The specialist may use this tool, per agent/core/toolPermissions.js's category and role rules." },
  { id: 'platform_enablement', description: "Every platform this action touches is enabled in the business's own configuration." },
  { id: 'per_run_budget', description: 'This run has token and call budget left (agent/core/tokenControls.js, agent/core/usageLimits.js).' },
  { id: 'daily_budget', description: "This business has budget left for the UTC day (agent/core/dailyUsageAccounting.js)." },
  { id: 'autonomy_permission', description: 'The global kill switch is on AND this business enables autonomy. Skipped for a human-approved action, which is not autonomous.' },
  { id: 'human_approval', description: 'A consequential action carries a verified human approval, or is held for one.' },
];

const POLICY_REASON_CODES = [
  // ALLOW
  'low_risk_autonomous_action_permitted',
  'human_approved',
  // APPROVAL_REQUIRED
  'human_approval_required',
  // BLOCK
  'invalid_business',
  'policy_data_unreadable',
  'policy_data_malformed',
  'compliance_block',
  'compliance_verdict_missing',
  'unauthorized_tool',
  'unauthorized_platform',
  'per_run_budget_exhausted',
  'daily_budget_exhausted',
  'daily_budget_unverifiable',
  'kill_switch_off',
  'kill_switch_malformed',
  'business_autonomy_disabled',
  'policy_evaluation_error',
];

// ---------------------------------------------------------------------------------
// The kill switch.
// ---------------------------------------------------------------------------------

const AUTONOMY_KILL_SWITCH_ENV = 'AGENT_AUTONOMY_ENABLED';

const KILL_SWITCH_TRUE_VALUES = ['true', '1', 'on', 'yes', 'enabled'];
const KILL_SWITCH_FALSE_VALUES = ['false', '0', 'off', 'no', 'disabled'];

// Reads the ONE global stop, from the environment so it can be flipped without editing,
// validating or redeploying a configuration file, and so it applies to every business at
// once. Read at call time, never memoized at module load - the same convention
// agent/core/tokenControls.js and agent/core/runHistoryStore.js already use, and the
// reason an operator turning this off takes effect on the very next decision.
//
// THREE STATES, TWO OF WHICH STOP THE AGENT:
//   'on'        - explicitly and unambiguously enabled.
//   'off'       - explicitly disabled, OR unset/blank. An unstated permission was never
//                 granted, so absence is off, never on.
//   'malformed' - present but not clearly a yes or a no ("ture", "maybe", "1.0"). Also
//                 stops the agent, but under its own reason code, because an operator who
//                 typed a value meant something by it and deserves to be told it did not
//                 parse rather than to discover it from an agent that silently never acts.
//
// THE RAW VALUE NEVER LEAVES THIS FUNCTION. Only the parsed state and whether anything was
// set at all are returned, so nothing an operator pasted into this variable can reach a
// decision object, a log line, or an audit record.
function readKillSwitch(env = process.env) {
  const raw = env ? env[AUTONOMY_KILL_SWITCH_ENV] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { state: 'off', value_present: false };
  }
  const normalized = String(raw).trim().toLowerCase();
  if (KILL_SWITCH_TRUE_VALUES.includes(normalized)) return { state: 'on', value_present: true };
  if (KILL_SWITCH_FALSE_VALUES.includes(normalized)) return { state: 'off', value_present: true };
  return { state: 'malformed', value_present: true };
}

// ---------------------------------------------------------------------------------
// The daily token ceiling.
// ---------------------------------------------------------------------------------

// How many full runs' worth of output tokens a business may spend in one UTC day when its
// own configuration states no `autonomy.daily_token_budget`.
//
// DERIVED, NOT INVENTED, AND NOT A PRICE. agent/core/tokenControls.js already establishes
// this exact convention - its per-run budget defaults to the per-call ceiling times four -
// so the daily default is the per-run budget times this multiple. It is a conservative
// safety ceiling, not an asserted business cost policy, and it is denominated in TOKENS:
// this project has no model price table anywhere, so any currency figure here would have
// to be made up.
const DEFAULT_DAILY_RUN_ALLOWANCE = 10;

function getDefaultDailyTokenBudget() {
  return getMaxTokensPerRun() * DEFAULT_DAILY_RUN_ALLOWANCE;
}

// ---------------------------------------------------------------------------------
// Resolving one business's own policy configuration.
// ---------------------------------------------------------------------------------

// Loads the enabled platforms and the autonomy block from a business's configuration, in
// ONE read, through the existing single readers (tools/configValidator.js and
// configuration/businessRegistry.js) rather than parsing anything here.
//
// A null/blank businessId is the default single-business deployment and resolves to the
// project's own configuration/business.yaml - the same file server.js and the Chief
// already use for that case. Anything else must be a valid, resolvable business id.
//
// EVERY FAILURE IS A BLOCK, NOT A DEFAULT. configValidator.loadBusinessConfig() throws for
// a configuration file that does not exist, and that throw becomes 'policy_data_unreadable'
// rather than an empty config that would read as "no platforms, autonomy off" - which is a
// denial too, but for the wrong reason and with a misleading message. A config whose
// autonomy block is present but malformed is 'policy_data_malformed', for the same reason
// the CLI refuses it: `enabled: "true"` must never quietly read as either on or off.
function resolveBusinessPolicy(businessId) {
  const normalized = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;

  if (normalized !== null && !businessRegistry.isValidBusinessId(normalized)) {
    return { ok: false, reason_code: 'invalid_business', detail: 'The business id is not a valid identifier for this project.' };
  }

  let config;
  try {
    config = normalized === null
      ? configValidator.loadBusinessConfig(DEFAULT_BUSINESS_CONFIG_PATH)
      : businessRegistry.loadBusinessConfig(normalized);
  } catch (err) {
    return {
      ok: false,
      reason_code: 'policy_data_unreadable',
      detail: normalized === null
        ? 'The default business configuration could not be read, so no autonomy or platform decision can be made for it.'
        : 'That business has no readable configuration, so no autonomy or platform decision can be made for it.',
    };
  }

  const autonomyCheck = configValidator.validateAutonomyConfig(config);
  if (!autonomyCheck.valid) {
    return {
      ok: false,
      reason_code: 'policy_data_malformed',
      // The validator's own messages name the offending FIELD and value, both of which are
      // configuration the operator wrote - never a credential (this config holds none).
      detail: autonomyCheck.errors.join(' '),
    };
  }

  const platformCheck = configValidator.validateEnabledPlatforms(config);
  if (!platformCheck.valid) {
    return { ok: false, reason_code: 'policy_data_malformed', detail: platformCheck.errors.join(' ') };
  }

  return {
    ok: true,
    business_id: normalized,
    enabled_platforms: configValidator.readEnabledPlatforms(config),
    autonomy: configValidator.readAutonomyConfig(config),
  };
}

// ---------------------------------------------------------------------------------
// Reading a supplied human approval - WITHOUT becoming a second approval mechanism.
// ---------------------------------------------------------------------------------

// Whether the caller handed over a genuinely verified approval, as produced by
// approvals/approvalArchitecture.js's verifyApprovalAuthorization().
//
// THIS DOES NOT VERIFY ANYTHING, AND MUST NOT. Verification is an Ed25519 signature check
// against a server-held public key, a single-use nonce, and an execution fingerprint, and
// it belongs to exactly one module. Re-deciding it here would create a second, weaker
// answer to the most load-bearing question in the system. All this does is recognize that
// module's own success object, structurally, and refuse anything else.
//
// ONLY THREE FIELDS ARE EVER READ, AND NONE OF THEM IS SECRET: the verified flag, the
// decision, and the request id. The provenance also carries the signature and the nonce;
// neither is read here and neither is ever copied into a decision.
function readVerifiedApproval(humanApproval) {
  if (!humanApproval || typeof humanApproval !== 'object') return null;
  if (humanApproval.verified !== true) return null;
  const provenance = humanApproval.provenance;
  if (!provenance || typeof provenance !== 'object') return null;
  if (provenance.decision !== 'approved') return null;
  return {
    request_id: typeof provenance.request_id === 'string' ? provenance.request_id : null,
    method: typeof provenance.method === 'string' ? provenance.method : null,
  };
}

// ---------------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------------

const COMPLIANCE_VERDICTS = ['PASS', 'REVIEW', 'BLOCK', 'not_applicable'];

function buildTrace() {
  const trace = {};
  for (const gate of POLICY_GATES) trace[gate.id] = { status: 'skipped', reason_code: null, detail: null };
  return trace;
}

// Evaluates the full policy chain. Returns a structured decision; never throws, never
// executes, never approves.
//
// INPUTS:
//   businessId          null/'' for the default single-business deployment, else a real id.
//   specialistId,toolId what is being attempted - passed straight to the existing
//                       permission gate, never interpreted here.
//   platform            the platform this action would touch, when the action names one.
//                       null means "this action names no platform"; the tool's own
//                       declared platforms are still checked either way.
//   classification      optional override; defaults to the tool's registered class.
//   complianceVerdict   REQUIRED and explicit: 'PASS' | 'REVIEW' | 'BLOCK', or the
//                       deliberate declaration 'not_applicable' for an action with no
//                       compliance-checkable content. Omitting it BLOCKS - a verdict that
//                       was never stated is missing policy data, not a pass.
//   humanApproval       verifyApprovalAuthorization()'s own success object, when a human
//                       has already approved this exact action. Absent means autonomous.
//   runUsage            this run's live trackers: { tokensUsedThisRun, usageTracker }.
//                       Defaults to a zero-usage run, exactly as buildPlanStep's own
//                       runTokenTracker parameter already does.
//   businessPolicy      optional pre-resolved configuration, so a caller that already read
//                       it need not read it twice (and a test need not touch disk).
//   dailyUsage          optional pre-read daily spend, same reasoning.
//   now                 evaluation time, for the UTC day boundary.
function evaluateAutonomyPolicy({
  businessId = null,
  specialistId = null,
  toolId = null,
  platform = null,
  classification = undefined,
  complianceVerdict = null,
  humanApproval = null,
  runUsage = null,
  businessPolicy = null,
  dailyUsage = null,
  now = new Date(),
} = {}) {
  const trace = buildTrace();
  const verifiedApproval = readVerifiedApproval(humanApproval);

  const base = {
    business_id: typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null,
    specialist_id: typeof specialistId === 'string' ? specialistId : null,
    tool_id: typeof toolId === 'string' ? toolId : null,
    platform: typeof platform === 'string' ? platform : null,
    classification: null,
    human_approval_present: verifiedApproval !== null,
    human_approval_request_id: verifiedApproval ? verifiedApproval.request_id : null,
    evaluated_at: new Date().toISOString(),
    gates: trace,
  };

  const decide = (decision, reasonCode, reason, extra = {}) => ({
    ...base,
    ...extra,
    decision,
    reason_code: reasonCode,
    reason,
    autonomous_execution_permitted: decision === 'ALLOW' && verifiedApproval === null,
    human_approval_required: decision === 'APPROVAL_REQUIRED',
    // Stated on every decision so no reader can mistake an ALLOW here for an approval.
    approval_gate_is_authoritative: true,
  });

  const fail = (gateId, reasonCode, reason) => {
    trace[gateId] = { status: 'block', reason_code: reasonCode, detail: reason };
    return decide('BLOCK', reasonCode, reason);
  };

  const pass = (gateId, detail = null) => {
    trace[gateId] = { status: 'pass', reason_code: null, detail };
  };

  try {
    // --- Gate 1: business identity -------------------------------------------------
    const resolved = businessPolicy || resolveBusinessPolicy(businessId);
    if (!resolved.ok && resolved.reason_code === 'invalid_business') {
      return fail('business_identity', 'invalid_business', 'No valid business was identified for this action, so no policy applies to it.');
    }
    pass('business_identity');

    // --- Gate 2: policy data -------------------------------------------------------
    if (!resolved.ok) {
      return fail('policy_data', resolved.reason_code, resolved.detail);
    }
    const killSwitch = readKillSwitch();
    if (killSwitch.state === 'malformed') {
      return fail(
        'policy_data',
        'kill_switch_malformed',
        `${AUTONOMY_KILL_SWITCH_ENV} is set to a value that is neither a yes nor a no, so the global autonomy state is unknown and no autonomous execution is permitted. Set it to true or false.`
      );
    }
    pass('policy_data');

    // --- Gate 3: compliance --------------------------------------------------------
    // Unconditional and above everything else that follows: a BLOCK blocks even an action
    // a human has already approved, matching approvals/complianceApprovalGate.js's own
    // standing rule that a BLOCK never enters the approval flow at all.
    if (!COMPLIANCE_VERDICTS.includes(complianceVerdict)) {
      return fail(
        'compliance',
        'compliance_verdict_missing',
        `No compliance verdict was stated for this action. State one of ${COMPLIANCE_VERDICTS.join(', ')} - an unstated verdict is missing policy data, never a pass.`
      );
    }
    if (complianceVerdict === 'BLOCK') {
      return fail('compliance', 'compliance_block', 'Compliance returned BLOCK for this action. A BLOCK is final here: it cannot be approved, overridden, or waited out.');
    }
    pass('compliance', `compliance verdict: ${complianceVerdict}`);
    // A REVIEW is eligible to continue, but it can never reach ALLOW - something about it
    // needs a human, which is exactly what REVIEW means.
    const complianceForcesApproval = complianceVerdict === 'REVIEW';

    // --- Gates 4 and 5: tool authorization, then platform enablement ---------------
    const access = checkToolAccess({ specialistId, toolId, enabledPlatforms: resolved.enabled_platforms });
    base.classification = classification === undefined ? access.classification : classification;

    if (access.decision === 'unavailable' || access.decision === 'denied') {
      // The two denials are reported apart because they are different operator problems:
      // a platform denial is fixed in business.yaml's enabled_platforms, a tool denial is
      // a specialist asking for something outside its own domain.
      if (access.platform_permitted === false) {
        return fail(
          'platform_enablement',
          'unauthorized_platform',
          `Tool '${base.tool_id}' is bound to a platform this business has not enabled. Platform enablement is stated only in the business configuration - a credential never enables a platform.`
        );
      }
      return fail('tool_authorization', 'unauthorized_tool', access.reason || `Tool '${base.tool_id}' is not authorized for specialist '${base.specialist_id}'.`);
    }
    pass('tool_authorization');

    // The action's OWN named platform, checked independently of the tool's declared
    // binding. A platform-neutral tool pointed at a disabled or unrecognized platform is
    // still denied - 'amazon' and 'ebay' have no adapter here and fail closed.
    if (base.platform !== null && !resolved.enabled_platforms.includes(base.platform)) {
      return fail(
        'platform_enablement',
        'unauthorized_platform',
        `Platform '${base.platform}' is not enabled for this business. Enablement is stated only in the business configuration - a credential never enables a platform.`
      );
    }
    pass('platform_enablement', resolved.enabled_platforms.length === 0 ? 'no platform enabled for this business' : `enabled: ${resolved.enabled_platforms.join(', ')}`);

    // --- Gate 6: per-run budget ----------------------------------------------------
    const usage = runUsage && typeof runUsage === 'object' ? runUsage : {};
    const tokensUsedThisRun = Number.isFinite(usage.tokensUsedThisRun) ? usage.tokensUsedThisRun : 0;
    const tokenBudget = checkTokenBudget({ requestedMaxTokens: usage.requestedMaxTokens, tokensUsedThisRun });
    if (!tokenBudget.allowed) {
      return fail('per_run_budget', 'per_run_budget_exhausted', tokenBudget.reason);
    }
    if (usage.usageTracker) {
      const callBudget = checkUsageLimits(base.tool_id, usage.usageTracker);
      if (!callBudget.allowed) {
        return fail('per_run_budget', 'per_run_budget_exhausted', callBudget.reason);
      }
    }
    pass('per_run_budget', `${tokensUsedThisRun} of ${getMaxTokensPerRun()} run tokens used`);

    // --- Gate 7: daily / cross-run budget ------------------------------------------
    const daily = dailyUsage || readDailyUsage({ businessId: resolved.business_id, now });
    if (!daily || daily.available !== true) {
      return fail(
        'daily_budget',
        'policy_data_unreadable',
        "This business's own run history could not be read, so its spend for the day is unknown. An unknown spend is never treated as an unspent one."
      );
    }
    const dailyTokenBudget = resolved.autonomy.daily_token_budget === null
      ? getDefaultDailyTokenBudget()
      : resolved.autonomy.daily_token_budget;
    if (daily.tokens_total >= dailyTokenBudget) {
      return fail(
        'daily_budget',
        'daily_budget_exhausted',
        `This business has already used ${daily.tokens_total} of its ${dailyTokenBudget} token budget for ${daily.day} (UTC) - no further work is permitted today.`
      );
    }
    // COVERAGE MUST BE COMPLETE BEFORE AN UNDER-BUDGET READING MEANS ANYTHING.
    //
    // A day whose runs did not all record a usage ledger has a measured total that is a
    // FLOOR, not a spend. "Under budget" computed from a floor says only "at least this
    // much was spent" - the real remainder is unknown, and treating an unknown remainder
    // as available budget is precisely how a daily limit gets bypassed by runs that happen
    // not to be instrumented.
    //
    // So an incomplete day blocks. Note the ordering: a floor that ALREADY exceeds the
    // budget is definitive and is refused above under its own code - incompleteness can
    // only ever hide MORE spend, never less, so it can never rescue an over-budget day.
    if (daily.coverage_complete !== true) {
      return fail(
        'daily_budget',
        'daily_budget_unverifiable',
        `This business's spend for ${daily.day} (UTC) cannot be established: ${daily.runs_missing_usage || 0} of ${daily.runs_counted} run(s) recorded no readable usage, so ${daily.tokens_total} tokens is a floor rather than a total. An unknown remaining budget is never treated as an available one.`
      );
    }

    // The run-count ceiling is enforced only when the business states one. There is no
    // default: inventing a number of runs per day would be exactly the kind of made-up
    // threshold the token budget above deliberately derives instead.
    if (resolved.autonomy.daily_run_budget !== null && daily.runs_counted >= resolved.autonomy.daily_run_budget) {
      return fail(
        'daily_budget',
        'daily_budget_exhausted',
        `This business has already made ${daily.runs_counted} of its ${resolved.autonomy.daily_run_budget} permitted runs for ${daily.day} (UTC) - no further work is permitted today.`
      );
    }
    pass('daily_budget', `${daily.tokens_total} of ${dailyTokenBudget} day tokens used across ${daily.runs_counted} run(s)`);

    // --- Gate 8: autonomy permission and the kill switch ---------------------------
    // SKIPPED for a verified human approval, and only for that: a human-approved action is
    // not the agent acting on its own, so the switch that stops the agent acting on its own
    // must not stop it. This is what keeps the existing approved-execution path working
    // exactly as it does today. Every hard block above still applied to it.
    if (verifiedApproval === null) {
      if (killSwitch.state !== 'on') {
        return fail(
          'autonomy_permission',
          'kill_switch_off',
          `The global autonomy kill switch (${AUTONOMY_KILL_SWITCH_ENV}) is off, so the agent may not start any action on its own. Human-triggered and human-approved actions are unaffected.`
        );
      }
      if (resolved.autonomy.enabled !== true) {
        return fail(
          'autonomy_permission',
          'business_autonomy_disabled',
          "This business has not enabled autonomy in its own configuration, so the agent may not start an action for it. The global kill switch cannot grant what the business has not."
        );
      }
      pass('autonomy_permission', 'global kill switch on and business autonomy enabled');
    } else {
      trace.autonomy_permission = {
        status: 'skipped',
        reason_code: null,
        detail: 'Not an autonomous action - a verified human approval was supplied, so the autonomy gate does not apply.',
      };
    }

    // --- Gate 9: human approval ----------------------------------------------------
    const needsApproval = requiresApproval(base.classification) || access.decision === 'approval_required' || complianceForcesApproval;
    if (needsApproval && verifiedApproval === null) {
      trace.human_approval = {
        status: 'approval_required',
        reason_code: 'human_approval_required',
        detail: complianceForcesApproval && !requiresApproval(base.classification)
          ? 'Compliance returned REVIEW, so a human must look at this before it proceeds.'
          : `Action class '${base.classification || 'unclassified'}' is consequential.`,
      };
      return decide(
        'APPROVAL_REQUIRED',
        'human_approval_required',
        'This action requires explicit human approval before it may execute. Autonomy permission does not and cannot substitute for it - the approval must be signed and verified by approvals/approvalArchitecture.js.'
      );
    }
    if (verifiedApproval !== null) {
      pass('human_approval', `verified human approval supplied (${verifiedApproval.method || 'unknown method'})`);
      return decide('ALLOW', 'human_approved', 'A human has approved this exact action and that approval was verified by the approval gate. Every other policy gate also passed.');
    }
    pass('human_approval', 'no human approval required for this action class');

    // --- Gate 10: allowed ----------------------------------------------------------
    return decide(
      'ALLOW',
      'low_risk_autonomous_action_permitted',
      'Every policy gate passed and this action class is not consequential, so the agent may perform it on its own.'
    );
  } catch (err) {
    // The last line of the fail-closed design: an unexpected fault in any gate is a
    // refusal, never a pass. The underlying message is deliberately NOT relayed - it could
    // carry a file path or a third-party detail, and no operator action depends on it here.
    return decide(
      'BLOCK',
      'policy_evaluation_error',
      'The autonomy policy could not be evaluated, so this action is refused. Nothing executes on an unevaluated policy.'
    );
  }
}

module.exports = {
  AUTONOMY_KILL_SWITCH_ENV,
  DEFAULT_DAILY_RUN_ALLOWANCE,
  POLICY_DECISIONS,
  POLICY_GATES,
  POLICY_REASON_CODES,
  COMPLIANCE_VERDICTS,
  readKillSwitch,
  getDefaultDailyTokenBudget,
  resolveBusinessPolicy,
  readVerifiedApproval,
  evaluateAutonomyPolicy,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - controlled autonomy policy:\n');
  console.log(`Kill switch (${AUTONOMY_KILL_SWITCH_ENV}): ${readKillSwitch().state}`);
  console.log(`Default daily token ceiling: ${getDefaultDailyTokenBudget()} (${DEFAULT_DAILY_RUN_ALLOWANCE} x the per-run budget) - tokens, never money.\n`);

  const businessPolicy = { ok: true, business_id: null, enabled_platforms: ['shopify'], autonomy: { enabled: true, daily_token_budget: 10000, daily_run_budget: null } };
  const dailyUsage = { available: true, day: '2026-01-01', tokens_total: 120, runs_counted: 1 };
  const shared = { specialistId: 'research', businessPolicy, dailyUsage, complianceVerdict: 'PASS' };

  const show = (label, result) => {
    console.log(`${label}: ${result.decision} (${result.reason_code})`);
    console.log(`  ${result.reason}\n`);
  };

  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';
  show('Low-risk read, everything on', evaluateAutonomyPolicy({ ...shared, toolId: 'market_research' }));
  show('Consequential action, everything on', evaluateAutonomyPolicy({ ...shared, toolId: 'shopify_vendor_correction', specialistId: 'product' }));

  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'false';
  show('Same consequential action, kill switch off', evaluateAutonomyPolicy({ ...shared, toolId: 'shopify_vendor_correction', specialistId: 'product' }));
  show('Compliance BLOCK', evaluateAutonomyPolicy({ ...shared, toolId: 'market_research', complianceVerdict: 'BLOCK' }));

  delete process.env[AUTONOMY_KILL_SWITCH_ENV];
  show('Kill switch unset - absence is never permission', evaluateAutonomyPolicy({ ...shared, toolId: 'market_research' }));
}
