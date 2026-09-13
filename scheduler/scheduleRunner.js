'use strict';

// The scheduler pass: find this business's due jobs, claim each occurrence exactly once,
// turn it into a CONTROLLED EXECUTION REQUEST, and put that request through the existing
// autonomy policy. It stops there.
//
// IT EXECUTES NOTHING. This module calls no tool, no adapter, no executor, and no approval
// function. Its output is a decision per job - ALLOW, APPROVAL_REQUIRED or BLOCK - and the
// execution request that decision is about. Whatever later, separately-scoped layer acts on
// an ALLOW must do so through the existing Chief execution contract; the scheduler is not a
// back door into it, and there is deliberately no path here that could become one.
//
// A JOB CANNOT WIDEN WHAT THE SYSTEM CAN DO. scheduler/scheduleModel.js already refuses a
// job whose task names anything but a real tools/toolRegistry.js capability, so a schedule
// is a recurring request for an EXISTING capability - never a command, never a script.
//
// EVERY GATE THE POLICY ENFORCES APPLIES HERE, BECAUSE IT IS THE SAME POLICY. Business
// identity, platform enablement, tool authorization, per-run and daily budget, compliance,
// the human-approval requirement and the global kill switch are all evaluated by
// agent/core/autonomyPolicy.js's evaluateAutonomyPolicy - reused, not reimplemented and not
// partially re-checked here. A second copy of those rules is exactly the duplicate
// permission system this architecture forbids.
//
// THE COMPLIANCE VERDICT IS NEVER INVENTED - BUT IT IS NOW REAL WHEN IT CAN BE. The policy
// requires an explicit verdict and blocks without one. This runner states
// 'not_applicable' on its own only for an action class that produces no content to check
// (analysis_only / recommendation). For a content-bearing action it runs the REAL
// compliance/complianceEngine.js over the content the job itself declares in
// task.params.content - a genuine evaluation of genuine content, whose PASS, REVIEW or
// BLOCK is returned unchanged. A consequential job that declares no content still gets NO
// verdict, and the policy still blocks it: a verdict is never fabricated to move an action
// past a gate. This is what allows a consequential scheduled action to reach
// APPROVAL_REQUIRED and enter the durable approval queue, rather than dying at the
// compliance gate for want of a verdict that could have been computed.
//
// ONE FAILING JOB NEVER TAKES DOWN THE PASS. Every job is processed inside its own
// try/catch and a fault becomes that job's own error entry. A scheduler that can crash the
// process it runs in is a liability, not a feature.
//
// THE CLAIM HAPPENS BEFORE THE DECISION, AND SURVIVES A RESTART. See
// scheduler/scheduleStore.js's claimOccurrence: the occurrence key is derived from the
// schedule, so a restarted process computes the same key and finds it already claimed.

const { createExecutionRequest } = require('../agent/core/orchestratorExecutionContract');
const { getToolById } = require('../tools/toolRegistry');
const { TOOL_CLASSIFICATIONS, AUTO_APPROVED_CLASSIFICATIONS } = require('../agent/core/toolPermissions');
const { evaluateAutonomyPolicy } = require('../agent/core/autonomyPolicy');
const { evaluateCompliance } = require('../compliance/complianceEngine');
const { getEnabledPlatforms } = require('../configuration/businessRegistry');
const scheduleStore = require('./scheduleStore');

// What the runner concluded for one job in one pass. Machine-readable, following the same
// convention as the policy's own reason codes.
const RUN_OUTCOMES = [
  'allowed',            // every policy gate passed - a later layer may execute this request
  'approval_required',  // consequential: it waits for a real human approval, as it must
  'blocked',            // a policy gate refused it
  'not_claimed',        // no unclaimed occurrence (disabled, not due, or already claimed)
  'error',              // this job faulted; the rest of the pass continued
];

// The compliance verdict for one scheduled job.
//
// TWO HONEST ANSWERS, AND A REFUSAL:
//
//   'not_applicable' - stated by this runner alone, and ONLY for an action class that
//                      produces no content to check (analysis_only / recommendation).
//   a REAL verdict   - computed by compliance/complianceEngine.js from the content the
//                      job itself declares in task.params.content. This is a genuine
//                      evaluation of real content, not a placeholder: the engine is
//                      deterministic and offline, so it costs nothing and can run on
//                      every pass. Its PASS, REVIEW or BLOCK is returned unchanged.
//   null             - anything else. A consequential job that declares no content has
//                      nothing to evaluate, so no verdict is stated and the policy blocks.
//                      A verdict is never invented to get an action past a gate.
//
// This is what lets a consequential scheduled action reach APPROVAL_REQUIRED at all: the
// policy needs a verdict, and a real one now exists for content declared up front.
function resolveComplianceVerdict(toolId, job = null) {
  const classification = TOOL_CLASSIFICATIONS[toolId] || null;
  if (classification && AUTO_APPROVED_CLASSIFICATIONS.includes(classification)) {
    return 'not_applicable';
  }

  const params = (job && job.task && job.task.params) || null;
  const content = params && typeof params.content === 'string' ? params.content.trim() : '';
  if (content === '') return null;

  try {
    const result = evaluateCompliance({
      content,
      content_type: typeof params.content_type === 'string' ? params.content_type : 'product_listing',
      platform_context: job.task.platform ? { platform: job.task.platform } : {},
      required_checks: ['platform_policy'],
      provenance: { source: 'scheduled_job', generator: 'agent' },
    });
    return result.status;
  } catch (err) {
    // An evaluation that could not run is not a pass. The policy blocks on a missing
    // verdict, which is the correct outcome.
    return null;
  }
}

