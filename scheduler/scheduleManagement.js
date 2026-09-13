'use strict';

// How a business owner explicitly creates, lists and enables scheduled jobs.
//
// WHY THIS EXISTS. scheduler/scheduleModel.js validates a job's SHAPE and
// scheduler/scheduleStore.js persists it, but nothing checked a job against the business it
// belongs to - so there was no safe way for an owner to create one. This module adds only
// that business check, then calls the existing model and store.
//
// NOTHING IS INVENTED. No schedule, interval or follow-up is ever chosen here: every job is
// exactly what the owner submitted. A new job is always saved DISABLED; enabling it is a
// separate, explicit call. Enabling a job never enables autonomy - the kill switch, the
// business's own autonomy block and every policy gate still apply when it runs.
//
// CHECKED AGAINST THE BUSINESS, WITH THE EXISTING GATES:
//   the business has a readable, valid policy    -> agent/core/autonomyPolicy.js resolveBusinessPolicy
//   the platform is enabled for this business    -> that policy's enabled_platforms
//   the capability is implemented                -> tools/toolRegistry.js
//   the capability is permitted for its specialist, on that platform
//                                                -> agent/core/toolPermissions.js checkToolAccess,
//                                                   with the specialist the scheduler itself resolves
// Every follow-up is checked the same way. Scheduling a consequential capability is allowed:
// it can only ever produce a pending approval, never an execution.

const { createScheduledJob, validateSchedule, validateTask, describeJob } = require('./scheduleModel');
const scheduleStore = require('./scheduleStore');
const { buildScheduledExecutionRequest } = require('./scheduleRunner');
const { resolveBusinessPolicy } = require('../agent/core/autonomyPolicy');
const { checkToolAccess } = require('../agent/core/toolPermissions');
const { getToolById } = require('../tools/toolRegistry');

function normalizeBusinessId(businessId) {
  return typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
}

function refuse(reasonCode, reason, errors = []) {
  return { ok: false, reason_code: reasonCode, reason, errors };
}

function policyFor(businessId, businessPolicy) {
  const policy = businessPolicy || resolveBusinessPolicy(businessId);
  if (!policy || policy.ok !== true) {
    return {
      policy: null,
      refusal: refuse(
        (policy && policy.reason_code) || 'policy_data_unreadable',
        'This business has no readable, valid configuration, so no schedule can be checked against it.'
      ),
    };
  }
  return { policy, refusal: null };
}

// One capability checked against one business. Returns null when it is permitted.
function capabilityRefusal({ toolId, objective, platform, businessId, policy, label }) {
  const tool = getToolById(toolId);
  if (!tool || tool.status !== 'implemented') {
    return refuse('tool_not_implemented', `${label} names '${toolId}', which is not an implemented capability.`);
  }
  if (platform !== null && platform !== undefined && !policy.enabled_platforms.includes(platform)) {
    return refuse('platform_not_enabled', `${label} targets '${platform}', which this business has not enabled.`);
  }
  const request = buildScheduledExecutionRequest({ business_id: businessId, task: { tool_id: toolId, objective, platform, params: null } });
  if (!request) {
    return refuse('tool_not_implemented', `${label} names '${toolId}', which is not in the tool registry.`);
  }
  const access = checkToolAccess({ specialistId: request.specialist_id, toolId, enabledPlatforms: policy.enabled_platforms });
  if (access.decision === 'unavailable' || access.decision === 'denied') {
    return refuse(
      access.platform_permitted === false ? 'platform_not_enabled' : 'unauthorized_tool',
      `${label}: ${access.reason || `'${toolId}' is not permitted for this business.`}`
    );
  }
  return null;
}

function taskRefusal(task, businessId, policy) {
  const primary = capabilityRefusal({
    toolId: task.tool_id,
    objective: task.objective,
    platform: task.platform === undefined ? null : task.platform,
    businessId,
    policy,
    label: 'The task',
  });
  if (primary) return primary;
  const followUps = Array.isArray(task.follow_ups) ? task.follow_ups : [];
  for (let index = 0; index < followUps.length; index += 1) {
    const refusal = capabilityRefusal({
      toolId: followUps[index].tool_id,
      objective: followUps[index].objective,
      platform: task.platform === undefined ? null : task.platform,
      businessId,
      policy,
      label: `Follow-up ${index + 1}`,
    });
    if (refusal) return refusal;
  }
  return null;
}

function createBusinessSchedule({
  businessId = null,
  jobId,
  schedule,
  task,
  now = new Date(),
  rootDir = undefined,
  businessPolicy = null,
} = {}) {
  const normalized = normalizeBusinessId(businessId);

  if (typeof jobId !== 'string' || jobId.trim() === '' || scheduleStore.safeJobId(jobId) !== jobId) {
    return refuse('invalid_job_id', 'A jobId of letters, digits, hyphens or underscores is required.');
  }

  const scheduleCheck = validateSchedule(schedule);
  const taskCheck = validateTask(task);
  if (!scheduleCheck.valid || !taskCheck.valid) {
    return refuse('invalid_schedule', 'The schedule or task is not valid.', [...scheduleCheck.errors, ...taskCheck.errors]);
  }

  const { policy, refusal } = policyFor(normalized, businessPolicy);
  if (refusal) return refusal;
  if (normalizeBusinessId(policy.business_id) !== normalized) {
    return refuse('invalid_business', 'The resolved policy does not belong to this business.');
  }

  const capability = taskRefusal(task, normalized, policy);
  if (capability) return capability;

  if (scheduleStore.loadScheduledJob(jobId, { businessId: normalized, rootDir })) {
    return refuse('schedule_exists', 'A schedule with this jobId already exists for this business. It was not overwritten.');
  }

  const job = createScheduledJob({ jobId, businessId: normalized, enabled: false, schedule, task, now });
  scheduleStore.saveScheduledJob(job, { rootDir });
  return { ok: true, job };
}

function setBusinessScheduleEnabled({
  businessId = null,
  jobId,
  enabled,
  now = new Date(),
  rootDir = undefined,
  businessPolicy = null,
} = {}) {
  const normalized = normalizeBusinessId(businessId);
  if (typeof enabled !== 'boolean') {
    return refuse('invalid_request', '"enabled" must be true or false.');
  }
  const job = scheduleStore.loadScheduledJob(jobId, { businessId: normalized, rootDir });
  if (!job) return refuse('schedule_not_found', 'No schedule with that jobId exists for this business.');

  // Re-checked at enable time: a platform or permission withdrawn since creation is refused.
  if (enabled) {
    const { policy, refusal } = policyFor(normalized, businessPolicy);
    if (refusal) return refusal;
    const capability = taskRefusal(job.task, normalized, policy);
    if (capability) return capability;
  }

  const updated = scheduleStore.setJobEnabled(jobId, enabled, { businessId: normalized, now, rootDir });
  return updated ? { ok: true, job: updated } : refuse('schedule_not_found', 'No schedule with that jobId exists for this business.');
}

function listBusinessSchedules({ businessId = null, now = new Date(), rootDir = undefined } = {}) {
  return scheduleStore.listScheduledJobs({ businessId: normalizeBusinessId(businessId), rootDir }).map((job) => ({
    ...describeJob(job, now),
    task: job.task,
    schedule: job.schedule,
    last_status: job.last_status === undefined ? null : job.last_status,
  }));
}

module.exports = {
  createBusinessSchedule,
  setBusinessScheduleEnabled,
  listBusinessSchedules,
};
