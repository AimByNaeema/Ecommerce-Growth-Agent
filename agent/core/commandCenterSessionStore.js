'use strict';

// Persisted Command Center sessions - one JSON file per session under
// memory/state/sessions/, deliberately the SAME storage shape
// agent/core/runHistoryStore.js already uses for runs.
//
// NO DATABASE, ON PURPOSE (CLAUDE.md rule 15). This project is one local Node process
// serving one dashboard; a real engine can replace this module later behind these same
// four functions without that decision being forced now. One file per session also means a
// single corrupt file can never take down listing every other session.
//
// SEPARATE FROM RUNS, BY DESIGN. A session references runs by id and never copies a run
// record into itself, so agent/core/runHistoryStore.js stays the single home of run output
// and the History page can never drift from what a session shows.
//
// REFUSES TO PERSIST A SECRET. Every save runs the model's own credential-shaped-key scan
// first and THROWS rather than writing. A session is conversation state that a browser
// renders, so this is enforced mechanically at the boundary rather than left to callers.

const fs = require('fs');
const path = require('path');
const {
  createEmptyCommandCenterSession,
  validateCommandCenterSessionShape,
  findForbiddenKeys,
} = require('./commandCenterSessionModel');

// Overridable so tests never write into this project's own memory/state/sessions/ - the
// same env-override convention runHistoryStore.getDefaultStoreDir() uses, read at call
// time (never memoized at module load) so a test can set it before the first save.
function getDefaultSessionDir() {
  return process.env.COMMAND_CENTER_SESSION_DIR
    ? path.resolve(process.env.COMMAND_CENTER_SESSION_DIR)
    : path.join(__dirname, '..', '..', 'memory', 'state', 'sessions');
}

// Session ids are server-generated, but this is still defensive: strips anything that is
// not a safe filename character so an id can never read or write outside the store.
function safeSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.replace(/[^a-zA-Z0-9_-]/g, '') : '';
}

function sessionFilePath(dir, sessionId) {
  return path.join(dir, `${safeSessionId(sessionId)}.json`);
}

function createSessionId() {
  return `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Writes one session, keyed by its own session_id - a later save overwrites, so a
// session's file always reflects its latest state rather than two conflicting copies.
//
// Throws for genuinely invalid input, for a credential-shaped key, and for a filesystem
// failure. Callers (server.js) catch it exactly as they already catch every other
// executor error; a save that failed must never be reported as a save that worked.
function saveSession(session, { sessionDir = getDefaultSessionDir() } = {}) {
  if (!session || typeof session !== 'object') {
    throw new Error('saveSession requires a session object.');
  }
  const id = safeSessionId(session.session_id);
  if (!id) {
    throw new Error('saveSession requires a non-empty, filename-safe session_id.');
  }
  // The secret check runs BEFORE validation so its message is the one a caller sees -
  // it is the more important failure of the two.
  const forbidden = findForbiddenKeys(session);
  if (forbidden.length > 0) {
    throw new Error(
      `Refusing to persist a Command Center session carrying credential-shaped key(s): ${forbidden.join(', ')}. ` +
        'No token, key or secret may ever be written into session state.'
    );
  }
  const shape = validateCommandCenterSessionShape(session);
  if (!shape.valid) {
    throw new Error(`saveSession received a structurally invalid session: ${shape.errors.join('; ')}`);
  }
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(sessionFilePath(sessionDir, id), JSON.stringify(session, null, 2), 'utf8');
  return session;
}

// Reads back exactly what was saved. Returns null - never throws - for a missing,
// corrupt or invalid id: this is a read path a dashboard calls with an id from a URL, so
// "not found" and "unreadable" are both honestly null.
function getSessionById(sessionId, { sessionDir = getDefaultSessionDir() } = {}) {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionFilePath(sessionDir, id), 'utf8'));
  } catch (err) {
    return null;
  }
}

// Lists sessions as small summaries, newest first. One unreadable file is skipped, never
// allowed to break the whole listing.
//
// BUSINESS ISOLATION: `businessId`, when supplied, restricts the listing to that business,
// and a session with no business_id is NOT returned for such a request - the same rule
// runHistoryStore.listRunRecordSummaries already applies to runs.
function listSessions({ limit = 25, businessId = null, sessionDir = getDefaultSessionDir() } = {}) {
  const filterBusinessId = typeof businessId === 'string' && businessId.trim() ? businessId.trim() : null;
  let fileNames;
  try {
    fileNames = fs.readdirSync(sessionDir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }

  const summaries = [];
  for (const fileName of fileNames) {
    let session;
    try {
      session = JSON.parse(fs.readFileSync(path.join(sessionDir, fileName), 'utf8'));
    } catch (err) {
      continue;
    }
    if (!session || typeof session !== 'object') continue;
    const sessionBusinessId = session.business_id || null;
    if (filterBusinessId && sessionBusinessId !== filterBusinessId) continue;
    summaries.push({
      session_id: session.session_id || null,
      business_id: sessionBusinessId,
      status: session.status || null,
      original_goal: session.original_goal || null,
      current_goal: session.current_goal || null,
      channel: session.channel || null,
      message_count: Array.isArray(session.messages) ? session.messages.length : 0,
      result_count: Array.isArray(session.specialist_results) ? session.specialist_results.length : 0,
      created_at: session.created_at || null,
      updated_at: session.updated_at || session.created_at || null,
    });
  }

  summaries.sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
  return summaries.slice(0, Math.max(0, limit));
}

// Creates and persists a new session in one step, so a caller can never hold an
// unpersisted session it believes is saved.
function createSession({ goal, businessId = null, channel = null, sessionDir = getDefaultSessionDir() } = {}) {
  if (typeof goal !== 'string' || goal.trim() === '') {
    throw new Error('createSession requires a non-empty goal.');
  }
  const session = createEmptyCommandCenterSession({
    session_id: createSessionId(),
    business_id: businessId,
    original_goal: goal.trim(),
    current_goal: goal.trim(),
    // Stated by the caller or left null. Never derived from the goal's wording.
    channel,
    status: 'active',
  });
  return saveSession(session, { sessionDir });
}

module.exports = {
  getDefaultSessionDir,
  createSessionId,
  saveSession,
  getSessionById,
  listSessions,
  createSession,
};

if (require.main === module) {
  const os = require('os');
  console.log('Smart E-Commerce Growth AI Agent - Command Center session store:\n');
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-demo-'));

  const session = createSession({ goal: '(Example goal) Find products related to my catalogue.', sessionDir: demoDir });
  console.log(`Created: ${session.session_id} (status ${session.status})`);
  session.messages.push({ role: 'user', text: session.original_goal, at: new Date().toISOString(), run_id: null });
  session.status = 'waiting_for_user';
  saveSession(session, { sessionDir: demoDir });

  const read = getSessionById(session.session_id, { sessionDir: demoDir });
  console.log(`Read back: ${read.session_id}, ${read.messages.length} message(s), status ${read.status}`);
  console.log(`Listing  : ${JSON.stringify(listSessions({ sessionDir: demoDir }).map((s) => s.session_id))}`);
  console.log(`Unknown id reads back null: ${getSessionById('nope', { sessionDir: demoDir }) === null}`);

  try {
    saveSession({ ...read, messages: [{ role: 'user', text: 'x', refresh_token: 'secret' }] }, { sessionDir: demoDir });
    console.log('SECRET WAS PERSISTED - BUG');
  } catch (err) {
    console.log(`\nA session carrying a token is REFUSED at the boundary:\n  ${err.message}`);
  }
}
