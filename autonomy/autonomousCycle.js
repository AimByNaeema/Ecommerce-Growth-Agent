'use strict';

// THE CONTROLLED AUTONOMOUS CYCLE: the one place the existing pieces are wired into a loop
// that can run without a human starting it.
//
//   Scheduler -> Monitor -> Change detection -> Chief execution contract -> Compliance
//   -> Autonomy policy -> ALLOW or APPROVAL_REQUIRED -> Circuit breaker -> Idempotency
//   -> Execute -> Verify -> Audit -> Persist -> next cycle
//
// IT ADDS NO DECISION LOGIC OF ITS OWN. Every gate below already exists and is CALLED, not
// reimplemented:
//   business identity, platform enablement, tool authorization, budget, compliance,
//   the approval requirement and the kill switch  -> agent/core/autonomyPolicy.js
//   which jobs are due, and once only                -> scheduler/
//   what actually changed on the platform            -> monitoring/
//   is this integration working                      -> reliability/circuitBreaker.js
//   did it actually happen, and only once            -> reliability/executionVerification.js
//   how a capability is executed                     -> agent/core/orchestratorExecutionContract.js
//   what happened, for the record                    -> audit/auditTrail.js, agent/core/runHistoryStore.js
// This file contributes ORDER and REFUSAL, nothing else. There is no second orchestrator,
// no second policy, no second budget, no second approval mechanism here.
//
// THE HARD RULES, AND WHERE EACH IS ENFORCED:
//   compliance BLOCK           -> the policy blocks; this file never overrides it
//   kill switch OFF            -> the policy blocks every autonomous action
//   budget exhausted           -> the policy blocks before the consequential step
//   circuit breaker OPEN       -> checked here, BEFORE execution
//   disabled platform          -> the policy blocks, and the monitor never queries it
//   unauthorized tool          -> the policy blocks
//   missing policy data        -> the policy blocks
//   consequential action       -> APPROVAL_REQUIRED, and the cycle STOPS there
//   human approval             -> never supplied by this file. Not once, not anywhere.
//
// AN AGENT CANNOT APPROVE ITS OWN ACTION. This module never constructs, signs, verifies or
// passes an approval object, and there is deliberately no parameter through which one could
// be injected into a cycle. When the policy says APPROVAL_REQUIRED the cycle QUEUES a
// durable pending approval for a human - which is the opposite of approving it - and moves
// on. It never decides that request, never waits for it, and a later cycle simply finds it
// already pending. approvals/approvalWorkflow.js remains the only thing that can move a
// request out of pending, and only with an Ed25519 signature verified by
// approvals/approvalArchitecture.js; approvals/publishAuthorization.js remains the only
// thing that can authorize publishing.
//
// IDEMPOTENT ACROSS RESTARTS, AT TWO LEVELS. The scheduler claims each occurrence exactly
// once from a key derived from the schedule (so a restart recomputes the same key and finds
// it claimed), and every consequential attempt carries a derived idempotency key that is
// refused once it has completed. A restart mid-cycle cannot duplicate an executed action.
//
// NO SECRET IS EVER PERSISTED. A cycle record holds ids, decisions, reason codes and
// counts. Every store it writes through refuses a credential-shaped key.

const { runSchedulerPass, evaluateScheduledJob } = require('../scheduler/scheduleRunner');
const { observePlatform } = require('../monitoring/platformMonitor');
const {
  executeSelectedCapability,
  prepareApprovalExecutionRequest,
  buildPlanStep,
  buildSpecialistTarget,
  buildSharedInfrastructureTarget,
  isGatedForApproval,
  validateResult,
} = require('../agent/core/orchestratorExecutionContract');
const { getSpecialistCapabilityById } = require('../agent/core/specialistCapabilityRegistry');
const { getToolsByCategory } = require('../tools/toolRegistry');
const { isCorrectionTool, maySelectMutationTool, mutationIntentRefusalReason } = require('../agent/core/mutationIntent');
const { getMaxArrayFieldEntries } = require('../agent/core/executionBounds');
const { createUsageTracker } = require('../agent/core/usageLimits');
const { createUsageLedger, appendUsageEvent, summarizeUsage } = require('../usage/usageTracker');
const { getRelevantMemoryContext, persistVerifiedFinding } = require('../agent/core/memoryContextRetrieval');
const { summarizeExecutionState } = require('../agent/core/resultSummary');
const { isValidBusinessId } = require('../configuration/businessRegistry');
const { TOOL_CLASSIFICATIONS } = require('../agent/core/toolPermissions');
const { requiresApproval, computeExecutionFingerprint } = require('../approvals/approvalArchitecture');
const circuitBreaker = require('../reliability/circuitBreaker');
const executionVerification = require('../reliability/executionVerification');
const { createAndPersistApprovalRequest } = require('../approvals/approvalWorkflow');
const approvalStore = require('../approvals/approvalStore');
const { createAuditTracker, appendAuditEvent } = require('../audit/auditTrail');
const runHistoryStore = require('../agent/core/runHistoryStore');

// What one job's pass through the cycle concluded. Machine-readable, and every value is a
// terminal state - a cycle step never ends in "maybe".
const CYCLE_OUTCOMES = [
  'observed',            // an observation job ran; changes (if any) are reported
  'executed',            // a low-risk action ran and verified, or needed no verification
  'approval_required',   // consequential: it stops here and waits for a real human
  'blocked',             // a gate refused it (policy, breaker, idempotency)
  'verification_failed', // it ran, and the platform does not show what was expected
  'execution_failed',    // it ran and the execution itself failed
  'not_claimed',         // no unclaimed occurrence
  'error',               // this job faulted; the cycle continued
];

