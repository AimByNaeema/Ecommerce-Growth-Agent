'use strict';

// The Command Center session layer: what turns a stateless "ask the Chief" into a
// conversation the user can continue.
//
// IT IS NOT A SECOND ORCHESTRATOR, and the shape of this file is the proof. It contains no
// routing, no specialist selection, no tool dispatch and no plan construction. Every turn
// ends in exactly one call to the EXISTING
// agent/core/orchestratorExecutionContract.js's runOrchestratorContract(), unchanged and
// unwrapped. This module's whole job is the two things that function has no memory of:
//
//   BEFORE the call - resolve what the user is referring to ("deep research #3") into a
//                     concrete objective, and carry forward the evidence already gathered
//                     so the same research is not paid for twice.
//   AFTER the call  - record what came back as referenceable results, so the NEXT turn can
//                     refer to them in the same way.
//
// Because the Chief is called with a fully-resolved objective, its own routing behaviour is
// byte-identical to a first-turn request. There is no session-only code path through it.
//
// WHY REFERENCES ARE RESOLVED HERE AND NOT BY THE MODEL. "#3" has exactly one correct
// answer, and it is already written down in the session. Asking a model to work out which
// opportunity was third invites it to pick a different one. Resolution is therefore plain
// arithmetic over the stored list, and a reference that does not exist is reported as a
// question to the user rather than guessed at.
//
// CHANNEL IS NEVER INFERRED. A session's channel is whatever the user stated when they
// opened it. Nothing here reads a product name and concludes "this is Etsy" - a wrong
// channel label would attribute one store's work to another.
//
// NOTHING HERE WRITES TO A CHANNEL. A session records, plans and reports. Every
// consequential external action stays behind the existing approvals gate, and for Etsy
// there is no write path to gate at all.

const orchestratorExecutionContract = require('./orchestratorExecutionContract');
const { saveSession } = require('./commandCenterSessionStore');

// How many prior results are offered to a turn as context. Bounded so a long session
// cannot grow an unbounded objective string or an unbounded research_params payload.
const MAX_CONTEXT_RESULTS = 10;
// How much of a stored summary is carried into a follow-up objective.
const MAX_SUMMARY_CHARS = 240;

// Matches an explicit reference to an earlier result: "#3", "number 3", "opportunity 3",
// "option 3", "result 3". Deliberately narrow - a bare "3" is NOT a reference, because
// "top 3 opportunities" is a quantity, not a citation, and treating it as one would
// silently answer a different question than the user asked.
const REFERENCE_PATTERNS = [
  /#\s*(\d{1,2})\b/i,
  /\b(?:number|no\.?|opportunity|option|result|item|candidate)\s*#?\s*(\d{1,2})\b/i,
];

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// Every distinct result reference the message cites, in order of appearance.
function extractReferences(text) {
  if (!nonEmptyString(text)) return [];
  const found = [];
  for (const pattern of REFERENCE_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, 'gi');
    let match = globalPattern.exec(text);
    while (match) {
      const ref = Number(match[1]);
      if (Number.isInteger(ref) && ref >= 1 && !found.includes(ref)) found.push(ref);
      match = globalPattern.exec(text);
    }
  }
  return found;
}

function findResult(session, ref) {
  return asArray(session.specialist_results).find((result) => result && result.ref === ref) || null;
}

// Turns "deep research #3" into an objective that names the thing, so the Chief routes on
// the real subject rather than on a pronoun. The user's own wording is preserved and the
// resolved subject is appended - never substituted - so intent is not rewritten.
function resolveObjective(session, message) {
  const refs = extractReferences(message);
  if (refs.length === 0) {
    return { ok: true, objective: message.trim(), resolved: [], unresolved: [] };
  }

  const resolved = [];
  const unresolved = [];
  for (const ref of refs) {
    const result = findResult(session, ref);
    if (result) resolved.push(result);
    else unresolved.push(ref);
  }

  if (resolved.length === 0) {
    // Nothing to resolve against. Asking is the only honest move: guessing which result
    // the user meant would answer a different question than the one they asked.
    return {
      ok: false,
      objective: null,
      resolved: [],
      unresolved,
      clarification:
        asArray(session.specialist_results).length === 0
          ? `This session has no numbered results yet, so there is nothing for ${unresolved.map((r) => `#${r}`).join(', ')} to refer to. Ask for research first, then refer to a result by its number.`
          : `This session has results #1-#${asArray(session.specialist_results).length}, so ${unresolved.map((r) => `#${r}`).join(', ')} does not exist. Which one did you mean?`,
    };
  }

  const subjectLines = resolved.map(
    (result) =>
      `#${result.ref} is "${result.label}"${result.channel ? ` (channel: ${result.channel}${result.channel_reference ? ` ${result.channel_reference}` : ''})` : ''}. ` +
      `Previously established: ${truncate(result.summary, MAX_SUMMARY_CHARS)}`
  );

  return {
    ok: true,
    // The user's instruction first, then the resolved facts - so the Chief's word-overlap
    // routing still sees the user's own verbs ("deep research", "draft", "analyse").
    objective: `${message.trim()}\n\nContext from this session:\n${subjectLines.join('\n')}`,
    resolved,
    unresolved,
  };
}

