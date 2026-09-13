'use strict';

// The circuit breaker: after repeated failures, stop trying.
//
// WHY IT EXISTS. Every other gate in this system answers "is this allowed?". None of them
// answers "is this WORKING?". Without a breaker, an autonomous cycle whose consequential
// action fails every time would keep being permitted - each attempt individually legal,
// collectively a loop hammering a broken integration, burning budget and possibly leaving
// half-applied changes behind. The breaker is the memory of failure that the policy gates
// deliberately do not have.
//
// IT CAN ONLY EVER SUBTRACT PERMISSION. A closed breaker grants nothing - it means "I have
// no reason to stop you", and every compliance, approval, platform, budget and permission
// gate still applies exactly as before. An open breaker blocks. There is no path through
// this file that turns a BLOCK into an ALLOW, and nothing here can satisfy an approval.
//
// SCOPED, NOT GLOBAL. A breaker is keyed by business, platform and action, so a failing
// Shopify inventory correction for one business never stops a different action, a different
// platform, or a different business. A single global breaker would make one business's
// broken integration everyone's outage.
//
// THE THRESHOLDS ARE COUNTS AND MINUTES, NEVER MONEY. This project has no price table, so a
// financial threshold here would have to be invented. The breaker counts CONSECUTIVE
// FAILURES and waits a fixed COOLDOWN - both overridable by configuration, neither implying
// a cost.
//
// RECOVERY IS EXPLICIT, OR ONE CAREFUL TRIAL. An operator can reset a breaker deliberately
// (recorded with who and why). Otherwise, after the cooldown the breaker moves to half_open
// and permits EXACTLY ONE trial: a success closes it, a failure opens it again for a fresh
// cooldown. It never silently reopens the floodgates on a timer.
//
// STATE IS DURABLE, so a restart does not forget that something is broken - which is the
// one thing a breaker must never forget.

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const { isValidBusinessId } = require('../configuration/businessRegistry');

const BREAKER_VERSION = 1;

// closed    - healthy. No reason to stop anything.
// open      - too many consecutive failures. Blocked until the cooldown elapses or an
//             operator resets it.
// half_open - the cooldown has elapsed. Exactly one trial is permitted.
const BREAKER_STATES = ['closed', 'open', 'half_open'];

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MINUTES = 30;

// Why a check refused. Machine-readable, matching this project's other reason-code sets.
const BREAKER_REFUSAL_REASONS = {
  circuit_open: 'This action has failed repeatedly and its circuit is open.',
  trial_in_progress: 'A recovery trial for this action is already in flight.',
  invalid_scope: 'The circuit scope is not valid, so no reliability state can be established.',
};

const DEFAULT_BUSINESS_KEY = '_default';

function getFailureThreshold() {
  const override = Number(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD);
  return Number.isInteger(override) && override > 0 ? override : DEFAULT_FAILURE_THRESHOLD;
}

function getCooldownMinutes() {
  const override = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MINUTES);
  return Number.isInteger(override) && override > 0 ? override : DEFAULT_COOLDOWN_MINUTES;
}

function getDefaultCircuitStoreDir() {
  return process.env.CIRCUIT_BREAKER_STORE_DIR
    ? path.resolve(process.env.CIRCUIT_BREAKER_STORE_DIR)
    : path.join(__dirname, '..', 'memory', 'state', 'circuits');
}

function businessKey(businessId) {
  return businessId === null || businessId === undefined || businessId === '' ? DEFAULT_BUSINESS_KEY : String(businessId);
}

function safeSegment(value) {
  return typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_-]/g, '') : '';
}

// The identity of one breaker: business + platform + action. `platform` may be null for an
// action that touches no platform; it becomes the reserved '_none' segment, which the
// channel vocabulary can never produce.
function circuitKey({ businessId = null, platform = null, action }) {
  const business = businessKey(businessId);
  if (business !== DEFAULT_BUSINESS_KEY && !isValidBusinessId(business)) return null;
  const platformSegment = platform === null || platform === undefined ? '_none' : safeSegment(platform);
  const actionSegment = safeSegment(action);
  if (!platformSegment || !actionSegment) return null;
  return { business, platform: platformSegment, action: actionSegment, id: `${business}__${platformSegment}__${actionSegment}` };
}

function circuitFilePath(key, rootDir) {
  return path.join(rootDir, key.business, `${key.platform}__${key.action}.json`);
}

function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupErr) {
      // Already gone.
    }
    throw err;
  }
}

function emptyCircuit(key, nowIso) {
  return {
    breaker_version: BREAKER_VERSION,
    circuit_id: key.id,
    business_id: key.business === DEFAULT_BUSINESS_KEY ? null : key.business,
    platform: key.platform === '_none' ? null : key.platform,
    action: key.action,
    state: 'closed',
    consecutive_failures: 0,
    opened_at: null,
    cooldown_until: null,
    trial_started_at: null,
    last_failure_at: null,
    last_success_at: null,
    last_reset_by: null,
    last_reset_reason: null,
    updated_at: nowIso,
  };
}

