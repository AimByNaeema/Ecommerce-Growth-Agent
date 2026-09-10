'use strict';

// The shape of one Command Center session - the multi-turn container that lets a user
// give the Chief a goal, get a result, and then say "deep research #3" without repeating
// themselves. Schema plus createEmpty*/validate*Shape only, following the exact convention
// of every other *Model.js file; no orchestration logic lives here.
//
// A SESSION IS NOT A SECOND ORCHESTRATOR. It records what was asked, what the Chief
// planned, which specialists ran and what they produced. The planning and dispatch stay
// entirely in agent/core/orchestratorExecutionContract.js - a session only remembers, so
// that a later turn can refer to an earlier result.
//
// SESSION IS NOT MEMORY. agent/core/memoryStore.js holds verified, business-level facts
// that outlive any conversation. A session is this conversation: shorter-lived, unverified
// by default, and never promoted into memory by this module.
//
// NEVER HOLDS A SECRET. A session records objectives, plans, references and result
// summaries. No credential, token, key or OAuth value may be written into one - see
// SESSION_FORBIDDEN_KEY_PATTERN, which the store enforces on every save so this is a
// mechanical guarantee rather than a convention.
//
// RUNS STAY WHERE THEY ARE. A session references runs by id (`run_refs`); it never copies
// a run record into itself. agent/core/runHistoryStore.js remains the single home of run
// output, so the History page and a session cannot drift apart.

const SESSION_STATUSES = [
  'active', // created, awaiting or processing a turn
  'waiting_for_user', // the Chief answered and is waiting for the next instruction
  'waiting_for_approval', // a step is gated on a human decision (approvals/)
  'complete', // the user ended it, or the goal was met
  'failed', // a turn could not complete and the session cannot continue
];

const MESSAGE_ROLES = ['user', 'chief'];

// A session's channel is stated, never inferred. null means "not channel-specific" - it
// is NOT a synonym for Shopify, and nothing may later reinterpret it as one.
const SESSION_CHANNELS = ['shopify', 'etsy', 'multi_channel', null];

// Any key matching this is refused at save time. Deliberately broader than the credential
// list in configuration/businessRegistry.js: a session is user-facing conversation state,
// so the safe default is to refuse anything that merely LOOKS like a secret.
const SESSION_FORBIDDEN_KEY_PATTERN = /token|secret|password|api[-_]?key|keystring|credential|authorization|refresh|oauth/i;

const SESSION_FIELDS = [
  { id: 'session_id', title: 'Session id', type: 'string', description: 'Stable id for this session; also its filename in the session store.' },
  { id: 'business_id', title: 'Business id', type: 'string', description: 'Which business this session belongs to, or null for the single-business default - the same convention agent/core/runHistoryStore.js already uses.' },
  { id: 'created_at', title: 'Created at', type: 'string', description: 'ISO timestamp of creation.' },
  { id: 'updated_at', title: 'Updated at', type: 'string', description: 'ISO timestamp of the last turn.' },
  { id: 'status', title: 'Status', type: 'string', description: `One of: ${SESSION_STATUSES.join(', ')}.` },
  { id: 'original_goal', title: 'Original goal', type: 'string', description: "The user's first stated goal, kept verbatim for the life of the session." },
  { id: 'current_goal', title: 'Current goal', type: 'string', description: 'The most recent instruction. Differs from original_goal once the user narrows or redirects.' },
  { id: 'channel', title: 'Channel', type: 'string', description: 'shopify | etsy | multi_channel | null. STATED by the user, never inferred from a product name.' },
  { id: 'messages', title: 'Messages', type: 'array', description: 'The conversation: { role, text, at, run_id }. role is user or chief.' },
  { id: 'current_plan', title: 'Current plan', type: 'array', description: "A compact record of the Chief's most recent plan: one { specialist, capability, tool, status, summary } per step. The full execution state stays in the run record." },
  { id: 'specialist_tasks', title: 'Specialist tasks', type: 'array', description: 'Every specialist step this session has dispatched, across all turns: { turn, specialist, tool, capability, status, at, run_id }.' },
  { id: 'specialist_results', title: 'Specialist results', type: 'array', description: 'Referenceable results produced this session: { ref, label, specialist, run_id, channel, channel_reference, summary, payload_ref }. `ref` is what a later turn cites (e.g. "#3").' },
  { id: 'decisions', title: 'Decisions', type: 'array', description: 'Explicit decisions recorded during the session: { at, decision, basis }.' },
  { id: 'pending_items', title: 'Pending items', type: 'array', description: 'What the session is waiting on: { kind, detail, run_id }. kind is approval | information | none.' },
  { id: 'approvals_reference', title: 'Approvals reference', type: 'array', description: 'Run ids whose steps are gated in the existing approval system. The approval records themselves stay in approvals/ - never duplicated here.' },
  { id: 'next_actions', title: 'Next actions', type: 'array', description: 'What the user could do next: { id, title, basis }. Every entry states the fact that produced it.' },
  { id: 'opportunity_workflows', title: 'Opportunity workflows', type: 'array', description: "One entry per market opportunity this session has prepared: { ref, product, state, compliance_status, channel, channel_reference, stages, approval_id, approval_status, missing_information, run_id, at }. State only - the draft itself stays in the run record, and the approval record stays in the approval system." },
  { id: 'final_result', title: 'Final result', type: 'object', description: "The session's settled outcome once complete, or null." },
  { id: 'run_refs', title: 'Run references', type: 'array', description: 'Run ids produced by this session, in order. The run records themselves live in agent/core/runHistoryStore.js and are never copied here.' },
  { id: 'limitations', title: 'Limitations', type: 'array', description: 'What this session did NOT establish, carried forward across turns.' },
];

