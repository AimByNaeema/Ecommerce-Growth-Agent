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
// The opportunity preparation sequence. It defines stages; the EXISTING growth workflow
// engine runs them. This module still performs no dispatch of its own.
const { prepareOpportunity } = require('./opportunityPreparationWorkflow');
const runHistoryStore = require('./runHistoryStore');
// Completed research for this business's connected store, found through the run history store
// (never through another session). The Chief decides whether a turn continues it.
const researchContext = require('./researchContext');

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

// "the first opportunity" means #1. Ordinal WORDS are matched separately from the numeric
// patterns above because they need a following noun to count as a citation - "first" alone
// ("first, check the stock") is an ordering word, not a reference to a result.
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ORDINAL_REFERENCE_PATTERN =
  /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:opportunity|option|result|item|candidate|one)\b/gi;

// A numbering SCALE describes how the ANSWER should be numbered - "rank them from #1 (highest
// priority) to #10" - not which earlier result is meant, so the markers inside one are not
// citations. Recognised by the scale construction itself, "from #a ... to #b", so "compare #1
// and #4", "compare #1 to #4" and "show #2-#5" still cite earlier results exactly as before.
const NUMBERED_RANGE_PATTERNS = [
  /\bfrom\s+#\s*\d{1,2}\b[^#.?!]{0,40}?\b(?:to|through|thru|until)\s+#\s*\d{1,2}\b/gi,
];

// PREPARATION INTENT. "Prepare #1 for listing" is a different request from "tell me about
// #1": it runs a sequence of specialists rather than one. Recognised by phrase shape and
// ONLY when the message also cites a result, so a bare "prepare a marketing plan" is
// untouched. Deterministic - no model call decides this.
const PREPARATION_INTENT_PATTERN =
  /\b(?:prepare|evaluate|validate|assess|work up|take .{0,12}forward)\b|\bready\s+(?:it|this|that)\s+for\b|\bfor\s+(?:listing|selling|sale)\b/i;

// Asking to SEE something already produced. Never re-runs anything.
const RECALL_INTENT_PATTERN =
  /\b(?:show|see|view|display|open|what(?:'s| is|'re| are))\b[^.?!]{0,30}\b(?:draft|listing|seo|validation|approval|result|workflow|status)\b/i;

function hasPreparationIntent(text) {
  return typeof text === 'string' && PREPARATION_INTENT_PATTERN.test(text);
}

function hasRecallIntent(text) {
  return typeof text === 'string' && RECALL_INTENT_PATTERN.test(text);
}

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
function extractReferences(rawText) {
  if (!nonEmptyString(rawText)) return [];
  const text = NUMBERED_RANGE_PATTERNS.reduce((remaining, pattern) => remaining.replace(pattern, ' '), rawText);
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
  // Ordinal words, resolved against the same 1-based numbering.
  const ordinalPattern = new RegExp(ORDINAL_REFERENCE_PATTERN.source, 'gi');
  let ordinalMatch = ordinalPattern.exec(text);
  while (ordinalMatch) {
    const ref = ORDINAL_WORDS.indexOf(String(ordinalMatch[1]).toLowerCase()) + 1;
    if (ref >= 1 && !found.includes(ref)) found.push(ref);
    ordinalMatch = ordinalPattern.exec(text);
  }
  return found;
}