// The tools whose job is to OBSERVE rather than to act. For these the cycle runs a monitoring
// pass instead of a capability execution, because their whole purpose is to produce a
// snapshot and a diff.
//
// DECLARED PER PLATFORM IN integrations/adapters/adapterRegistry.js, beside the adapter that
// serves the read - this file carries no platform-specific list, so a newly onboarded platform
// needs no edit here. Read live on every decision.
const {
  REGISTERED_READ_PLATFORMS,
  getObservationToolIds,
  isObservationTool,
  isObservationToolFor,
} = require('../integrations/adapters/adapterRegistry');

// A load-time listing for inspection only; every decision below asks the registry live.
const OBSERVATION_TOOL_IDS = REGISTERED_READ_PLATFORMS.flatMap((platform) => getObservationToolIds(platform));

// With no platform: does this tool observe any platform? With one: does it observe THAT one?
function isObservationJob(toolId, platform = undefined) {
  return platform === undefined ? isObservationTool(toolId) : isObservationToolFor(toolId, platform);
}

// Whether this action is consequential, from the EXISTING classification only. A tool with
// no classification counts as consequential - the default-deny requiresApproval() already
// encodes that, and it is reused rather than restated.
function isConsequential(toolId) {
  return requiresApproval(TOOL_CLASSIFICATIONS[toolId] || null);
}

// A stable, filename-safe approval id for one job occurrence. Derived, never generated:
// approvals/approvalStore.js strips anything outside its safe character set, so the
// occurrence timestamp is compacted here rather than being silently mangled there.
function durableApprovalId(jobId, occurrenceKey) {
  const occurrence = String(occurrenceKey || 'unscheduled').replace(/[-:.]/g, '');
  return `apr-${jobId}-${occurrence}`;
}

// THE SAME ACTION, WHICHEVER OCCURRENCE QUEUED IT. The approval fingerprint of the execution
// request without the autonomy marker (cycle, job and occurrence differ every time) and
// without provenance - so two occurrences asking for exactly the same change compare equal,
// while any difference in tool, business, parameters or computed compliance does not. The
// compliance summary's check time is the only part of the verdict left out: it differs on
// every evaluation of identical content.
function actionFingerprint(executionRequest) {
  const source = executionRequest && typeof executionRequest === 'object' ? executionRequest : {};
  const action = {};
  for (const key of Object.keys(source)) {
    if (key === 'autonomy' || key === 'approval_provenance') continue;
    action[key] = source[key];
  }
  if (action.compliance && typeof action.compliance === 'object') {
    const { compliance_checked_at: checkedAt, ...verdict } = action.compliance;
    action.compliance = verdict;
  }
  return computeExecutionFingerprint(action);
}

// A still-pending autonomous approval for exactly this business and exactly this action, or
// null. Read from the existing durable approval store; the business match is exact, because
// the store's own filter treats a null business as "any".
function findPendingIdenticalApproval({ businessId, toolId, executionRequest, storeOptions }) {
  const expected = businessId || null;
  const fingerprint = actionFingerprint(executionRequest);
  return (
    approvalStore.listPendingApprovals({ businessId: expected, ...storeOptions }).find((envelope) => {
      const record = envelope.approval_request;
      const origin = record && record.execution_request && record.execution_request.autonomy;
      return (
        (envelope.business_id || null) === expected &&
        record.tool_id === toolId &&
        Boolean(origin) &&
        origin.origin === 'autonomous_cycle' &&
        actionFingerprint(record.execution_request) === fingerprint
      );
    }) || null
  );
}

// Whether an observation's result is a real change a follow-up may act on. Incomplete
// observation semantics are preserved exactly: a first (baseline) observation, an identical
// one, and one where no capability was comparable all start nothing - a follow-up is never
// handed a change the monitor could not establish.
function followUpTrigger(changes) {
  if (!changes || typeof changes !== 'object') return { triggered: false, reason_code: 'no_observation' };
  if (changes.baseline) return { triggered: false, reason_code: 'baseline_observation' };
  if (changes.identical) return { triggered: false, reason_code: 'no_change' };
  const counts = changes.counts || {};
  const total = (counts.added || 0) + (counts.removed || 0) + (counts.changed || 0);
  if (total === 0) return { triggered: false, reason_code: 'no_change' };
  const comparable = (changes.capabilities || []).filter((entry) => entry.status === 'compared' || entry.status === 'compared_partial');
  if (comparable.length === 0) return { triggered: false, reason_code: 'not_comparable' };
  return { triggered: true, reason_code: null };
}

// The detected change as a follow-up receives it: the monitor's own output, never a
// summary written here. Each capability keeps its comparison status, so a partial
// comparison is visible to the capability. The change list is included only when it fits
// agent/core/executionBounds.js's array ceiling - it is omitted (and says so), never cut.
function detectedChangesParam(changes) {
  const list = Array.isArray(changes.changes) ? changes.changes : [];
  const included = list.length <= getMaxArrayFieldEntries();
  return {
    platform: changes.platform || null,
    current_snapshot_id: changes.current_snapshot_id || null,
    previous_snapshot_id: changes.previous_snapshot_id || null,
    counts: changes.counts,
    capabilities: (changes.capabilities || []).map((entry) => ({ capability: entry.capability, status: entry.status })),
    changes: included ? list : null,
    changes_included: included,
  };
}

