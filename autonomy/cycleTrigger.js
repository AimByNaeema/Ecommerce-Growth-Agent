'use strict';

// THE PRODUCTION TRIGGER: runs exactly ONE autonomous cycle for ONE business, on request.
//
// WHAT CALLS IT. Two thin entry points share this function - server.js's protected
// POST /autonomy/cycle and autonomy/runCycleCli.js (npm run autonomy:cycle). Neither runs on
// a timer: this project has no hosting-level scheduler, and choosing one (an OS task
// scheduler, a hosting cron, a long-running worker) is a deployment decision CLAUDE.md
// rule 15 reserves. Whatever the owner chooses simply calls one of the two entry points.
//
// IT CAN ONLY EVER REFUSE. Before any work it reads the existing gates - it never replaces
// them, and the autonomy policy still decides every job inside the cycle:
//   durable storage -> refused where the file stores cannot persist (see below)
//   kill switch     -> agent/core/autonomyPolicy.js readKillSwitch - anything but ON refuses
//   business policy -> resolveBusinessPolicy - unreadable, malformed, or autonomy not enabled
//                      in the business's own configuration refuses
// Refusing here, before the scheduler runs, matters: a pass while autonomy is off would
// still claim due occurrences as "blocked", silently consuming them.
//
// DURABLE STORAGE. Every guarantee this loop depends on - an occurrence claimed once, an
// approval that survives a restart, an action executed once - lives in files under
// memory/state/. A Vercel serverless function has no durable filesystem (Vercel sets VERCEL
// in every deployment it runs), so running a cycle there would silently void those
// guarantees. It is refused rather than degraded. Lifting this requires a durable-storage
// decision, which is not made here.

const { runAutonomousCycle } = require('./autonomousCycle');
const { readKillSwitch, resolveBusinessPolicy } = require('../agent/core/autonomyPolicy');

function checkDurableStorage(env = process.env) {
  if (env && typeof env.VERCEL === 'string' && env.VERCEL.trim() !== '') {
    return {
      durable: false,
      reason_code: 'storage_not_durable',
      reason:
        'This process runs on Vercel serverless, where the file-based schedule, approval and verification stores cannot persist. Autonomous cycles are refused here until durable storage is decided.',
    };
  }
  return { durable: true, reason_code: null, reason: null };
}

function refused(reasonCode, reason) {
  return { triggered: false, reason_code: reasonCode, reason };
}

async function triggerAutonomousCycle({
  businessId = null,
  now = new Date(),
  env = process.env,
  businessPolicy = null,
  cycleOptions = {},
} = {}) {
  const storage = checkDurableStorage(env);
  if (!storage.durable) return refused(storage.reason_code, storage.reason);

  const killSwitch = readKillSwitch(env);
  if (killSwitch.state === 'malformed') {
    return refused('kill_switch_malformed', 'The autonomy kill switch is set to a value that is neither on nor off, so no cycle was started.');
  }
  if (killSwitch.state !== 'on') {
    return refused('kill_switch_off', 'The autonomy kill switch is off, so no cycle was started.');
  }

  const normalized = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
  const policy = businessPolicy || resolveBusinessPolicy(normalized);
  if (!policy || policy.ok !== true) {
    return refused((policy && policy.reason_code) || 'policy_data_unreadable', "This business's autonomy configuration could not be read, so no cycle was started.");
  }
  if (!policy.autonomy || policy.autonomy.enabled !== true) {
    return refused('business_autonomy_disabled', "Autonomy is not enabled in this business's own configuration, so no cycle was started.");
  }

  const cycle = await runAutonomousCycle({
    ...cycleOptions,
    businessId: normalized,
    now,
    enabledPlatforms: policy.enabled_platforms,
    businessPolicy: policy,
  });

  return {
    triggered: true,
    reason_code: null,
    reason: null,
    cycle_id: cycle.cycle_id,
    business_id: cycle.business_id,
    considered: cycle.considered,
    summary: cycle.record.summary,
    steps: cycle.steps.map((step) => ({
      job_id: step.job_id,
      parent_job_id: step.parent_job_id || null,
      outcome: step.outcome,
      reason_code: step.reason_code,
      approval_request_id: step.approval_request_id,
    })),
  };
}

module.exports = {
  checkDurableStorage,
  triggerAutonomousCycle,
};