// Reads one opportunity back out of a saved run record. The session stores only a
// reference (run_id + rank), so the full record is the source of truth - nothing is
// duplicated into session state.
//
// Matched by RANK first and by product name second: rank is what the user cited, and the
// name is the fallback when a record's own numbering differs from the session's running
// ref counter.
function findOpportunityInRecord(record, ref, label) {
  const plan = record && record.result && record.result.routing && Array.isArray(record.result.routing.plan)
    ? record.result.routing.plan
    : [];
  for (const step of plan) {
    const outputs = (step && step.outputs) || {};
    const result = outputs.result || outputs;
    const list = asArray(result && result.top_opportunities);
    if (list.length === 0) continue;
    const byName = label ? list.find((item) => item && item.product === label) : null;
    if (byName) return byName;
    const byRank = list.find((item) => item && item.rank === ref);
    if (byRank) return byRank;
  }
  return null;
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

  // The Chief's ranked store opportunities ARE what this turn produced - each becomes one
  // numbered result, in rank order, so "#3" afterwards means the third-ranked opportunity. The
  // research steps they were ranked from stay in the run record rather than being numbered again.
  // A change proposal's products are what the turn produced: each is numbered with the approval it
  // waits on, so "#2" afterwards means the second proposed product.
  const proposal = runResult.seo_change_proposal;
  if (proposal && asArray(proposal.products).length > 0) {
    for (const product of proposal.products) {
      const entry = {
        ref: nextRef,
        label: `SEO proposal: ${product.product_reference}`,
        specialist: 'seo',
        run_id: runId,
        channel: proposal.platform || null,
        channel_reference: product.shopify_product_id || null,
        summary: truncate(
          asArray(product.proposed_changes).map((change) => `${change.shopify_field} -> "${change.after}"`).join('; ') +
            (product.approval_id ? ` (approval ${product.approval_id} pending)` : ' (not sent for approval)'),
          MAX_SUMMARY_CHARS
        ),
        source: [],
        payload_ref: { run_id: runId, path: `seo_change_proposal.products[${product.rank - 1}]` },
      };
      session.specialist_results.push(entry);
      added.push(entry);
      nextRef += 1;
    }
    return added;
  }

  const priorities = runResult.store_opportunity_priorities;
  if (priorities && asArray(priorities.opportunities).length > 0) {
    for (const opportunity of priorities.opportunities) {
      const entry = {
        ref: nextRef,
        label: opportunity.title,
        specialist: 'chief',
        run_id: runId,
        // The platform the research reads used - from the run's own tool records, not a guess.
        channel: priorities.platform || null,
        channel_reference: null,
        summary: truncate(
          `${opportunity.effort === 'quick_win' ? 'Quick win' : 'Higher effort'}: ${opportunity.why_it_matters} First action: ${opportunity.first_action}`,
          MAX_SUMMARY_CHARS
        ),
        source: [],
        payload_ref: { run_id: runId, path: `store_opportunity_priorities.opportunities[${opportunity.rank - 1}]` },
      };
      session.specialist_results.push(entry);
      added.push(entry);
      nextRef += 1;
    }
    return added;
  }

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

// The Chief's reply for a turn that continued earlier research: where the evidence came from,
// the ranked opportunities split into quick wins and higher-effort work, and what was not
// established. Built only from the run's own research_continuity and store_opportunity_priorities.
function describeContinuation(runResult, added) {
  const continuity = runResult.research_continuity || {};
  const priorities = runResult.store_opportunity_priorities || {};
  const lines = [];
  if (continuity.mode === 'reused' && continuity.source) {
    const source = continuity.source;
    const platform = nonEmptyString(continuity.platform) ? continuity.platform.charAt(0).toUpperCase() + continuity.platform.slice(1) : 'store';
    lines.push(
      `Using completed research run ${source.run_id} (${asArray(source.specialists).join(', ')}; real ${platform} data; ` +
        `produced ${source.produced_at}, ${source.age_minutes} minute(s) ago). No new store read was made.`
    );
  } else if (nonEmptyString(continuity.reason)) {
    lines.push(continuity.reason);
  }

  const opportunities = asArray(priorities.opportunities);
  const proposal = runResult.seo_change_proposal;
  if (proposal) {
    // A change proposal: the SEO issues it stands on, then each proposed product's before/after.
    const issues = asArray(proposal.seo_issues);
    if (issues.length > 0) {
      lines.push('Highest-priority SEO issues in that research:');
      lines.push(...issues.slice(0, 5).map((issue) => `#${issue.rank} ${issue.issue} (${issue.affected_products} of ${issue.audited_products} products)`));
    }
    const products = asArray(proposal.products);
    if (products.length === 0) {
      lines.push('No SEO change could be derived from the products\' own stored text, so nothing was proposed.');
    } else {
      lines.push(`Proposed SEO changes for the ${products.length} most important product(s) - nothing has been written to your store:`);
      for (const product of products) {
        lines.push(`#${product.rank} ${product.product_reference}${product.status ? ` (${product.status})` : ''}`);
        for (const change of asArray(product.proposed_changes)) {
          lines.push(`  ${change.shopify_field}: before "${change.before || ''}" -> after "${change.after}" (from the ${change.derived_from})`);
        }
        for (const skipped of asArray(product.not_proposed)) lines.push(`  Not proposed - ${skipped.issue}: ${skipped.reason}`);
        lines.push(
          `  Compliance: ${product.compliance ? product.compliance.compliance_status : 'not checked'}. ` +
            (product.approval_id ? `Approval ${product.approval_id} is waiting for your decision.` : 'Not sent for approval.')
        );
      }
    }
    lines.push(...asArray(proposal.limitations));
  } else if (opportunities.length === 0) {
    lines.push('The research did not support any rankable opportunity.');
  } else {
    lines.push(`Ranked ${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'}, #1 = highest priority:`);
    const describe = (opportunity) =>
      `#${opportunity.rank} ${opportunity.title} (${opportunity.estimated_impact.affected_products} of ${opportunity.estimated_impact.audited_products} audited products). ` +
      `Why: ${opportunity.why_it_matters} First action: ${opportunity.first_action}`;
    const quickWins = opportunities.filter((opportunity) => opportunity.effort === 'quick_win');
    const higherEffort = opportunities.filter((opportunity) => opportunity.effort !== 'quick_win');
    if (quickWins.length > 0) lines.push('Quick wins:', ...quickWins.map(describe));
    if (higherEffort.length > 0) lines.push('Higher effort:', ...higherEffort.map(describe));
  }
  if (!proposal) lines.push(...asArray(priorities.limitations));
  if (asArray(runResult.pending_approvals).length === 0) lines.push('Nothing was changed in your store.');
  else lines.push('Nothing has been written to your store; each proposal is waiting for your approval.');
  if (added.length > 0) {
    lines.push(`These are numbered #${added[0].ref}-#${added[added.length - 1].ref} in this session; refer to any of them by number.`);
  }
  return lines.join('\n');
}

// The Chief's reply for a READ-ONLY check of an existing proposal: the current store value of each
// proposed field beside the proposal's before/after values, and every execution check with its result.
function describeProposalCheck(check) {
  const quote = (value) => (value === null || value === undefined ? '(not read)' : `"${value}"`);
  const yesNo = (value) => (value === null ? 'unknown' : value ? 'yes' : 'no');
  const lines = [
    `Read-only check of SEO proposal ${check.source_approval_id} (${check.source_approval_status}) for "${check.product_reference}", against a fresh read of your Shopify store:`,
  ];
  for (const field of asArray(check.fields)) {
    lines.push(
      `  ${field.shopify_field}: current ${quote(field.current)} | proposal before "${field.before || ''}" | proposal after "${field.after}" - matches before: ${yesNo(field.matches_before)}`
    );
  }
  if (check.read_failure) lines.push(check.read_failure);
  lines.push(
    check.all_match_before
      ? 'The current store values still match the proposal\'s before-values.'
      : 'The current store values do NOT all match the proposal\'s before-values.'
  );
  lines.push(`Eligible for execution: ${check.eligible_for_execution ? 'yes' : 'no'}.`);
  for (const entry of asArray(check.checks)) lines.push(`  [${entry.passed ? 'pass' : 'fail'}] ${entry.check}: ${entry.detail}`);
  if (check.eligible_for_execution) lines.push('Applying it would still create a new approval that only you can sign.');
  lines.push('No approval was created, approved or executed, and nothing was written to your store.');
  return lines.join('\n');
}

// The Chief's reply for a turn that asked to apply an existing proposal: which stored proposal it
// resolved to, exactly what will be written, and the approval it waits on. Built only from the run's
// own proposal_execution.
function describeProposalExecution(execution) {
  const lines = [];
  const changes = asArray(execution.applied_changes);
  if (execution.approval_id) {
    lines.push(
      `Found the ${execution.source_approval_status || 'stored'} SEO proposal ${execution.source_approval_id} for "${execution.product_reference}". ` +
        'Prepared exactly its approved value(s) for Shopify:'
    );
    for (const change of changes) lines.push(`  ${change.shopify_field}: before "${change.before || ''}" -> after "${change.after}"`);
    if (asArray(execution.not_applied).length > 0) {
      lines.push(`Not included, because you did not ask for it: ${execution.not_applied.join(', ')}.`);
    }
    lines.push(
      `Approval ${execution.approval_id} is waiting for your decision. Nothing has been written to your store. ` +
        'Once you approve it, only these field(s) are written; the product is then re-read from Shopify, and the change is recorded as done only if ' +
        'Shopify shows exactly these values with no other field changed. If the store no longer shows the "before" value, nothing is written.'
    );
  } else {
    lines.push(`No approval was created for the SEO proposal on "${execution.product_reference || 'this product'}": ${execution.reason || 'it did not pass the checks.'}`);
    lines.push('Nothing was written to your store.');
  }
  return lines.join('\n');
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
    // The server's own live approval array, so a request created here lands in the SAME
    // list the Approval Center reads. Omitted -> a local array, and the request is still
    // returned on the result.
    approvalRequests = null,
    // Both injectable ONLY so tests can drive the turn logic without spending tokens or
    // touching disk; production passes neither.
    runPreparation = prepareOpportunity,
    loadRunRecord = runHistoryStore.getRunRecordById,
    // Injectable ONLY so tests can pin the store identity and clock; production passes none.
    lookupResearch = researchContext.lookupResearchContext,
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

  // --- RECALL: the user wants to SEE something this session already produced. -----------
  // Reads stored state and spends nothing - no orchestrator call, no model call. This is
  // what stops "show me the draft" from re-running the whole workflow.
  if (hasRecallIntent(message) && asArray(session.opportunity_workflows).length > 0) {
    const refs = extractReferences(message);
    const wanted = refs.length > 0 ? refs[0] : null;
    const workflow =
      (wanted !== null
        ? asArray(session.opportunity_workflows).find((w) => w.ref === wanted)
        : asArray(session.opportunity_workflows)[asArray(session.opportunity_workflows).length - 1]) || null;
    if (workflow) {
      const text =
        `Opportunity #${workflow.ref} (${workflow.product}) is at ${workflow.state}. ` +
        `Compliance: ${workflow.compliance_status}. ` +
        (workflow.approval_id ? `Approval ${workflow.approval_id} is ${workflow.approval_status}. ` : '') +
        (asArray(workflow.missing_information).length > 0
          ? `${workflow.missing_information.length} product fact(s) remain NEEDS_INFORMATION.`
          : 'No product facts are outstanding.');
      session.messages.push({ role: 'chief', text, at: nowIso(), run_id: workflow.run_id || null });
      session.status = 'waiting_for_user';
      session.updated_at = nowIso();
      saveSession(session, sessionDir ? { sessionDir } : undefined);
      return { session, runResult: null, recalled: workflow };
    }
  }

  // --- PREPARE: run the opportunity preparation sequence for a resolved opportunity. ----
  if (hasPreparationIntent(message) && resolution.resolved.length > 0) {
    const target = resolution.resolved[0];
    // The full opportunity lives in the run record; the session holds only a reference.
    const record = target.run_id ? loadRunRecord(target.run_id) : null;
    const opportunity = findOpportunityInRecord(record, target.ref, target.label);
    if (!opportunity) {
      const text =
        `#${target.ref} ("${target.label}") is recorded in this session, but its full research result could not be read back, so nothing was prepared.`;
      session.messages.push({ role: 'chief', text, at: nowIso(), run_id: null });
      session.status = 'waiting_for_user';
      session.limitations.push(text);
      session.updated_at = nowIso();
      saveSession(session, sessionDir ? { sessionDir } : undefined);
      return { session, runResult: null, error: text };
    }

    let prepared;
    try {
      prepared = await runPreparation({
        opportunity,
        sessionId: session.session_id,
        runId: target.run_id,
        businessId,
        approvalRequests,
      });
    } catch (err) {
      const text = `Preparing #${target.ref} could not complete: ${err.message}`;
      session.messages.push({ role: 'chief', text, at: nowIso(), run_id: null });
      session.status = 'waiting_for_user';
      session.limitations.push(text);
      session.updated_at = nowIso();
      saveSession(session, sessionDir ? { sessionDir } : undefined);
      return { session, runResult: null, error: err.message };
    }

    // Workflow state lives on the session so a later turn can read it without re-running.
    const entry = {
      ref: target.ref,
      product: prepared.opportunity.product,
      state: prepared.state,
      compliance_status: prepared.compliance ? prepared.compliance.status : null,
      // The channel the OPPORTUNITY stated, never inferred here.
      channel: prepared.opportunity.channel || null,
      channel_reference: prepared.opportunity.channel_reference || null,
      stages: Object.keys(prepared.stages || {}).reduce((acc, key) => {
        acc[key] = prepared.stages[key] ? prepared.stages[key].status : null;
        return acc;
      }, {}),
      approval_id: prepared.approval ? prepared.approval.id : null,
      approval_status: prepared.approval ? prepared.approval.status : null,
      missing_information: prepared.missing_information || [],
      run_id: prepared.workflow_run_id || null,
      at: nowIso(),
    };
    session.opportunity_workflows = asArray(session.opportunity_workflows)
      .filter((w) => w.ref !== entry.ref)
      .concat([entry]);

    if (entry.run_id && !session.run_refs.includes(entry.run_id)) session.run_refs.push(entry.run_id);
    if (prepared.approval && !session.approvals_reference.includes(entry.run_id || entry.approval_id)) {
      session.approvals_reference.push(entry.run_id || entry.approval_id);
    }
    session.status = prepared.approval ? 'waiting_for_approval' : 'waiting_for_user';
    session.pending_items = prepared.approval
      ? [{ kind: 'approval', detail: `Listing draft for #${entry.ref} needs your decision before anything could be published.`, run_id: entry.run_id }]
      : [];
    for (const limitation of asArray(prepared.limitations)) {
      if (!session.limitations.includes(limitation)) session.limitations.push(limitation);
    }

    const text =
      `Opportunity #${entry.ref} (${entry.product}) is now at ${entry.state}. ` +
      `Compliance returned ${entry.compliance_status}. ` +
      (entry.approval_id
        ? `Approval ${entry.approval_id} is pending your decision - nothing has been published anywhere.`
        : 'No approval was requested.') +
      (entry.missing_information.length > 0
        ? ` ${entry.missing_information.length} product fact(s) are NEEDS_INFORMATION rather than guessed.`
        : '');
    session.messages.push({ role: 'chief', text, at: nowIso(), run_id: entry.run_id });
    // Every next action states the fact that produced it, so none of them may claim a draft
    // exists when the workflow stopped before writing one.
    if (entry.state === 'COMPLIANCE_BLOCKED') {
      session.next_actions = [
        {
          id: 'view_compliance',
          title: `Show why #${entry.ref} was blocked`,
          basis: `Compliance returned ${entry.compliance_status} for #${entry.ref}, so no listing draft was prepared.`,
        },
      ];
    } else if (entry.state === 'NEEDS_INFORMATION') {
      session.next_actions = [
        {
          id: 'supply_product_facts',
          title: `Supply the missing product facts for #${entry.ref}`,
          basis: `${entry.missing_information.length} product fact(s) are not established by the research, so no reviewable draft could be composed for #${entry.ref}.`,
        },
      ];
    } else {
      session.next_actions = [
        { id: 'view_draft', title: `Show the draft for #${entry.ref}`, basis: `A listing draft was produced and stored for #${entry.ref}.` },
      ];
    }
    session.updated_at = nowIso();
    saveSession(session, sessionDir ? { sessionDir } : undefined);
    return { session, runResult: null, prepared };
  }

  const effectiveResearchParams = buildSessionResearchParams(session, resolution.resolved, researchParams);

  // RESEARCH CONTINUITY. The Chief is told which completed research exists for THIS session's
  // business and connected store - looked up in the run history store, so research from an
  // earlier session counts and nothing from another business or store can. Whether the objective
  // actually continues that research is the Chief's decision, not this module's. A lookup
  // failure only means the Chief is told nothing.
  let turnResearchContext = null;
  try {
    turnResearchContext =
      typeof lookupResearch === 'function' ? lookupResearch({ businessId: session.business_id || businessId || null }) : null;
  } catch (err) {
    turnResearchContext = null;
  }

  let runResult;
  try {
    runResult = await runChief(resolution.objective, {
      researchParams: Object.keys(effectiveResearchParams).length > 0 ? effectiveResearchParams : null,
      businessId,
      researchContext: turnResearchContext,
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
      : runResult.proposal_check
        ? describeProposalCheck(runResult.proposal_check)
      : runResult.proposal_execution
        ? describeProposalExecution(runResult.proposal_execution)
      : runResult.store_opportunity_priorities
        ? describeContinuation(runResult, added)
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
  findOpportunityInRecord,
  hasPreparationIntent,
  hasRecallIntent,
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