// This business's own verified/approved memory, through the existing retrieval - how what an
// earlier cycle verified reaches the next one. Unreadable memory contributes nothing.
function relevantMemoryFor(businessId) {
  try {
    const context = getRelevantMemoryContext(businessId);
    return context && Array.isArray(context.relevant_memory) ? { relevant_memory: context.relevant_memory } : {};
  } catch (err) {
    return {};
  }
}

// WHICH CHIEF TARGET GENUINELY OWNS THIS REQUEST'S TOOL, or null.
//
// buildPlanStep's forcedSelection pins a tool only when the target actually owns it; for any
// other tool it falls back to word-overlap routing, which could run a different capability
// than the one scheduled. So ownership is confirmed first, against the same registries
// buildPlanStep reads, and an unowned tool is never handed to it.
function chiefTargetFor(executionRequest) {
  const toolId = executionRequest && executionRequest.tool_id;
  if (!toolId) return null;
  try {
    if (executionRequest.is_shared_infrastructure) {
      if (!getToolsByCategory(executionRequest.category).some((tool) => tool.id === toolId)) return null;
      return buildSharedInfrastructureTarget(executionRequest.category);
    }
    const entry = getSpecialistCapabilityById(executionRequest.specialist_id);
    if (!entry || !Array.isArray(entry.required_tools) || !entry.required_tools.includes(toolId)) return null;
    return buildSpecialistTarget(executionRequest.specialist_id);
  } catch (err) {
    return null;
  }
}

// The Chief's own verdict on one plan step, reduced to what the cycle acts on:
//   complete       - dispatched, and the result passed the Chief's result validation
//   failed         - dispatched, and the call or the tool itself failed
//   unverified     - dispatched, but the tool's own result was empty or partial
//   not_dispatched - the Chief stopped before dispatch (missing input, ambiguity, denial)
//   gated          - the step asks for approval, which is never trusted as autonomous
function classifyPlanStep(step) {
  const errors = step && Array.isArray(step.errors) ? step.errors : [];
  const base = { error: errors[0] || null, capability_id: step && step.inputs ? step.inputs.capability_id || null : null };
  if (!step) return { kind: 'not_dispatched', ...base };
  if (isGatedForApproval(step)) return { kind: 'gated', ...base };
  if (step.completion_state === 'complete') return { kind: 'complete', ...base };
  const dispatched = Array.isArray(step.approvals) && step.approvals.some((approval) => approval.status === 'auto_approved');
  if (!dispatched) return { kind: 'not_dispatched', ...base };
  if (step.completion_state === 'failed') return { kind: 'failed', ...base };
  return { kind: 'unverified', ...base };
}

// The same verdict for an injected executor's raw outcome (the isolated-test seam), judged by
// the Chief's own validateResult so both paths treat a tool's inner status identically.
function classifyOutcome(outcome) {
  const error = outcome && typeof outcome.error === 'string' ? outcome.error : null;
  if (outcome && outcome.status === 'approval_required') return { kind: 'gated', error, capability_id: null };
  const verdict = validateResult(outcome);
  if (verdict === 'passed') return { kind: 'complete', error, capability_id: null };
  if (outcome && (outcome.status === 'success' || outcome.status === 'error')) {
    return { kind: verdict === 'failed' ? 'failed' : 'unverified', error, capability_id: null };
  }
  return { kind: 'not_dispatched', error, capability_id: null };
}

function cycleStep(jobId, outcome, extra = {}) {
  return {
    job_id: jobId,
    outcome,
    reason_code: null,
    reason: null,
    policy_decision: null,
    changes: null,
    verification: null,
    approval_request_id: null,
    approval_state: null,
    executed: false,
    ...extra,
  };
}