function nowIso() {
  return new Date().toISOString();
}

function createEmptyCommandCenterSession(overrides = {}) {
  const base = {
    session_id: null,
    business_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    status: 'active',
    original_goal: null,
    current_goal: null,
    channel: null,
    messages: [],
    current_plan: [],
    specialist_tasks: [],
    specialist_results: [],
    decisions: [],
    pending_items: [],
    approvals_reference: [],
    next_actions: [],
    opportunity_workflows: [],
    final_result: null,
    run_refs: [],
    limitations: [],
  };
  return Object.assign(base, overrides);
}

// Walks a value and returns every key path that looks like a credential. Used by the store
// before writing, so a secret cannot reach disk even if a caller passes one in by mistake.
function findForbiddenKeys(value, pathPrefix = '', found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${pathPrefix}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (SESSION_FORBIDDEN_KEY_PATTERN.test(key)) found.push(path);
    findForbiddenKeys(child, path, found);
  }
  return found;
}

// Structural validation only - never a judgment about whether the session went well.
function validateCommandCenterSessionShape(session) {
  const errors = [];
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { valid: false, errors: ['Session must be a plain object.'] };
  }
  if (typeof session.session_id !== 'string' || session.session_id.trim() === '') {
    errors.push('session_id must be a non-empty string.');
  }
  if (!SESSION_STATUSES.includes(session.status)) {
    errors.push(`status must be one of: ${SESSION_STATUSES.join(', ')}.`);
  }
  if (session.channel !== null && !SESSION_CHANNELS.includes(session.channel)) {
    errors.push(`channel must be one of: shopify, etsy, multi_channel, or null (stated, never inferred).`);
  }
  for (const key of ['messages', 'current_plan', 'specialist_tasks', 'specialist_results', 'decisions', 'pending_items', 'approvals_reference', 'next_actions', 'run_refs', 'limitations', 'opportunity_workflows']) {
    if (!Array.isArray(session[key])) errors.push(`${key} must be an array.`);
  }
  for (const [index, message] of (Array.isArray(session.messages) ? session.messages : []).entries()) {
    if (!message || typeof message !== 'object') {
      errors.push(`messages[${index}] must be an object.`);
      continue;
    }
    if (!MESSAGE_ROLES.includes(message.role)) errors.push(`messages[${index}].role must be one of: ${MESSAGE_ROLES.join(', ')}.`);
    if (typeof message.text !== 'string') errors.push(`messages[${index}].text must be a string.`);
  }
  // Referenceable results must carry a stable, unique ref - that is what "#3" resolves on.
  const refs = (Array.isArray(session.specialist_results) ? session.specialist_results : []).map((r) => r && r.ref);
  for (const [index, ref] of refs.entries()) {
    if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1) {
      errors.push(`specialist_results[${index}].ref must be a positive integer - it is what a later turn cites.`);
    }
  }
  if (new Set(refs).size !== refs.length) errors.push('specialist_results refs must be unique.');

  const forbidden = findForbiddenKeys(session);
  if (forbidden.length > 0) {
    errors.push(`Session carries credential-shaped key(s), which may never be persisted: ${forbidden.join(', ')}.`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SESSION_STATUSES,
  MESSAGE_ROLES,
  SESSION_CHANNELS,
  SESSION_FORBIDDEN_KEY_PATTERN,
  SESSION_FIELDS,
  createEmptyCommandCenterSession,
  findForbiddenKeys,
  validateCommandCenterSessionShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Command Center session model:\n');
  for (const field of SESSION_FIELDS) {
    console.log(`${field.id} (${field.type}) - ${field.title}`);
    console.log(`  ${field.description}\n`);
  }
  console.log(`Statuses: ${SESSION_STATUSES.join(' -> ')}`);
  const empty = createEmptyCommandCenterSession({ session_id: 'demo' });
  console.log(`\nEmpty session validates: ${JSON.stringify(validateCommandCenterSessionShape(empty))}`);
  const leaky = createEmptyCommandCenterSession({ session_id: 'demo', messages: [{ role: 'user', text: 'hi', access_token: 'x' }] });
  console.log(`A session carrying a token is REFUSED: ${JSON.stringify(validateCommandCenterSessionShape(leaky).errors)}`);
}