// Builds the execution request for one job, through the EXISTING contract function rather
// than by hand, so a scheduled request is the same shape the Chief already produces for a
// dashboard request. Returns null when the tool no longer exists (a registry entry removed
// after the job was written), which the caller turns into a blocked outcome rather than a
// guess.
function buildScheduledExecutionRequest(job) {
  const tool = getToolById(job.task.tool_id);
  if (!tool) return null;
  return createExecutionRequest(
    job.task.objective,
    { category: tool.category, tool },
    // The declared parameters ride in research_params, which is where the existing
    // contract already puts a request's own inputs - and, because the approval
    // fingerprint covers the whole execution request, they become part of what a human
    // signs. Changing a parameter after approval invalidates the signature.
    job.task.params || null,
    job.business_id
  );
}

// Evaluates ONE already-claimed job against the autonomy policy.
//
// `enabledPlatforms` is passed in rather than read here for the same reason
// agent/core/toolPermissions.js takes it as an argument: one resolution per pass, and the
// scheduler cannot get a different answer from the gate it is feeding.
function evaluateScheduledJob(job, { enabledPlatforms, now = new Date(), businessPolicy = null, dailyUsage = null } = {}) {
  const executionRequest = buildScheduledExecutionRequest(job);
  if (!executionRequest) {
    return {
      outcome: 'blocked',
      execution_request: null,
      decision: null,
      reason: `This job names tool '${job.task.tool_id}', which is no longer in the tool registry. Nothing was requested.`,
    };
  }

  const decision = evaluateAutonomyPolicy({
    businessId: job.business_id,
    specialistId: executionRequest.specialist_id,
    toolId: executionRequest.tool_id,
    platform: job.task.platform,
    complianceVerdict: resolveComplianceVerdict(executionRequest.tool_id, job),
    // No approval is ever supplied by the scheduler. An agent cannot approve its own
    // action, and a scheduled action is the agent's own action by definition.
    humanApproval: null,
    now,
    businessPolicy,
    dailyUsage,
  });

  const outcome = decision.decision === 'ALLOW'
    ? 'allowed'
    : decision.decision === 'APPROVAL_REQUIRED'
      ? 'approval_required'
      : 'blocked';

  return { outcome, execution_request: executionRequest, decision, reason: decision.reason };
}