// What the Chief is given ALONGSIDE the objective. Carrying the prior evidence forward is
// what stops a follow-up turn from re-running and re-paying for research this session has
// already done - the token-efficiency requirement, applied at the session boundary rather
// than by weakening any existing cache.
function buildSessionResearchParams(session, resolvedResults, callerResearchParams) {
  const caller = callerResearchParams && typeof callerResearchParams === 'object' ? callerResearchParams : {};
  const priorEvidence = (resolvedResults.length > 0 ? resolvedResults : asArray(session.specialist_results).slice(-MAX_CONTEXT_RESULTS))
    .map((result) => ({
      topic: result.label,
      finding: truncate(result.summary, MAX_SUMMARY_CHARS),
      source: asArray(result.source),
    }))
    .filter((entry) => nonEmptyString(entry.topic));

  // The CALLER'S own params always win on a collision - session context only fills gaps,
  // exactly like agent/core/crossAgentContext.js's rule for injected context.
  return {
    ...(priorEvidence.length > 0 ? { sessionEvidence: priorEvidence } : {}),
    ...caller,
  };
}

// Records what a completed Chief run produced as REFERENCEABLE results, so the next turn
// can cite them. Refs continue across turns and are never reused.
//
// One entry per genuinely distinct outcome: a ranked opportunity list contributes one
// entry per opportunity (that is what "#3" means to a user), anything else contributes one
// entry per completed plan step.
// `summarize` is the caller's own step summariser (server.js owns summarizeExecutionState);
// passed in rather than reached for, so this module depends on nothing it does not import.
function recordResults(session, runResult, runId, summarize = null) {
  let nextRef = asArray(session.specialist_results).reduce((max, r) => Math.max(max, r.ref || 0), 0) + 1;
  const added = [];
  const plan = asArray(runResult.routing && runResult.routing.plan);

  for (const step of plan) {
    const specialist = (step.selected_specialist && step.selected_specialist.id) || null;
    const outputs = step.outputs || {};
    const payload = outputs.result || outputs;

    // A ranked opportunity list is the case a user actually numbers.
    const opportunities = asArray(payload && payload.top_opportunities);
    if (opportunities.length > 0) {
      for (const opportunity of opportunities) {
        const entry = {
          ref: nextRef,
          label: opportunity.product || `Opportunity ${opportunity.rank}`,
          specialist,
          run_id: runId,
          // Channel comes from the RECORD, never from the session's own guess.
          channel: opportunity.channel || (payload && payload.channel) || null,
          channel_reference: opportunity.channel_reference || null,
          summary: opportunity.customer_fit_reason || `Ranked ${opportunity.rank}.`,
          source: asArray(opportunity.evidence).map((e) => e && e.source_url).filter(Boolean).slice(0, 5),
          payload_ref: { run_id: runId, path: `top_opportunities[${opportunity.rank - 1}]` },
        };
        session.specialist_results.push(entry);
        added.push(entry);
        nextRef += 1;
      }
      continue;
    }

    // Everything else: one referenceable entry per completed step.
    if (step.completion_state === 'complete') {
      const entry = {
        ref: nextRef,
        label: `${specialist || 'Specialist'} result`,
        specialist,
        run_id: runId,
        channel: (payload && payload.channel) || null,
        channel_reference: null,
        summary: truncate(
          typeof summarize === 'function' ? summarize(step) : step.current_task || '',
          MAX_SUMMARY_CHARS
        ),
        source: [],
        payload_ref: { run_id: runId, path: 'outputs' },
      };
      session.specialist_results.push(entry);
      added.push(entry);
      nextRef += 1;
    }
  }
  return added;
}

// A compact record of the plan, for the session. The FULL execution state stays in the run
// record - this is what a conversation view needs, not a second copy of the run.
function summarizePlan(runResult, summarize) {
  return asArray(runResult.routing && runResult.routing.plan).map((step) => ({
    specialist: (step.selected_specialist && step.selected_specialist.id) || null,
    tool: asArray(step.tool_calls)[0] || null,
    status: step.completion_state || null,
    summary: typeof summarize === 'function' ? summarize(step) : null,
  }));
}