// Reads one circuit's stored state. A missing OR unreadable record reads as a fresh CLOSED
// circuit - deliberately the permissive direction for THIS module alone, because a breaker
// is a restriction: an unreadable breaker must not become a permanent outage that nothing
// can clear, and every genuine permission gate still applies independently.
function readCircuit(key, rootDir, nowIso) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(circuitFilePath(key, rootDir), 'utf8'));
  } catch (err) {
    return emptyCircuit(key, nowIso);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.breaker_version !== BREAKER_VERSION || !BREAKER_STATES.includes(parsed.state)) {
    return emptyCircuit(key, nowIso);
  }
  return { ...emptyCircuit(key, nowIso), ...parsed };
}

function saveCircuit(circuit, key, rootDir) {
  writeJsonAtomically(circuitFilePath(key, rootDir), circuit);
  return circuit;
}

// Applies the cooldown transition without writing: an open circuit whose cooldown has
// elapsed is half_open. Pure, so a read never has a side effect.
function withCooldownApplied(circuit, now) {
  if (circuit.state !== 'open' || !circuit.cooldown_until) return circuit;
  const elapsed = new Date(circuit.cooldown_until).getTime() <= now.getTime();
  return elapsed ? { ...circuit, state: 'half_open' } : circuit;
}

// The current state of one circuit, without changing anything.
function getCircuitState({ businessId = null, platform = null, action, now = new Date(), rootDir = getDefaultCircuitStoreDir() } = {}) {
  const key = circuitKey({ businessId, platform, action });
  if (!key) return null;
  return withCooldownApplied(readCircuit(key, rootDir, now.toISOString()), now);
}

// MAY THIS ACTION BE ATTEMPTED?
//
// Returns { allowed, state, reason_code, reason, trial }. `trial: true` means this is the
// single permitted recovery attempt - the caller must report its outcome, or the circuit
// stays half_open and no further attempt is permitted.
//
// An open circuit is a BLOCK. It never becomes an allow because a caller asked twice.
function checkCircuit({ businessId = null, platform = null, action, now = new Date(), rootDir = getDefaultCircuitStoreDir() } = {}) {
  const key = circuitKey({ businessId, platform, action });
  if (!key) {
    return { allowed: false, state: null, trial: false, reason_code: 'invalid_scope', reason: BREAKER_REFUSAL_REASONS.invalid_scope };
  }

  const circuit = withCooldownApplied(readCircuit(key, rootDir, now.toISOString()), now);

  if (circuit.state === 'closed') {
    return { allowed: true, state: 'closed', trial: false, reason_code: null, reason: null };
  }

  if (circuit.state === 'half_open') {
    // Exactly one trial. A second caller arriving while a trial is outstanding is refused,
    // so a half_open circuit never becomes an open gate.
    if (circuit.trial_started_at) {
      return { allowed: false, state: 'half_open', trial: false, reason_code: 'trial_in_progress', reason: BREAKER_REFUSAL_REASONS.trial_in_progress };
    }
    saveCircuit({ ...circuit, state: 'half_open', trial_started_at: now.toISOString(), updated_at: now.toISOString() }, key, rootDir);
    return { allowed: true, state: 'half_open', trial: true, reason_code: null, reason: null };
  }

  return {
    allowed: false,
    state: 'open',
    trial: false,
    reason_code: 'circuit_open',
    reason: `${BREAKER_REFUSAL_REASONS.circuit_open} It has failed ${circuit.consecutive_failures} time(s) in a row and is blocked until ${circuit.cooldown_until} unless an operator resets it.`,
  };
}