// One scheduler pass for ONE business.
//
// Business-scoped on purpose: there is no cross-business pass, so one business's schedule
// can never observe, delay or consume another's. A caller with several businesses runs this
// once per business, with that business's own enabled platforms.
//
// `persist: false` evaluates without claiming, for a caller that wants to see what a pass
// WOULD do. It cannot be used to execute anything - nothing here executes either way.
function runSchedulerPass({
  businessId = null,
  now = new Date(),
  rootDir = scheduleStore.getDefaultScheduleStoreDir(),
  enabledPlatforms = null,
  businessPolicy = null,
  dailyUsage = null,
  persist = true,
} = {}) {
  const startedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const results = [];

  // Resolved once per pass. A configuration that cannot be read leaves this null, and the
  // policy's platform gate then denies every platform-bound job - fail closed, never a
  // permissive default.
  let platforms = enabledPlatforms;
  if (!Array.isArray(platforms)) {
    try {
      platforms = businessId ? getEnabledPlatforms(businessId) : null;
    } catch (err) {
      platforms = null;
    }
  }

  let dueJobs;
  try {
    dueJobs = scheduleStore.listDueJobs({ businessId, now, rootDir });
  } catch (err) {
    // A store that cannot be listed yields an empty, honest pass rather than a crash.
    return { business_id: businessId || null, started_at: startedAt, considered: 0, results: [], store_error: true };
  }

  for (const dueJob of dueJobs) {
    try {
      const claim = persist
        ? scheduleStore.claimOccurrence(dueJob.job_id, { businessId, now, rootDir })
        : { claimed: true, job: dueJob, occurrence_key: null, reason_code: null, reason: null };

      if (!claim.claimed) {
        results.push({
          job_id: dueJob.job_id,
          occurrence_key: null,
          outcome: 'not_claimed',
          reason: claim.reason,
          reason_code: claim.reason_code,
          execution_request: null,
          decision: null,
        });
        continue;
      }

      const evaluated = evaluateScheduledJob(claim.job, { enabledPlatforms: platforms, now, businessPolicy, dailyUsage });

      if (persist) {
        scheduleStore.recordOccurrenceOutcome(dueJob.job_id, evaluated.outcome, { businessId, now, rootDir });
      }

      results.push({
        job_id: dueJob.job_id,
        occurrence_key: claim.occurrence_key,
        outcome: evaluated.outcome,
        reason: evaluated.reason,
        reason_code: evaluated.decision ? evaluated.decision.reason_code : null,
        execution_request: evaluated.execution_request,
        decision: evaluated.decision,
        // Carried through, never acted on here: autonomy/autonomousCycle.js runs these only
        // when this occurrence's observation detects a real change.
        follow_ups: Array.isArray(claim.job.task.follow_ups) ? claim.job.task.follow_ups : [],
      });
    } catch (err) {
      // Contained: this job failed, the pass continues. The underlying message is not
      // relayed - it can carry a path or a third-party detail.
      results.push({
        job_id: dueJob && dueJob.job_id ? dueJob.job_id : null,
        occurrence_key: null,
        outcome: 'error',
        reason: 'This scheduled job could not be evaluated. The rest of the pass was unaffected.',
        reason_code: 'job_evaluation_error',
        execution_request: null,
        decision: null,
      });
      if (persist && dueJob && dueJob.job_id) {
        try {
          scheduleStore.recordOccurrenceOutcome(dueJob.job_id, 'error', { businessId, now, rootDir });
        } catch (recordErr) {
          // Recording the outcome is best-effort; the claim itself is already durable.
        }
      }
    }
  }

  return {
    business_id: businessId || null,
    started_at: startedAt,
    considered: dueJobs.length,
    results,
    store_error: false,
  };
}

module.exports = {
  RUN_OUTCOMES,
  resolveComplianceVerdict,
  buildScheduledExecutionRequest,
  evaluateScheduledJob,
  runSchedulerPass,
};

if (require.main === module) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createScheduledJob } = require('./scheduleModel');
  const { AUTONOMY_KILL_SWITCH_ENV } = require('../agent/core/autonomyPolicy');

  console.log('Smart E-Commerce Growth AI Agent - scheduler pass (creates requests, executes nothing):\n');

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-runner-demo-'));
  const now = new Date('2026-03-04T09:07:00.000Z');
  const businessPolicy = { ok: true, business_id: 'alpha-co', enabled_platforms: ['shopify'], autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null } };
  const dailyUsage = { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0, runs_missing_usage: 0, coverage_complete: true };

  const job = (jobId, toolId, objective, params = null) =>
    scheduleStore.saveScheduledJob(
      createScheduledJob({
        jobId,
        businessId: 'alpha-co',
        enabled: true,
        schedule: { kind: 'interval_minutes', every: 60 },
        task: { tool_id: toolId, objective, platform: 'shopify', params },
        now,
      }),
      { rootDir }
    );

  job('observe-products', 'product_data_retrieval', 'Observe the product catalogue.');
  job('correct-vendor', 'shopify_vendor_correction', 'Correct a product vendor field.');
  job('correct-vendor-declared', 'shopify_vendor_correction', 'Correct a product vendor field.', {
    content: 'Aurora Ceramics',
    productId: 'gid://shopify/Product/1',
    newVendor: 'Aurora Ceramics',
  });

  const show = (label, pass) => {
    console.log(label);
    for (const result of pass.results) {
      console.log(`  ${result.job_id.padEnd(18)} ${result.outcome.padEnd(18)} ${result.reason_code || ''}`);
    }
    console.log('');
  };

  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';
  show('Kill switch ON:', runSchedulerPass({ businessId: 'alpha-co', now, rootDir, enabledPlatforms: ['shopify'], businessPolicy, dailyUsage }));

  console.log('Same pass again, same hour - the occurrences are already claimed:');
  const repeat = runSchedulerPass({ businessId: 'alpha-co', now: new Date('2026-03-04T09:45:00.000Z'), rootDir, enabledPlatforms: ['shopify'], businessPolicy, dailyUsage });
  console.log(`  considered: ${repeat.considered} job(s) - a restart in between would change nothing\n`);

  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'false';
  show('Next hour, kill switch OFF:', runSchedulerPass({ businessId: 'alpha-co', now: new Date('2026-03-04T10:00:00.000Z'), rootDir, enabledPlatforms: ['shopify'], businessPolicy, dailyUsage }));

  delete process.env[AUTONOMY_KILL_SWITCH_ENV];
  fs.rmSync(rootDir, { recursive: true, force: true });
}