// One turn of the conversation. Returns the updated session plus this turn's run result.
//
// `runChief` is injectable ONLY so tests can drive the turn logic without spending real
// tokens; it defaults to the real orchestrator and nothing in production passes it.
async function runSessionTurn(
  session,
  message,
  {
    businessId = null,
    researchParams = null,
    sessionDir = undefined,
    runChief = orchestratorExecutionContract.runOrchestratorContract,
    summarizeStep = null,
    saveRun = null,
  } = {}
) {
  if (!session || typeof session !== 'object') throw new Error('runSessionTurn requires a session.');
  if (!nonEmptyString(message)) throw new Error('runSessionTurn requires a non-empty message.');

  const at = nowIso();
  session.messages.push({ role: 'user', text: message.trim(), at, run_id: null });
  session.current_goal = message.trim();
  session.updated_at = at;

  // Resolve any reference to an earlier result BEFORE the Chief is involved.
  const resolution = resolveObjective(session, message);
  if (!resolution.ok) {
    // A reference that cannot be resolved is a question back to the user - never a guess,
    // and never a run. No tokens are spent.
    session.messages.push({ role: 'chief', text: resolution.clarification, at: nowIso(), run_id: null });
    session.status = 'waiting_for_user';
    session.pending_items = [{ kind: 'information', detail: resolution.clarification, run_id: null }];
    session.updated_at = nowIso();
    saveSession(session, sessionDir ? { sessionDir } : undefined);
    return { session, runResult: null, clarification: resolution.clarification };
  }

  const effectiveResearchParams = buildSessionResearchParams(session, resolution.resolved, researchParams);

  let runResult;
  try {
    runResult = await runChief(resolution.objective, {
      researchParams: Object.keys(effectiveResearchParams).length > 0 ? effectiveResearchParams : null,
      businessId,
    });
  } catch (err) {
    // A failed turn is reported as a failed turn. Nothing is fabricated, and the session
    // stays usable so the user can try something else.
    const text = `That step could not complete: ${err.message}`;
    session.messages.push({ role: 'chief', text, at: nowIso(), run_id: null });
    session.status = 'waiting_for_user';
    session.limitations.push(text);
    session.updated_at = nowIso();
    saveSession(session, sessionDir ? { sessionDir } : undefined);
    return { session, runResult: null, error: err.message };
  }

  const runId = typeof saveRun === 'function' ? saveRun(runResult, resolution.objective) : null;
  if (runId) session.run_refs.push(runId);

  session.current_plan = summarizePlan(runResult, summarizeStep);
  const turnIndex = session.messages.filter((m) => m.role === 'user').length;
  for (const step of session.current_plan) {
    session.specialist_tasks.push({
      turn: turnIndex,
      specialist: step.specialist,
      tool: step.tool,
      status: step.status,
      at: nowIso(),
      run_id: runId,
    });
  }

  const added = recordResults(session, runResult, runId, summarizeStep);

  // Pending approvals are REFERENCED, never duplicated - the approval records themselves
  // stay in the existing approval system, which remains the only place a decision is made.
  const pending = asArray(runResult.pending_approvals);
  if (pending.length > 0) {
    session.status = 'waiting_for_approval';
    session.pending_items = [
      { kind: 'approval', detail: `${pending.length} step(s) need your sign-off before they can run.`, run_id: runId },
    ];
    if (runId && !session.approvals_reference.includes(runId)) session.approvals_reference.push(runId);
  } else {
    session.status = 'waiting_for_user';
    session.pending_items = [];
  }

  // The Chief's reply to the user, built from what the run actually reported.
  const chiefText =
    runResult.routing && runResult.routing.status === 'clarification_required'
      ? runResult.routing.reason || 'I need more detail before I can route this.'
      : added.length > 0
        ? `Done. ${added.length} result(s) are now numbered #${added[0].ref}-#${added[added.length - 1].ref} in this session; refer to any of them by number.`
        : 'That step completed but produced no referenceable result.';
  session.messages.push({ role: 'chief', text: chiefText, at: nowIso(), run_id: runId });

  // Next actions name the fact that produced them - never an invented suggestion.
  session.next_actions = added.length > 0
    ? [
        { id: 'deep_research', title: `Deep research one result (e.g. "deep research #${added[0].ref}")`, basis: `${added.length} numbered result(s) exist in this session.` },
        { id: 'view_run', title: 'Open the full run in History', basis: runId ? `Run ${runId} was saved.` : 'No run id was recorded.' },
      ]
    : [];

  // Limitations carry forward across turns rather than being lost with the run.
  for (const limitation of asArray(runResult.routing && runResult.routing.limitations)) {
    if (!session.limitations.includes(limitation)) session.limitations.push(limitation);
  }

  session.updated_at = nowIso();
  saveSession(session, sessionDir ? { sessionDir } : undefined);
  return { session, runResult, run_id: runId, added_results: added };
}

module.exports = {
  MAX_CONTEXT_RESULTS,
  MAX_SUMMARY_CHARS,
  REFERENCE_PATTERNS,
  extractReferences,
  findResult,
  resolveObjective,
  buildSessionResearchParams,
  recordResults,
  summarizePlan,
  runSessionTurn,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Command Center session layer:\n');
  console.log('This module contains NO routing, specialist selection or tool dispatch.');
  console.log('Every turn ends in one call to the existing runOrchestratorContract().\n');
  console.log('Reference extraction:');
  for (const text of ['deep research #3', 'tell me about opportunity 2', 'give me the top 3 opportunities', 'compare #1 and #4', 'what next?']) {
    console.log(`  ${JSON.stringify(text).padEnd(42)} -> ${JSON.stringify(extractReferences(text))}`);
  }
  console.log('\nNote "top 3 opportunities" yields NO reference: that 3 is a quantity, not a citation.');
}