// Records a successful attempt: the circuit closes and the failure count resets. Success is
// the only automatic path back to closed - a timer alone never fully restores a circuit.
function recordSuccess({ businessId = null, platform = null, action, now = new Date(), rootDir = getDefaultCircuitStoreDir() } = {}) {
  const key = circuitKey({ businessId, platform, action });
  if (!key) return null;
  const circuit = readCircuit(key, rootDir, now.toISOString());
  return saveCircuit(
    {
      ...circuit,
      state: 'closed',
      consecutive_failures: 0,
      opened_at: null,
      cooldown_until: null,
      trial_started_at: null,
      last_success_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    key,
    rootDir
  );
}

// Records a failed attempt. At the threshold the circuit opens for a cooldown; a failure
// during a recovery trial opens it immediately, because a trial failing IS the evidence
// that it is still broken.
function recordFailure({ businessId = null, platform = null, action, now = new Date(), rootDir = getDefaultCircuitStoreDir() } = {}) {
  const key = circuitKey({ businessId, platform, action });
  if (!key) return null;

  const current = withCooldownApplied(readCircuit(key, rootDir, now.toISOString()), now);
  const failures = current.consecutive_failures + 1;
  const wasTrial = current.state === 'half_open';
  const shouldOpen = wasTrial || failures >= getFailureThreshold();

  const cooldownUntil = shouldOpen
    ? new Date(now.getTime() + getCooldownMinutes() * 60 * 1000).toISOString()
    : null;

  return saveCircuit(
    {
      ...current,
      state: shouldOpen ? 'open' : 'closed',
      consecutive_failures: failures,
      opened_at: shouldOpen ? now.toISOString() : current.opened_at,
      cooldown_until: cooldownUntil,
      trial_started_at: null,
      last_failure_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    key,
    rootDir
  );
}

// THE EXPLICIT SAFE RECOVERY MECHANISM. A deliberate operator action, not a timer and not
// something an agent can do on its own schedule: it requires a stated actor and a stated
// reason, both recorded on the circuit, so a reset is always attributable afterwards.
//
// Resetting a breaker restores nothing but the breaker. Compliance, approval, platform
// enablement, budget and permission gates are untouched by this - a reset cannot make a
// blocked action executable.
function resetCircuit({ businessId = null, platform = null, action, resetBy, reason, now = new Date(), rootDir = getDefaultCircuitStoreDir() } = {}) {
  if (typeof resetBy !== 'string' || resetBy.trim() === '') {
    throw new Error('resetCircuit requires a non-empty `resetBy` - a reset is always attributable.');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('resetCircuit requires a non-empty `reason` - a reset is always explained.');
  }
  const key = circuitKey({ businessId, platform, action });
  if (!key) return null;
  const circuit = readCircuit(key, rootDir, now.toISOString());
  return saveCircuit(
    {
      ...circuit,
      state: 'closed',
      consecutive_failures: 0,
      opened_at: null,
      cooldown_until: null,
      trial_started_at: null,
      last_reset_by: resetBy.trim(),
      last_reset_reason: reason.trim(),
      updated_at: now.toISOString(),
    },
    key,
    rootDir
  );
}

// Every circuit recorded for ONE business. Business-scoped like every other store here -
// there is no cross-business listing.
function listCircuits({ businessId = null, now = new Date(), rootDir = getDefaultCircuitStoreDir() } = {}) {
  const business = businessKey(businessId);
  if (business !== DEFAULT_BUSINESS_KEY && !isValidBusinessId(business)) return [];
  let fileNames;
  try {
    fileNames = fs.readdirSync(path.join(rootDir, business)).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }
  const circuits = [];
  for (const fileName of fileNames) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(rootDir, business, fileName), 'utf8'));
    } catch (err) {
      continue;
    }
    if (!parsed || parsed.breaker_version !== BREAKER_VERSION) continue;
    const expected = business === DEFAULT_BUSINESS_KEY ? null : business;
    if (parsed.business_id !== expected) continue;
    circuits.push(withCooldownApplied(parsed, now));
  }
  circuits.sort((a, b) => (a.circuit_id < b.circuit_id ? -1 : a.circuit_id > b.circuit_id ? 1 : 0));
  return circuits;
}

module.exports = {
  BREAKER_VERSION,
  BREAKER_STATES,
  BREAKER_REFUSAL_REASONS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_COOLDOWN_MINUTES,
  getFailureThreshold,
  getCooldownMinutes,
  getDefaultCircuitStoreDir,
  circuitKey,
  getCircuitState,
  checkCircuit,
  recordSuccess,
  recordFailure,
  resetCircuit,
  listCircuits,
};

if (require.main === module) {
  const os = require('os');
  console.log('Smart E-Commerce Growth AI Agent - circuit breaker:\n');
  console.log(`Failure threshold: ${getFailureThreshold()} consecutive failures. Cooldown: ${getCooldownMinutes()} minutes.`);
  console.log('Counts and minutes - never money. This project has no price table.\n');

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circuit-breaker-demo-'));
  const scope = { businessId: 'alpha-co', platform: 'shopify', action: 'shopify_inventory_correction', rootDir };
  let now = new Date('2026-03-04T09:00:00.000Z');

  for (let attempt = 1; attempt <= getFailureThreshold(); attempt += 1) {
    const check = checkCircuit({ ...scope, now });
    console.log(`Attempt ${attempt}: allowed=${check.allowed} state=${check.state}`);
    recordFailure({ ...scope, now });
    now = new Date(now.getTime() + 60 * 1000);
  }

  const blocked = checkCircuit({ ...scope, now });
  console.log(`\nAfter ${getFailureThreshold()} failures: allowed=${blocked.allowed} (${blocked.reason_code})`);
  console.log(`  ${blocked.reason}`);

  const afterCooldown = new Date(now.getTime() + (getCooldownMinutes() + 1) * 60 * 1000);
  const trial = checkCircuit({ ...scope, now: afterCooldown });
  console.log(`\nAfter the cooldown: allowed=${trial.allowed} state=${trial.state} trial=${trial.trial} - exactly one attempt`);
  console.log(`A second caller during that trial: allowed=${checkCircuit({ ...scope, now: afterCooldown }).allowed}`);

  recordSuccess({ ...scope, now: afterCooldown });
  console.log(`After the trial succeeds: state=${getCircuitState({ ...scope, now: afterCooldown }).state}`);

  console.log('\nA different action for the same business is unaffected:');
  console.log(`  ${getCircuitState({ ...scope, action: 'shopify_vendor_correction', now }).state}`);
  console.log('A different business is unaffected:');
  console.log(`  ${getCircuitState({ ...scope, businessId: 'beta-co', now }).state}`);

  fs.rmSync(rootDir, { recursive: true, force: true });
}