// Runs ONE cycle for ONE business.
//
// Business-scoped like every other pass in this architecture: there is no cross-business
// cycle, so one business's work can never observe, delay, or consume another's.
//
// `executor` and `adapter` exist so this can be exercised without a network call. Both
// default to the real thing; `executor` defaults to the EXISTING Chief execution contract,
// which is the only way a capability is ever executed here.
async function runAutonomousCycle({
  businessId = null,
  now = new Date(),
  enabledPlatforms = null,
  businessPolicy = null,
  dailyUsage = null,
  scheduleRootDir = undefined,
  snapshotRootDir = undefined,
  circuitRootDir = undefined,
  verificationRootDir = undefined,
  approvalRootDir = undefined,
  runHistoryStoreDir = undefined,
  executor = executeSelectedCapability,
  adapter = null,
  persist = true,
} = {}) {
  const startedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const cycleId = `cycle-${businessId || '_default'}-${startedAt.replace(/[-:.]/g, '')}`;
  const audit = createAuditTracker(cycleId, businessId || null);
  const steps = [];
  // THIS CYCLE'S SPEND, RECORDED LIKE EVERY OTHER RUN'S. agent/core/dailyUsageAccounting.js
  // treats a saved run with no usage ledger as UNKNOWN spend, and the policy then refuses all
  // autonomous work for the rest of the day - so a cycle that recorded none would block every
  // later cycle. The existing ledger and per-run trackers are passed to the Chief contract.
  const usageLedger = createUsageLedger(cycleId, businessId || null);
  const usageTracker = createUsageTracker();
  const runTokenTracker = { tokensUsedThisRun: 0 };

  appendAuditEvent(audit, {
    type: 'request',
    status: 'started',
    summary: `Autonomous cycle started for business '${businessId || '(default)'}'.`,
  });

  // --- Scheduler: which jobs are due, claimed once, and what the policy says about each ---
  const schedulerPass = runSchedulerPass({
    businessId,
    now,
    rootDir: scheduleRootDir,
    enabledPlatforms,
    businessPolicy,
    dailyUsage,
    persist,
  });

  // MONITORING -> CHIEF: a real, detected change hands the owner-declared follow-ups to the
  // existing capability path. Each follow-up is evaluated by the scheduler's own
  // evaluateScheduledJob (policy, permission, platform, budget, compliance) and then handled
  // exactly like a scheduled job below - an analysis capability runs through the Chief
  // contract, a consequential one is queued for approval. Nothing here decides on its own.
  const runFollowUps = async (parentResult, changes, platform) => {
    const followUps = Array.isArray(parentResult.follow_ups) ? parentResult.follow_ups : [];
    if (followUps.length === 0) return;

    const trigger = followUpTrigger(changes);
    if (!trigger.triggered) {
      appendAuditEvent(audit, {
        type: 'agent',
        status: 'skipped',
        summary: `Follow-ups for '${parentResult.job_id}' were not started: ${trigger.reason_code}.`,
      });
      return;
    }

    const memoryContext = relevantMemoryFor(businessId);
    for (let index = 0; index < followUps.length; index += 1) {
      const followUp = followUps[index];
      const jobId = `${parentResult.job_id}--follow-up-${index + 1}`;
      if (!followUp || isObservationJob(followUp.tool_id)) {
        steps.push({
          ...cycleStep(jobId, 'blocked', {
            reason_code: 'follow_up_not_actionable',
            reason: 'A follow-up must be a capability to run on the detected change, not another observation.',
          }),
          parent_job_id: parentResult.job_id,
        });
        continue;
      }

      let evaluated;
      try {
        evaluated = evaluateScheduledJob(
          {
            job_id: jobId,
            business_id: businessId || null,
            task: {
              tool_id: followUp.tool_id,
              objective: followUp.objective,
              platform,
              params: { ...(followUp.params || {}), detected_changes: detectedChangesParam(changes), ...memoryContext },
            },
          },
          { enabledPlatforms, now, businessPolicy, dailyUsage }
        );
      } catch (err) {
        steps.push({
          ...cycleStep(jobId, 'error', { reason_code: 'follow_up_evaluation_error', reason: 'This follow-up could not be evaluated. The rest of the cycle was unaffected.' }),
          parent_job_id: parentResult.job_id,
        });
        continue;
      }

      await processJob(
        {
          job_id: jobId,
          occurrence_key: parentResult.occurrence_key,
          outcome: evaluated.outcome,
          reason: evaluated.reason,
          reason_code: evaluated.decision ? evaluated.decision.reason_code : null,
          execution_request: evaluated.execution_request,
          decision: evaluated.decision,
          follow_ups: [],
        },
        parentResult.job_id
      );
    }
  };

  const handleJob = async (jobResult, parentJobId) => {
    const toolId = jobResult.execution_request ? jobResult.execution_request.tool_id : null;
    const platform = jobResult.decision ? jobResult.decision.platform : null;

    try {
      // --- The policy's verdict is final in the restrictive direction ------------------
      if (jobResult.outcome === 'not_claimed') {
        steps.push(cycleStep(jobResult.job_id, 'not_claimed', { reason_code: jobResult.reason_code, reason: jobResult.reason }));
        return;
      }
      if (jobResult.outcome === 'error') {
        steps.push(cycleStep(jobResult.job_id, 'error', { reason_code: jobResult.reason_code, reason: jobResult.reason }));
        return;
      }
      if (jobResult.outcome === 'blocked') {
        appendAuditEvent(audit, {
          type: 'tools',
          toolId,
          status: 'blocked',
          summary: `Autonomy policy blocked '${toolId}': ${jobResult.reason_code}.`,
        });
        steps.push(cycleStep(jobResult.job_id, 'blocked', { reason_code: jobResult.reason_code, reason: jobResult.reason, policy_decision: jobResult.decision }));
        return;
      }
      if (jobResult.outcome === 'approval_required') {
        // THE CYCLE STOPS HERE, AND HANDS THE ACTION TO A HUMAN.
        //
        // A durable approval request is QUEUED so the action survives a restart and can be
        // decided by the owner (autonomy/approvalResolution.js). The cycle does not decide it,
        // cannot decide it, and does not wait for it - the next cycle simply finds it already
        // pending. approvals/approvalWorkflow.js remains the only thing that can move it out of
        // pending, and only with a verified Ed25519 signature.
        //
        // THE ID IS DERIVED FROM THE OCCURRENCE, NOT GENERATED. The same job occurrence always
        // produces the same approval id, so a restarted or repeated cycle finds the existing
        // request instead of queueing a second one for the same action.
        const approvalId = durableApprovalId(jobResult.job_id, jobResult.occurrence_key);
        const storeOptions = approvalRootDir ? { storeDir: approvalRootDir } : {};
        let approvalState = null;
        try {
          const existing = approvalStore.loadApprovalRecord(approvalId, { expectedBusinessId: businessId || null, ...storeOptions });
          if (existing) {
            approvalState = existing.approval_request ? existing.approval_request.status : 'pending';
          } else {
            // THE SAME REFUSALS THE CHIEF MAKES BEFORE IT WILL CREATE AN APPROVAL, called rather
            // than restated: a mutation with no explicit instruction to mutate is never queued,
            // and a correction's compliance input is computed and evaluated for real
            // (prepareApprovalExecutionRequest). A BLOCK queues nothing at all.
            if (isCorrectionTool(toolId) && !maySelectMutationTool(jobResult.execution_request.objective)) {
              const reason = mutationIntentRefusalReason(toolId, jobResult.execution_request.objective);
              appendAuditEvent(audit, { type: 'error', toolId, status: 'denied', summary: reason });
              steps.push(cycleStep(jobResult.job_id, 'blocked', { reason_code: 'mutation_intent_missing', reason, policy_decision: jobResult.decision }));
              return;
            }
            const prepared = prepareApprovalExecutionRequest(toolId, {
              ...jobResult.execution_request,
              // Where this request came from - inside what the human signs, and what
              // autonomy/approvalResolution.js requires before it will resolve a durable record.
              autonomy: {
                origin: 'autonomous_cycle',
                cycle_id: cycleId,
                job_id: jobResult.job_id,
                occurrence_key: jobResult.occurrence_key || null,
                platform: platform || null,
              },
            });
            if (!prepared.ok) {
              appendAuditEvent(audit, { type: prepared.audit_type, toolId, status: prepared.audit_status, summary: prepared.reason });
              steps.push(cycleStep(jobResult.job_id, 'blocked', {
                reason_code: prepared.compliance_status === 'BLOCK' ? 'compliance_block' : 'compliance_unevaluable',
                reason: prepared.reason,
                policy_decision: jobResult.decision,
              }));
              return;
            }
            // NO REPEATED IDENTICAL ACTION WITHOUT REASON. An occurrence asking for exactly the
            // change an earlier occurrence is still waiting on queues nothing new: the owner is
            // pointed at the one already pending, so the same change can never be approved -
            // and executed - twice.
            const duplicate = findPendingIdenticalApproval({ businessId, toolId, executionRequest: prepared.executionRequest, storeOptions });
            if (duplicate) {
              appendAuditEvent(audit, {
                type: 'approval',
                toolId,
                status: 'required',
                summary: `'${toolId}' is already waiting for a human decision as approval '${duplicate.approval_id}'. The identical action was not queued again.`,
              });
              steps.push(cycleStep(jobResult.job_id, 'approval_required', {
                reason_code: 'approval_already_pending',
                reason: 'An identical action is already waiting for a human decision, so it was not queued a second time.',
                policy_decision: jobResult.decision,
                approval_request_id: duplicate.approval_id,
                approval_state: 'pending',
              }));
              return;
            }
            if (persist) {
              createAndPersistApprovalRequest(
                {
                  id: approvalId,
                  classification: jobResult.decision ? jobResult.decision.classification : null,
                  specialistId: jobResult.execution_request.specialist_id,
                  toolId,
                  executionRequest: prepared.executionRequest,
                  reason: jobResult.reason,
                },
                storeOptions
              );
              approvalState = 'pending';
            }
          }
        } catch (err) {
          // Failing to queue the approval must not be reported as anything having executed.
          // The step below still records that the action requires approval.
          approvalState = null;
        }

        appendAuditEvent(audit, {
          type: 'approval',
          toolId,
          status: 'required',
          summary: `'${toolId}' is consequential and requires a verified human approval. The cycle did not execute it; approval '${approvalId}' is ${approvalState || 'not queued'}.`,
        });
        steps.push(cycleStep(jobResult.job_id, 'approval_required', {
          reason_code: jobResult.reason_code,
          reason: jobResult.reason,
          policy_decision: jobResult.decision,
          approval_request_id: approvalId,
          approval_state: approvalState,
        }));
        return;
      }

      // --- Circuit breaker: checked BEFORE anything is attempted ----------------------
      const breaker = circuitBreaker.checkCircuit({ businessId, platform, action: toolId, now, rootDir: circuitRootDir });
      if (!breaker.allowed) {
        appendAuditEvent(audit, {
          type: 'tools',
          toolId,
          status: 'blocked',
          summary: `Circuit breaker refused '${toolId}': ${breaker.reason_code}.`,
        });
        steps.push(cycleStep(jobResult.job_id, 'blocked', { reason_code: breaker.reason_code, reason: breaker.reason, policy_decision: jobResult.decision }));
        return;
      }

      // --- Observation jobs: monitor + change detection, never an execution -----------
      if (isObservationJob(toolId)) {
        // An observation tool observes only the platform its registration declares. Without
        // this, an Etsy observation tool scheduled against 'shopify' would read Shopify.
        if (!isObservationJob(toolId, platform)) {
          appendAuditEvent(audit, { type: 'error', toolId, status: 'blocked', summary: `'${toolId}' is not declared to observe '${platform}', so nothing was observed.` });
          steps.push(cycleStep(jobResult.job_id, 'blocked', {
            reason_code: 'observation_platform_mismatch',
            reason: `This observation tool is not declared for platform '${platform}', so that platform was not read.`,
            policy_decision: jobResult.decision,
          }));
          return;
        }
        const observation = await observePlatform({
          businessId,
          platform,
          enabledPlatforms,
          adapter,
          now,
          rootDir: snapshotRootDir,
          persist,
        });

        if (!observation.observed) {
          circuitBreaker.recordFailure({ businessId, platform, action: toolId, now, rootDir: circuitRootDir });
          appendAuditEvent(audit, { type: 'data_access', toolId, status: 'error', summary: `Observation refused: ${observation.reason_code}.` });
          steps.push(cycleStep(jobResult.job_id, 'blocked', { reason_code: observation.reason_code, reason: observation.reason, policy_decision: jobResult.decision }));
          return;
        }

        circuitBreaker.recordSuccess({ businessId, platform, action: toolId, now, rootDir: circuitRootDir });
        appendUsageEvent(usageLedger, {
          category: 'tool_call',
          toolId,
          isExternalApi: true,
          quantity: 1,
          status: 'success',
          summary: `Monitoring observation of ${platform}.`,
        });
        appendAuditEvent(audit, {
          type: 'data_access',
          toolId,
          status: 'success',
          summary: `Observed ${platform}: ${observation.changes.counts.added} added, ${observation.changes.counts.removed} removed, ${observation.changes.counts.changed} changed.`,
        });
        steps.push(
          cycleStep(jobResult.job_id, 'observed', {
            policy_decision: jobResult.decision,
            changes: observation.changes,
          })
        );
        if (parentJobId === null) {
          await runFollowUps(jobResult, observation.changes, platform);
        }
        return;
      }

      // --- A non-observation job the policy ALLOWED is by definition low-risk ---------
      // The policy only ever returns ALLOW without an approval for a class that
      // requiresApproval() says needs none. This is a second, independent assertion of that
      // same fact: if this ever disagrees with the policy, the cycle refuses rather than
      // resolving the disagreement in favour of acting.
      if (isConsequential(toolId)) {
        appendAuditEvent(audit, {
          type: 'error',
          toolId,
          status: 'blocked',
          summary: `Refused to execute '${toolId}': it is consequential, so an ALLOW without a human approval is not trusted.`,
        });
        steps.push(
          cycleStep(jobResult.job_id, 'blocked', {
            reason_code: 'consequential_without_approval',
            reason: 'This action is consequential and carried no verified human approval, so the cycle refused it regardless of the policy verdict.',
            policy_decision: jobResult.decision,
          })
        );
        return;
      }

      // --- Idempotency: has this exact work already completed? ------------------------
      const idempotencyKey = executionVerification.computeIdempotencyKey({
        businessId,
        platform,
        action: toolId,
        entityKind: 'capability_run',
        // One job's one occurrence. The job id is part of it because follow-ups share their
        // parent's occurrence, and two follow-ups may run the same tool on different input.
        entityId: `${jobResult.job_id}@${jobResult.occurrence_key || 'unscheduled'}`,
        expected: null,
      });
      const idempotency = executionVerification.checkIdempotency(idempotencyKey, { businessId, rootDir: verificationRootDir });
      if (!idempotency.allowed) {
        steps.push(cycleStep(jobResult.job_id, 'blocked', { reason_code: idempotency.reason_code, reason: idempotency.reason, policy_decision: jobResult.decision }));
        return;
      }

      // VERIFY -> PERSIST. Every dispatched outcome is written to the existing verification
      // store under the key checked above, so the idempotency guard reads real completions
      // rather than a store nothing writes. Only a result that passed the Chief's own
      // validation is 'verified'; an empty/partial one is 'unverifiable' and a failed one is
      // 'failed' - both still permit a later, deliberate occurrence, never an immediate retry.
      // A store failure never turns an outcome into something it was not.
      const recordVerification = (status, reasonCode, reason) => {
        if (!persist) return status;
        try {
          executionVerification.saveVerificationRecord(
            {
              verification_version: executionVerification.VERIFICATION_VERSION,
              idempotency_key: idempotencyKey,
              business_id: businessId || null,
              platform: platform || null,
              action: toolId,
              entity_kind: 'capability_run',
              entity_id: `${jobResult.job_id}@${jobResult.occurrence_key || 'unscheduled'}`,
              status,
              verified: status === 'verified',
              reason_code: reasonCode,
              reason,
              findings: [],
              unintended_mutations: [],
              verified_at: startedAt,
            },
            { rootDir: verificationRootDir }
          );
        } catch (err) {
          // Recorded honestly in the cycle record either way.
        }
        return status;
      };

      // --- Execute, through the Chief's OWN plan step ---------------------------------
      // The same buildPlanStep every human path (/run, /orchestrate, the growth workflow)
      // uses: it resolves the capability the scheduled tool serves, stops BEFORE dispatch when
      // that capability's required input is missing or ambiguous, merges business and memory
      // context, executes through executeSelectedCapability (permission, approval gate, usage,
      // audit), and derives the result from the tool's OWN status - so a tool that returns
      // 'failed' or 'empty' is never recorded as executed. The scheduled tool is pinned with
      // forcedSelection, only after confirming the target genuinely owns it.
      //
      // An injected `executor` remains a narrow seam for isolated tests of the cycle's own
      // ordering; its outcome is judged by the same Chief validation.
      let result;
      let planStep = null;
      try {
        if (executor === executeSelectedCapability) {
          const target = chiefTargetFor(jobResult.execution_request);
          if (!target) {
            appendAuditEvent(audit, { type: 'error', toolId, status: 'blocked', summary: `No Chief target owns '${toolId}', so it was not dispatched.` });
            steps.push(cycleStep(jobResult.job_id, 'blocked', {
              reason_code: 'capability_not_owned',
              reason: 'No specialist or shared-infrastructure capability owns this tool, so the Chief cannot run it as scheduled.',
              policy_decision: jobResult.decision,
            }));
            return;
          }
          const request = jobResult.execution_request;
          planStep = await buildPlanStep(
            target,
            request.objective,
            request.objective,
            runTokenTracker,
            request.research_params,
            [],
            { requests: [] },
            audit,
            null,
            usageTracker,
            businessId || null,
            usageLedger,
            { toolId }
          );
          result = planStep && planStep.inputs && planStep.inputs.tool_id === toolId
            ? classifyPlanStep(planStep)
            : { kind: 'failed', error: 'The Chief resolved a different capability than the one scheduled.', capability_id: null };
        } else {
          result = classifyOutcome(await executor(jobResult.execution_request, runTokenTracker, { requests: [] }, audit, null, usageTracker, usageLedger));
        }
      } catch (err) {
        circuitBreaker.recordFailure({ businessId, platform, action: toolId, now, rootDir: circuitRootDir });
        appendAuditEvent(audit, { type: 'error', toolId, status: 'error', summary: `Execution of '${toolId}' threw. Nothing is assumed to have happened.` });
        steps.push(cycleStep(jobResult.job_id, 'execution_failed', {
          reason_code: 'execution_threw',
          reason: 'The execution did not complete. No result is assumed.',
          policy_decision: jobResult.decision,
          verification: recordVerification('failed', 'execution_threw', 'The execution did not complete. No result is assumed.'),
        }));
        return;
      }

      const stepExtra = { policy_decision: jobResult.decision, capability_id: result.capability_id };

      if (result.kind === 'gated') {
        appendAuditEvent(audit, { type: 'error', toolId, status: 'blocked', summary: `'${toolId}' asked for approval inside an autonomous step; it was not trusted.` });
        steps.push(cycleStep(jobResult.job_id, 'blocked', {
          ...stepExtra,
          reason_code: 'consequential_without_approval',
          reason: 'This step required approval, which an autonomous cycle never supplies.',
        }));
        return;
      }

      // Stopped before dispatch: nothing ran, so the integration's health is not in question.
      if (result.kind === 'not_dispatched') {
        appendAuditEvent(audit, { type: 'agent', toolId, status: 'blocked', summary: `The Chief did not dispatch '${toolId}': ${result.error || 'no reason given'}` });
        steps.push(cycleStep(jobResult.job_id, 'blocked', {
          ...stepExtra,
          reason_code: 'capability_not_dispatched',
          reason: result.error || 'The Chief stopped before dispatching this capability.',
        }));
        return;
      }

      if (result.kind === 'failed') {
        circuitBreaker.recordFailure({ businessId, platform, action: toolId, now, rootDir: circuitRootDir });
        appendAuditEvent(audit, { type: 'error', toolId, status: 'error', summary: `Execution of '${toolId}' did not succeed.` });
        steps.push(cycleStep(jobResult.job_id, 'execution_failed', {
          ...stepExtra,
          reason_code: 'execution_unsuccessful',
          reason: result.error || 'The capability did not report success.',
          executed: true,
          verification: recordVerification('failed', 'execution_unsuccessful', result.error || 'The capability did not report success.'),
        }));
        return;
      }

      // It ran, but its own result was empty or partial: not a failure of the integration,
      // and never an executed-and-verified outcome either.
      if (result.kind === 'unverified') {
        appendAuditEvent(audit, { type: 'result', toolId, status: 'unverified', summary: `'${toolId}' ran but returned no usable, verified result.` });
        steps.push(cycleStep(jobResult.job_id, 'verification_failed', {
          ...stepExtra,
          reason_code: 'result_unverified',
          reason: result.error || 'The capability ran but its own result was empty or partial, so nothing was verified.',
          executed: true,
          verification: recordVerification('unverifiable', 'result_unverified', result.error || 'The capability ran but its own result was empty or partial, so nothing was verified.'),
        }));
        return;
      }

      circuitBreaker.recordSuccess({ businessId, platform, action: toolId, now, rootDir: circuitRootDir });
      appendAuditEvent(audit, { type: 'execution', toolId, status: 'success', summary: `'${toolId}' completed and its result passed validation.` });
      const verification = recordVerification('verified', null, null);

      // LEARN, exactly as the Chief's own run does (orchestratorExecutionContract.js's memory
      // persistence): only a SPECIALIST step whose result passed validation is saved, as the
      // Chief's own summary of that step, through the existing memory layer. Shared
      // infrastructure, failed, empty and partial results are never remembered, and the
      // default business (no valid id) has no memory to write.
      if (persist && planStep && isValidBusinessId(businessId) && planStep.selected_specialist && planStep.selected_specialist.type === 'specialist') {
        const saved = persistVerifiedFinding({
          businessId,
          id: `mem-${cycleId}-${jobResult.job_id}`,
          priorityId: 'reusable_findings',
          summary: summarizeExecutionState(planStep),
          source: { run_id: cycleId, tool_id: toolId, capability_id: result.capability_id, job_id: jobResult.job_id },
          verificationStatus: 'passed',
        });
        appendAuditEvent(audit, {
          type: 'result',
          specialistId: planStep.selected_specialist.id,
          toolId,
          status: saved ? 'saved' : 'not_saved',
          summary: saved
            ? `Saved a reusable finding to memory for business '${businessId}'.`
            : `Could not save this finding to memory for business '${businessId}'.`,
        });
      }

      steps.push(cycleStep(jobResult.job_id, 'executed', { ...stepExtra, executed: true, verification }));
    } catch (err) {
      // Contained: one job's fault never ends the cycle, and the underlying message is not
      // relayed (it can carry a path or a third-party detail).
      steps.push(cycleStep(jobResult.job_id, 'error', { reason_code: 'cycle_step_error', reason: 'This job could not be completed. The rest of the cycle was unaffected.' }));
    }
  };

  async function processJob(jobResult, parentJobId = null) {
    const firstStep = steps.length;
    try {
      await handleJob(jobResult, parentJobId);
    } finally {
      for (let index = firstStep; index < steps.length; index += 1) {
        if (steps[index].parent_job_id === undefined) steps[index].parent_job_id = parentJobId;
      }
    }
  }

  for (const jobResult of schedulerPass.results) {
    await processJob(jobResult);
  }

  appendAuditEvent(audit, {
    type: 'result',
    status: 'completed',
    summary: `Autonomous cycle completed: ${steps.length} job(s) considered.`,
  });

  const record = {
    run_id: cycleId,
    kind: 'autonomous_cycle',
    business_id: businessId || null,
    status: 'success',
    created_at: startedAt,
    summary: `Autonomous cycle: ${steps.filter((step) => step.outcome === 'observed').length} observed, ${steps.filter((step) => step.outcome === 'executed').length} executed, ${steps.filter((step) => step.outcome === 'approval_required').length} awaiting approval, ${steps.filter((step) => step.outcome === 'blocked').length} blocked, ${steps.filter((step) => step.parent_job_id).length} follow-up step(s).`,
    result: {
      steps: steps.map((step) => ({
        job_id: step.job_id,
        outcome: step.outcome,
        reason_code: step.reason_code,
        verification: step.verification || null,
        approval_request_id: step.approval_request_id,
        // The policy decision is summarized rather than embedded whole - the cycle record
        // is business data, and a decision object is large and already audited.
        policy_decision: step.policy_decision ? { decision: step.policy_decision.decision, reason_code: step.policy_decision.reason_code } : null,
        change_counts: step.changes ? step.changes.counts : null,
        snapshot_id: step.changes ? step.changes.current_snapshot_id : null,
        parent_job_id: step.parent_job_id || null,
      })),
      usage_summary: summarizeUsage(usageLedger),
      audit_trail: audit.events,
    },
  };

  if (persist) {
    try {
      runHistoryStore.saveRunRecord(record, runHistoryStoreDir ? { storeDir: runHistoryStoreDir } : undefined);
    } catch (err) {
      // A record that cannot be stored must not turn a completed cycle into a crash.
    }
  }

  return {
    cycle_id: cycleId,
    business_id: businessId || null,
    started_at: startedAt,
    considered: schedulerPass.results.length,
    steps,
    audit_events: audit.events,
    record,
  };
}

module.exports = {
  CYCLE_OUTCOMES,
  OBSERVATION_TOOL_IDS,
  isObservationJob,
  isConsequential,
  followUpTrigger,
  runAutonomousCycle,
};

if (require.main === module) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createScheduledJob } = require('../scheduler/scheduleModel');
  const scheduleStore = require('../scheduler/scheduleStore');
  const { AUTONOMY_KILL_SWITCH_ENV } = require('../agent/core/autonomyPolicy');

  console.log('Smart E-Commerce Growth AI Agent - controlled autonomous cycle:\n');

  const roots = ['schedules', 'snapshots', 'circuits', 'verifications', 'runs'].reduce((map, name) => {
    map[name] = fs.mkdtempSync(path.join(os.tmpdir(), `cycle-demo-${name}-`));
    return map;
  }, {});
  const now = new Date('2026-03-04T09:07:00.000Z');

  const demoAdapter = {
    UNSUPPORTED_READ_CAPABILITIES: [],
    isConfigured: () => true,
    getShopInfo: async () => ({ name: 'Demo', domain: 'demo.example', email: null }),
    getProducts: async () => [{ id: 'p1', title: 'Lamp', status: 'active', tags: [], variants: [{ available: true, inventory_quantity: 5 }] }],
    getOrders: async () => [{}, {}],
    getCustomers: async () => [],
    getInventoryLevels: async () => [],
    getCollections: async () => [],
  };

  const addJob = (jobId, toolId, objective) =>
    scheduleStore.saveScheduledJob(
      createScheduledJob({
        jobId,
        businessId: 'alpha-co',
        enabled: true,
        schedule: { kind: 'interval_minutes', every: 60 },
        task: { tool_id: toolId, objective, platform: 'shopify' },
        now,
      }),
      { rootDir: roots.schedules }
    );

  addJob('observe-catalogue', 'product_data_retrieval', 'Observe the product catalogue.');
  addJob('correct-vendor', 'shopify_vendor_correction', 'Correct a product vendor field.');

  (async () => {
    const options = {
      businessId: 'alpha-co',
      now,
      enabledPlatforms: ['shopify'],
      businessPolicy: { ok: true, business_id: 'alpha-co', enabled_platforms: ['shopify'], autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null } },
      dailyUsage: { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0 },
      scheduleRootDir: roots.schedules,
      snapshotRootDir: roots.snapshots,
      circuitRootDir: roots.circuits,
      verificationRootDir: roots.verifications,
      runHistoryStoreDir: roots.runs,
      adapter: demoAdapter,
    };

    process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';
    const first = await runAutonomousCycle(options);
    console.log('Kill switch ON:');
    for (const step of first.steps) {
      console.log(`  ${step.job_id.padEnd(18)} ${step.outcome.padEnd(18)} ${step.reason_code || ''}`);
    }
    console.log(`\n  ${first.record.summary}\n`);

    process.env[AUTONOMY_KILL_SWITCH_ENV] = 'false';
    const second = await runAutonomousCycle({ ...options, now: new Date('2026-03-04T10:00:00.000Z') });
    console.log('Next hour, kill switch OFF:');
    for (const step of second.steps) {
      console.log(`  ${step.job_id.padEnd(18)} ${step.outcome.padEnd(18)} ${step.reason_code || ''}`);
    }

    console.log('\nThe consequential job never executed in either cycle, and nothing here can approve it.');
    delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    for (const dir of Object.values(roots)) fs.rmSync(dir, { recursive: true, force: true });
  })();
}
