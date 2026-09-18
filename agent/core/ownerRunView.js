'use strict';

// THE OWNER'S VIEW OF A RUN - what the dashboard shows a non-technical owner about what the
// Chief did, what is waiting for them, and what actually changed.
//
// IT DERIVES, IT NEVER DECIDES. Every field below is read from what the Chief
// (agent/core/orchestratorExecutionContract.js), the approval system (approvals/) and the
// verification layer (reliability/executionVerification.js, via
// integrations/approvedCorrectionDispatch.js) actually recorded. It grants nothing, runs
// nothing and cannot turn a failure into a success: a status of 'success' is only ever
// reported when every plan step completed, the Chief's own result validation passed, nothing
// is still waiting for a decision, and every executed store change was independently verified.
//
// ALLOW-LISTED OUTPUT. Only the fields named here leave this module - never a raw execution
// request, audit detail, policy trace or credential - so a response built from it is safe to
// send to the browser.

const { getToolById } = require('../../tools/toolRegistry');
const { summarizeExecutionState } = require('./resultSummary');
// The one truthful answer to "how far does this project go with platform X" - derived in that
// module from the adapter registry and the publishing paths that genuinely exist, never
// asserted. It is what lets this file state an access mode without writing one down.
const { describePlatformSupport } = require('../../integrations/adapters/platformSupportRegistry');
// Turns one etsy_listing_data_retrieval result into the ranked, evidence-carrying answer the
// owner asked for. It judges nothing and invents nothing - see that module's own header.
const { deriveEtsyListingOpportunities } = require('./etsyListingOpportunities');
// Turns the store records a run already read into specific, evidenced opportunities. It reads
// the plan and nothing else - no tool call, no network - and assesses only fields that were
// genuinely retrieved; see that module's own header for why that distinction is the whole
// difficulty.
const { deriveStoreDataOpportunities } = require('./storeDataOpportunities');
// The single source of truth for which tools change real store data - the same list
// agent/core/mutationIntent.js re-exports. A store change is only ever one of these.
const { isCorrectionTool } = require('../../integrations/approvedCorrectionDispatch');

const OWNER_STATUSES = [
  'success',
  'partial',
  'waiting_for_approval',
  'rejected',
  'blocked_by_compliance',
  'failed',
  'verification_failed',
  'needs_clarification',
];

const STATUS_TEXT = {
  success: 'Done. The Chief completed this, and every result it relied on was checked.',
  partial: 'Partly done. Some steps did not finish - the details below say which.',
  waiting_for_approval: 'Waiting for your approval. Nothing that changes your store has happened yet.',
  rejected: 'You rejected this action, so it was not carried out.',
  blocked_by_compliance: 'Blocked by the compliance check. It cannot be approved or carried out.',
  failed: 'This did not complete. Nothing is reported as done that was not.',
  verification_failed: 'The action ran, but the store did not confirm the change. Treat it as not done and check the store.',
  needs_clarification: 'The Chief needs more detail before it can decide how to handle this.',
};

const MAX_LIST_ENTRIES = 10;

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// What each existing store correction changes, described from its OWN stated parameters.
// Nothing is looked up or inferred: a parameter the request does not carry is reported as null.
const ACTION_DESCRIPTIONS = {
  shopify_vendor_correction: (params) => ({
    what_changes: 'Product vendor',
    entity_type: 'product',
    entity_id: str(params.productId),
    proposed_value: str(params.newVendor),
  }),
  shopify_inventory_correction: (params) => ({
    what_changes: 'Inventory quantity',
    entity_type: 'inventory item',
    entity_id: str(params.inventoryItemId),
    proposed_value: Number.isFinite(Number(params.delta)) && params.delta !== null && params.delta !== ''
      ? `Adjust by ${Number(params.delta)}${str(params.locationId) ? ` at location ${params.locationId}` : ''}`
      : null,
  }),
  shopify_collection_membership_update: (params) => ({
    what_changes: 'Collection membership',
    entity_type: 'product',
    entity_id: str(params.productId),
    proposed_value: str(params.collectionId) ? `Add to collection ${params.collectionId}` : null,
  }),
  shopify_product_seo_update: (params) => ({
    what_changes: 'SEO title / meta description (written to Shopify only after your approval)',
    entity_type: 'product',
    entity_id: str(params.productId),
    proposed_value:
      asArray(params.appliedChanges)
        .filter(isPlainObject)
        .map((change) => `${change.shopify_field}: "${change.before || ''}" → "${change.after}"`)
        .join('; ') || null,
  }),
};

// The platform a tool is registered for, when the registry names exactly one. A tool that
// names none (platform-neutral) or several is reported as null rather than guessed.
function platformForTool(toolId) {
  const tool = typeof toolId === 'string' ? getToolById(toolId) : null;
  const platforms = tool && Array.isArray(tool.platforms) ? tool.platforms : [];
  return platforms.length === 1 ? platforms[0] : null;
}

// WHAT A PLATFORM READ STEP TELLS THE OWNER ABOUT THE STORE IT READ.
//
// The same shape as ACTION_DESCRIPTIONS above, and there for the same reason: a step's own
// returned record is turned into labelled lines, and a field the platform did not return is
// reported as unavailable rather than filled in. Nothing is looked up, computed or inferred.
//
// WHY A TOOL-KEYED MAP RATHER THAN EVERY READ. Each platform's shop record has its own field
// names - they are that platform's names, not this project's (see normalizeEtsyShop in
// integrations/adapters/etsyReadClient.js, which renames nothing) - so there is no generic
// record shape to read. A read whose fields are not described here simply keeps the existing
// generic step summary, exactly as before.
const STORE_READ_FIELDS = {
  etsy_shop_data_retrieval: [
    { id: 'shop_name', label: 'Etsy shop name' },
    { id: 'shop_id', label: 'Etsy shop ID' },
    { id: 'listing_active_count', label: 'Active listing count' },
    { id: 'digital_listing_count', label: 'Digital listing count' },
  ],
};

const ACCESS_TEXT = {
  read_only:
    'Read-only. This system can read this platform and has no publishing path to it, so it cannot change anything there.',
  read_write:
    'Read and write. Real write paths exist, and every one of them still requires your explicit approval before it runs.',
  no_access:
    'No access. No read adapter for this platform is registered, so nothing can be read from it or changed on it.',
};

// HOW MUCH ACCESS THIS SYSTEM HAS TO A PLATFORM - DERIVED, NEVER DECLARED HERE.
//
// Both inputs come from integrations/adapters/platformSupportRegistry.js, which computes them
// from the modules that actually decide them: whether a conforming read adapter is registered,
// and whether a publishing path genuinely exists and can publish. For Etsy that is
// read_adapter_registered true and publishing_available false - so 'read_only' is a
// consequence of the code that exists, not a status anyone typed. Adding a working Etsy
// publishing path would change this answer by itself, with no edit here.
function accessModeFor(platform) {
  const support = describePlatformSupport(platform);
  if (!support.read_adapter_registered) return 'no_access';
  return support.publishing_available ? 'read_write' : 'read_only';
}

// One plan step's store connection, or null when that step read no platform this file
// describes. Reported whether or not the read succeeded: the access mode is a fact about the
// integration, while `connected` says whether this run actually reached the store.
function storeConnectionFrom(step) {
  const inputs = isPlainObject(step) && isPlainObject(step.inputs) ? step.inputs : {};
  const described = STORE_READ_FIELDS[inputs.tool_id];
  if (!described) return null;
  const platform = platformForTool(inputs.tool_id);
  if (!platform) return null;

  const outputs = isPlainObject(step.outputs) ? step.outputs : {};
  const record = isPlainObject(outputs.result) ? outputs.result : null;
  const support = describePlatformSupport(platform);
  const accessMode = accessModeFor(platform);

  const fields = described.map(({ id, label }) => {
    // undefined and missing are the same thing here, and both mean unavailable. A value the
    // platform really returned as null stays null and unavailable too - it is never defaulted.
    const value = record && record[id] !== undefined && record[id] !== null ? record[id] : null;
    return { id, label, value, available: value !== null };
  });

  return {
    platform,
    connected: outputs.status === 'success' && Boolean(record),
    access_mode: accessMode,
    access_text: ACCESS_TEXT[accessMode],
    publishing_available: support.publishing_available,
    fields,
    unavailable_fields: fields.filter((field) => !field.available).map((field) => field.id),
  };
}

// The owner-facing sentence for such a step: the fields they asked for and the access mode,
// both stated outright. An unavailable field says so rather than being left out, so a missing
// value can never read as if it had not been asked for.
function storeConnectionSummary(connection) {
  const values = connection.fields
    .map((field) => `${field.label}: ${field.available ? field.value : 'unavailable'}`)
    .join('; ');
  return `${values}. Connection: ${connection.access_mode.replace(/_/g, '-')}.`;
}

// THE ETSY LISTING ANALYSIS, AS THE OWNER ASKED FOR IT.
//
// Without this the step returned a page of listing records and the owner saw
// agent/core/resultSummary.js's generic "Product completed this request successfully." - the
// analysis was in the raw run result and nowhere in what anybody read. Limited to 5 because
// that is what the request asks for; every field is relayed from the derivation, which relays
// it from Etsy.
const MAX_LISTING_OPPORTUNITIES = 5;

// DELIBERATELY NOT GATED ON completion_state. tools/etsyListingDataTool.js maps the aggregate
// compliance verdict onto its own tool status, so a page of real listings carrying REVIEW
// findings comes back 'partial' and the step reads 'blocked' - and those very findings are the
// evidence the owner asked for. The honest gate is whether a real result came back at all: a
// failed or empty read returns result: null and falls through to its own error sentence.
function listingOpportunitiesFrom(step) {
  const inputs = isPlainObject(step) && isPlainObject(step.inputs) ? step.inputs : {};
  if (inputs.tool_id !== 'etsy_listing_data_retrieval') return null;
  const outputs = isPlainObject(step.outputs) ? step.outputs : {};
  if (!isPlainObject(outputs.result)) return null;
  const derived = deriveEtsyListingOpportunities(outputs.result, { limit: MAX_LISTING_OPPORTUNITIES });
  return derived && derived.opportunities.length > 0 ? derived : null;
}

// One line per opportunity: the title and status Etsy returned, what the evidence supports, and
// the evidence itself. A field Etsy did not return says "unavailable" rather than disappearing.
function listingOpportunitiesSummary(derived) {
  const lines = derived.opportunities.map((entry, index) => {
    const title = entry.title === null ? 'title unavailable' : `"${entry.title}"`;
    const state = entry.state === null ? 'status unavailable' : `status ${entry.state}`;
    const unavailable = entry.unavailable.length > 0 ? ` Unavailable: ${entry.unavailable.map((field) => field.id).join(', ')}.` : '';
    return `${index + 1}. ${title} (${state}) - ${entry.opportunity} Evidence: ${entry.evidence.join(' ')}${unavailable}`;
  });
  const scope =
    `${derived.opportunities.length} of ${derived.considered.listings_considered} listing(s) examined` +
    ` (${derived.considered.digital_filter_applied ? 'digital only' : 'not restricted to digital'}).`;
  return `${scope} ${lines.join(' ')} Not retrievable from Etsy, and not estimated: ${derived.unavailable_metrics.map((metric) => metric.id).join(', ')}.`;
}

// WHAT A SPECIALIST ACTUALLY FOUND, FROM THE ENVELOPE IT ALREADY COMPOSES.
//
// Six specialists (Research, SEO, Listing, Marketing, Social & Advertising, Analytics &
// Optimization) all compose the SAME *AgentResultModel shape - findings, evidence, source,
// limitations, recommendations, confidence, verification_status. All of it was already in the
// run result and none of it reached the owner: agent/core/resultSummary.js has no projection
// for that envelope, so it fell through to its generic last line and a completed growth cycle
// read "Analytics & Optimization completed this request successfully." while its own result
// held the order count, the evidence behind it and the limitations on it.
//
// NOTHING IS COMPOSED HERE. Every list below is relayed verbatim from what the specialist
// recorded; a specialist that recorded nothing is reported as having recorded nothing rather
// than being given a sentence. This module still derives and never decides.
const SPECIALIST_ENVELOPE_LISTS = ['findings', 'evidence', 'source', 'limitations', 'recommendations'];

// A sentence the step or its own result already composed, in the same order
// agent/core/resultSummary.js's outputsOwnSummary prefers them. Named here so the findings
// chain can tell "the specialist wrote its own summary" from "the generic fallback ran".
function ownSummaryOf(step) {
  const outputs = isPlainObject(step) && isPlainObject(step.outputs) ? step.outputs : {};
  const result = isPlainObject(outputs.result) ? outputs.result : {};
  return str(step && step.summary) || str(outputs.summary) || str(result.summary);
}

function specialistEnvelope(result) {
  if (!isPlainObject(result)) return null;
  return SPECIALIST_ENVELOPE_LISTS.some((field) => Array.isArray(result[field])) ? result : null;
}

// Plain strings only. An entry that is not a string (or an object naming one) is dropped rather
// than stringified into something the specialist never said.
function textList(value) {
  return asArray(value)
    .map((entry) => (typeof entry === 'string' ? entry : isPlainObject(entry) && typeof entry.text === 'string' ? entry.text : null))
    .map((entry) => (entry ? entry.trim() : null))
    .filter(Boolean)
    .slice(0, MAX_LIST_ENTRIES);
}

// One step's real output, per specialist and per platform. Returns null for a step whose result
// this file already describes more specifically (the Etsy reads above) or that produced no
// structured result at all, so those keep their existing, better projections.
function specialistResultFrom(step, pendingApprovals) {
  const inputs = isPlainObject(step) && isPlainObject(step.inputs) ? step.inputs : {};
  const outputs = isPlainObject(step.outputs) ? step.outputs : {};
  const result = outputs.result;
  const envelope = specialistEnvelope(result);
  const records = Array.isArray(result) ? result.filter(isPlainObject) : null;
  if (!envelope && !records) return null;

  const entry = {
    specialist: specialistTitle(step),
    platform: platformForTool(inputs.tool_id),
    capability: str(inputs.capability_id),
    tool: str(inputs.tool_id),
    state: str(step.completion_state),
    findings: [],
    recommendations: [],
    evidence: [],
    sources: [],
    limitations: [],
    record_count: records ? records.length : null,
    // From this step's OWN recorded approvals - an auto-approved analysis needs nothing from
    // the owner, anything else does. Never inferred from the tool's name.
    requires_approval: asArray(step.approvals).some((approval) => isPlainObject(approval) && approval.status !== 'auto_approved'),
    proposed_action: null,
    no_findings_reason: null,
  };

  if (envelope) {
    entry.findings = textList(envelope.findings);
    entry.recommendations = textList(envelope.recommendations);
    entry.evidence = textList(envelope.evidence);
    entry.sources = textList(envelope.source);
    entry.limitations = textList(envelope.limitations);
  } else {
    // A plain array of *Model records (product_discovery's productModel records). The COUNT and
    // the records' own `source` strings are facts; nothing is concluded from them.
    entry.findings = [`${records.length} store record(s) retrieved live from the connected store.`];
    entry.evidence = records
      .map((record) => str(record.product_identity) || str(record.title) || str(record.name))
      .filter(Boolean)
      .slice(0, MAX_LIST_ENTRIES);
    entry.sources = [...new Set(records.flatMap((record) => textList(record.source)))].slice(0, MAX_LIST_ENTRIES);
  }

  // The real pending approval this step's tool is waiting on, if any - described by the same
  // function the view's own proposed_actions list uses, never re-derived.
  const match = asArray(pendingApprovals).find((request) => isPlainObject(request) && request.tool_id === inputs.tool_id);
  if (match) entry.proposed_action = describeProposedAction(match);

  if (entry.findings.length === 0 && entry.recommendations.length === 0 && entry.evidence.length === 0) {
    entry.no_findings_reason = 'This step completed and recorded no findings, evidence or recommendations. Nothing has been composed in their place.';
  }
  return entry;
}

// The owner-facing sentence for such a step: what it found, what it recommends, what that rests
// on, and what it could not establish - all of it the specialist's own words.
function specialistResultSummary(entry) {
  if (entry.no_findings_reason) {
    return `${entry.platform ? `[${entry.platform}] ` : ''}${entry.no_findings_reason}`;
  }
  const parts = [];
  if (entry.platform) parts.push(`[${entry.platform}]`);
  if (entry.findings.length > 0) parts.push(`Findings: ${entry.findings.join(' ')}`);
  if (entry.recommendations.length > 0) parts.push(`Recommended: ${entry.recommendations.join(' ')}`);
  if (entry.evidence.length > 0) parts.push(`Evidence: ${entry.evidence.join('; ')}.`);
  if (entry.sources.length > 0) parts.push(`Source: ${entry.sources.join('; ')}.`);
  if (entry.limitations.length > 0) parts.push(`Limitations: ${entry.limitations.join(' ')}`);
  if (entry.proposed_action) parts.push(`Proposed action: ${entry.proposed_action.what_changes} - needs your approval.`);
  else if (entry.requires_approval) parts.push('This step needs your approval before anything happens.');
  return parts.join(' ');
}

// One evidenced store opportunity as a single owner-readable line: the platform, the issue, the
// evidence it rests on, the action proposed, how confident that evidence makes it, and whether
// carrying it out needs the owner. Every part is relayed from the derivation.
function storeOpportunityLine(entry) {
  const approval = entry.requires_approval ? 'Needs your approval to carry out.' : 'No store change required.';
  return `[${entry.platform}] ${entry.issue} Evidence: ${entry.evidence.join(' ')} Proposed: ${entry.proposed_action} (confidence: ${entry.confidence}. ${approval})`;
}

// How much is at stake if this action runs, from its approval classification alone.
function riskFor(classification) {
  if (classification === 'externally_executable') return 'high';
  if (classification === 'approval_required') return 'medium';
  return 'low';
}

// One approval request, described for the owner: what will change, where, to what, and why.
function describeProposedAction(request) {
  if (!isPlainObject(request)) return null;
  const executionRequest = isPlainObject(request.execution_request) ? request.execution_request : {};
  const params = isPlainObject(executionRequest.research_params) ? executionRequest.research_params : {};
  const describe = ACTION_DESCRIPTIONS[request.tool_id];
  // A change PROPOSAL (agent/core/seoChangeProposal.js) is described from its own before/after
  // values, and says plainly that approving it writes nothing to the store.
  const proposal = params.proposal_kind === 'seo_metadata' ? params : null;
  const described = proposal
    ? {
        what_changes: 'SEO title / meta description (proposal only - approving it does not write to the store)',
        entity_type: 'product',
        entity_id: str(proposal.shopify_product_id) || str(proposal.product_reference),
        proposed_value:
          asArray(proposal.proposed_changes)
            .filter(isPlainObject)
            .map((change) => `${change.shopify_field}: "${change.before || ''}" → "${change.after}"`)
            .join('; ') || null,
      }
    : describe
      ? describe(params)
      : { what_changes: null, entity_type: null, entity_id: null, proposed_value: null };
  const compliance = isPlainObject(executionRequest.compliance) ? executionRequest.compliance : null;
  const autonomy = isPlainObject(executionRequest.autonomy) ? executionRequest.autonomy : null;

  return {
    approval_id: str(request.id),
    tool_id: str(request.tool_id),
    specialist_id: str(request.specialist_id),
    platform: platformForTool(request.tool_id) || (proposal ? str(proposal.platform) : null) || (autonomy ? str(autonomy.platform) : null),
    what_changes: described.what_changes || (str(request.tool_id) ? `Runs '${request.tool_id}'` : null),
    entity_type: described.entity_type,
    entity_id: described.entity_id,
    proposed_value: described.proposed_value,
    reason: str(request.reason),
    compliance_status: compliance ? str(compliance.compliance_status) : null,
    compliance_reasons: compliance ? asArray(compliance.review_reasons).filter((reason) => typeof reason === 'string').slice(0, 5) : [],
    classification: str(request.classification),
    risk: riskFor(request.classification),
    approval_status: str(request.status),
    requested_at: str(request.requested_at),
    decided_at: str(request.decided_at),
    decided_by: str(request.decided_by),
    origin: autonomy && autonomy.origin === 'autonomous_cycle' ? 'autonomous_cycle' : 'chief',
  };
}

// Whether a plan step was stopped by a compliance BLOCK - read from what the step itself
// recorded (the orchestrator's refusal text, or publish authorization's failed check).
function stepBlockedByCompliance(step) {
  if (!isPlainObject(step)) return false;
  if (asArray(step.errors).some((error) => typeof error === 'string' && /compliance returned block/i.test(error))) return true;
  const authorization = isPlainObject(step.outputs) && isPlainObject(step.outputs.authorization) ? step.outputs.authorization : null;
  return Boolean(authorization && authorization.failed_check === 'compliance_not_block');
}

function specialistTitle(step) {
  const selected = isPlainObject(step) ? step.selected_specialist : null;
  if (isPlainObject(selected)) return str(selected.title) || str(selected.id);
  return str(selected);
}

// A step's own plain-language summary: the one the route already attached, or the same
// server-side summariser every route uses - never a sentence composed here.
function stepSummary(step) {
  const attached = str(step.summary);
  if (attached) return attached;
  try {
    return str(summarizeExecutionState(step));
  } catch (err) {
    return str(asArray(step.errors).find((error) => typeof error === 'string'));
  }
}

// Plain-text recommendations a step's own output carries, when it carries any. Only strings
// (or objects naming one) are taken - nothing is composed here.
function recommendationsFrom(step) {
  const outputs = isPlainObject(step) && isPlainObject(step.outputs) ? step.outputs : null;
  if (!outputs) return [];
  const result = isPlainObject(outputs.result) ? outputs.result : {};
  const lists = [outputs.recommendations, result.recommendations, result.next_actions];
  const found = [];
  for (const list of lists) {
    for (const entry of asArray(list)) {
      const text = typeof entry === 'string'
        ? str(entry)
        : isPlainObject(entry) ? str(entry.recommendation) || str(entry.title) || str(entry.action) : null;
      if (text && !found.includes(text)) found.push(text);
    }
  }
  return found;
}

// The approved executions /orchestrate/approve recorded on this run, reduced to what the owner
// needs: which approval, the decision, whether it ran, and what verification found.
// `store_change` is true only for the tools that change real store data - the only executions
// that must carry an independent entity verification before they may read as done.
function readExecutions(result) {
  return asArray(result && result.approval_executions)
    .filter(isPlainObject)
    .map((entry) => ({
      approval_id: str(entry.approval_id),
      tool_id: str(entry.tool_id),
      decision: str(entry.decision),
      execution_status: str(entry.execution_status),
      entity_id: str(entry.entity_id),
      proposed_value: str(entry.proposed_value),
      verification_status: isPlainObject(entry.entity_verification) ? str(entry.entity_verification.status) : null,
      decided_at: str(entry.decided_at),
      store_change: typeof entry.tool_id === 'string' && isCorrectionTool(entry.tool_id),
    }));
}

function deriveChiefStatus({ clarification, blocked, steps, pending, executions, verificationStatus }) {
  if (clarification) return 'needs_clarification';
  if (blocked) return 'blocked_by_compliance';
  const executedStoreChanges = executions.filter((entry) => entry.store_change && entry.decision === 'approved' && entry.execution_status === 'success');
  // A store change that ran but was not independently confirmed is never a success.
  if (executedStoreChanges.some((entry) => entry.verification_status !== 'verified')) return 'verification_failed';
  if (pending.length > 0) return 'waiting_for_approval';
  if (executions.some((entry) => entry.decision === 'approved' && entry.execution_status !== 'success')) return 'failed';
  if (executions.length > 0 && executions.every((entry) => entry.decision === 'rejected')) return 'rejected';
  if (steps.length > 0 && steps.every((step) => step.completion_state === 'complete') && verificationStatus === 'passed') return 'success';
  if (steps.length === 0 || steps.every((step) => step.completion_state === 'failed' || step.completion_state === 'not_started')) return 'failed';
  return 'partial';
}

// The consolidated Chief result, for the owner. `result` is the Chief's routing response (or a
// saved record's `result`); nothing else is required.
function describeChiefResultForOwner({ result, runId = null, objective = null, createdAt = null, channel = null } = {}) {
  const safeResult = isPlainObject(result) ? result : {};
  const routing = isPlainObject(safeResult.routing) ? safeResult.routing : {};
  const plan = asArray(routing.plan).filter(isPlainObject);
  const clarification = routing.status === 'clarification_required';
  const pending = asArray(safeResult.pending_approvals).filter((request) => isPlainObject(request) && request.status === 'pending');
  const executions = readExecutions(safeResult);
  const blocked = plan.some(stepBlockedByCompliance);

  const status = deriveChiefStatus({
    clarification,
    blocked,
    steps: plan,
    pending,
    executions,
    verificationStatus: safeResult.verification_status,
  });

  const specialistsUsed = [];
  for (const step of plan) {
    const title = specialistTitle(step);
    if (title && !specialistsUsed.includes(title)) specialistsUsed.push(title);
  }

  const toolPlatforms = [];
  for (const step of plan) {
    const platform = platformForTool(isPlainObject(step.inputs) ? step.inputs.tool_id : null);
    if (platform && !toolPlatforms.includes(platform)) toolPlatforms.push(platform);
  }

  const recommendations = [];
  for (const step of plan) {
    for (const text of recommendationsFrom(step)) {
      if (!recommendations.includes(text)) recommendations.push(text);
    }
  }

  // A run that continued earlier research answers with the Chief's ranked store opportunities
  // (agent/core/storeOpportunityPrioritization.js). They replace the per-step recommendation
  // lists they were ranked from, in rank order, each stating its effort and first action.
  const priorities = isPlainObject(safeResult.store_opportunity_priorities) ? safeResult.store_opportunity_priorities : null;
  const rankedRecommendations = priorities
    ? asArray(priorities.opportunities)
        .filter(isPlainObject)
        .map((opportunity) => {
          const impact = isPlainObject(opportunity.estimated_impact) ? opportunity.estimated_impact : {};
          return `#${opportunity.rank} [${opportunity.effort === 'quick_win' ? 'Quick win' : 'Higher effort'}] ${opportunity.title}` +
            ` (${impact.affected_products} of ${impact.audited_products} audited products) - first action: ${opportunity.first_action}`;
        })
    : null;
  const continuity = isPlainObject(safeResult.research_continuity) ? safeResult.research_continuity : null;
  const continuitySource = continuity && isPlainObject(continuity.source) ? continuity.source : null;
  // A change proposal answers with one line per proposed product: its before/after values and the
  // approval each one is waiting on.
  const seoProposal = isPlainObject(safeResult.seo_change_proposal) ? safeResult.seo_change_proposal : null;
  const proposalRecommendations = seoProposal
    ? asArray(seoProposal.products)
        .filter(isPlainObject)
        .map((product) =>
          `#${product.rank} ${product.product_reference}: ` +
          asArray(product.proposed_changes).filter(isPlainObject).map((change) => `${change.shopify_field} "${change.before || ''}" → "${change.after}"`).join('; ') +
          (product.approval_id
            ? ` - approval ${product.approval_id} pending`
            : ` - not sent for approval (compliance ${product.compliance ? product.compliance.compliance_status : 'not checked'})`)
        )
    : null;

  const executed = executions.filter((entry) => entry.decision === 'approved' && entry.execution_status === 'success');
  const executedStoreChanges = executed.filter((entry) => entry.store_change);
  const lastExecution = executions.length > 0 ? executions[executions.length - 1] : null;

  let executionState;
  if (executed.length > 0) executionState = 'executed';
  else if (pending.length > 0) executionState = 'waiting_for_approval';
  else if (lastExecution) executionState = 'not_executed';
  else if (plan.length > 0 && plan.every((step) => step.completion_state === 'complete')) executionState = 'completed';
  else executionState = 'not_completed';

  let verificationState;
  if (executedStoreChanges.length > 0) {
    const unconfirmed = executedStoreChanges.find((entry) => entry.verification_status !== 'verified');
    verificationState = unconfirmed ? unconfirmed.verification_status || 'not_verified' : 'verified';
  } else if (safeResult.verification_status === 'passed') {
    verificationState = 'passed';
  } else if (safeResult.verification_status === 'failed') {
    verificationState = 'failed';
  } else {
    verificationState = 'not_verified';
  }

  const complianceStatuses = [];
  for (const request of [...pending, ...asArray(safeResult.pending_approvals).filter((request) => isPlainObject(request) && request.status !== 'pending')]) {
    const described = describeProposedAction(request);
    if (described && described.compliance_status && !complianceStatuses.includes(described.compliance_status)) {
      complianceStatuses.push(described.compliance_status);
    }
  }
  if (blocked && !complianceStatuses.includes('BLOCK')) complianceStatuses.push('BLOCK');

  // Derived once from the plan this run already produced - no tool call, no second read.
  const storeOpportunities = deriveStoreDataOpportunities(plan);

  const proposedActions = pending.map(describeProposedAction).filter(Boolean);
  const risk = proposedActions.some((action) => action.risk === 'high') || executedStoreChanges.length > 0
    ? 'high'
    : proposedActions.some((action) => action.risk === 'medium') ? 'medium' : 'low';

  return {
    run_id: str(runId),
    objective: str(objective) || str(safeResult.objective),
    created_at: str(createdAt),
    status,
    status_text: STATUS_TEXT[status],
    specialists_used: specialistsUsed,
    // One platform reads as one platform, exactly as before. A run that genuinely read TWO
    // stores now says so instead of reporting nothing: before the Chief could plan a step per
    // platform this was unreachable, and a two-store run would have shown "Not stated".
    platform:
      str(channel) ||
      (toolPlatforms.length === 1 ? toolPlatforms[0] : toolPlatforms.length > 1 ? toolPlatforms.join(' + ') : null),
    // Every platform this run actually read, unjoined, for any caller that wants the list.
    platforms: toolPlatforms,
    findings: plan
      .map((step) => {
        // A completed platform read answers with the fields it actually returned and the
        // access mode it has, rather than the generic "completed this request successfully"
        // - which is all the owner used to get back from an Etsy shop inspection. A step
        // that did NOT complete keeps its own honest failure/blocked sentence.
        const connection = step.completion_state === 'complete' ? storeConnectionFrom(step) : null;
        const listings = listingOpportunitiesFrom(step);
        // The specialist's own envelope is used only where this file has no more specific
        // projection already (the two Etsy reads above), and only for a step that finished -
        // a failed step keeps its own honest error sentence.
        // A sentence the step composed ITSELF always wins - the SEO store audit writes its own
        // ("Audited 3 of 3 ..."), and a generic envelope relay would be strictly worse than the
        // specialist's own words. Same precedence resultSummary.js's outputsOwnSummary applies.
        const specialistResult = !listings && !connection && !ownSummaryOf(step) && step.completion_state === 'complete'
          ? specialistResultFrom(step, pending)
          : null;
        const summary = listings
          ? listingOpportunitiesSummary(listings)
          : connection
            ? storeConnectionSummary(connection)
            : specialistResult
              ? specialistResultSummary(specialistResult)
              : stepSummary(step);
        const reused = isPlainObject(step.reused_research) ? step.reused_research : null;
        return {
          specialist: specialistTitle(step),
          state: str(step.completion_state),
          summary: summary && reused ? `${summary} (Reused from research run ${reused.run_id}, produced ${reused.produced_at}.)` : summary,
        };
      })
      .filter((finding) => finding.summary)
      .slice(0, MAX_LIST_ENTRIES),
    // Each platform this run actually read, with the fields it returned and how much access
    // this system has to it. Empty for every run that read no such platform.
    store_connections: plan.map(storeConnectionFrom).filter(Boolean),
    // The ranked Etsy listing opportunities this run found, each with the real title, status and
    // evidence behind it, and the metrics Etsy does not expose named as unavailable. Empty for
    // every run that did not read Etsy listings.
    listing_opportunities: plan.map(listingOpportunitiesFrom).filter(Boolean),
    // What each specialist that finished actually found, kept separate per specialist and per
    // platform, relayed from the envelope it already composed. Empty for a run whose steps
    // recorded no structured result.
    specialist_results: plan
      .filter((step) => step.completion_state === 'complete')
      .map((step) => specialistResultFrom(step, pending))
      .filter(Boolean),
    // The specific, evidenced opportunities this run's own store reads support - per platform,
    // each with the real field state behind it, a proposed action, a confidence grounded in
    // that evidence, whether acting on it needs approval, and what could not be assessed.
    // Empty is a legitimate outcome: it means the records read supported none.
    store_opportunities: storeOpportunities.opportunities,
    // Limits a step declared about its OWN evidence (a capped read, for example), relayed
    // rather than reasoned past, so a count never reads as the whole truth.
    evidence_limits: storeOpportunities.evidence_limits,
    // "Record what worked and what did not for future cycles." A Chief run records no such
    // evidence: agent/core/experimentLearningStore.js holds validated and cautionary lessons,
    // but it is written by the optimization-cycle path, not by this one, and nothing on this
    // result carries an outcome record. Reported as absent rather than composed from the run's
    // own status, which would only restate whether the steps completed.
    cycle_learning: {
      recorded: false,
      detail:
        'No worked/did-not-work evidence is recorded for a Chief run. Outcome lessons are recorded only for executed experiments (agent/core/experimentLearningStore.js), and this run executed none.',
    },
    // Unchanged precedence: a change proposal's own lines, then the Chief's ranked store
    // opportunities, then whatever the specialists themselves recommended. Only when all three
    // are empty - which is what a growth cycle over plain store reads produces - do the
    // evidenced store-data opportunities fill it, so the owner sees them in the list the
    // dashboard already renders rather than nothing at all.
    recommendations: (
      proposalRecommendations ||
      rankedRecommendations ||
      (recommendations.length > 0 ? recommendations : storeOpportunities.opportunities.map(storeOpportunityLine))
    ).slice(0, MAX_LIST_ENTRIES),
    // Where a continued run's evidence came from - null for every other run.
    research_continuity: continuity
      ? {
          mode: str(continuity.mode),
          platform: str(continuity.platform),
          source_run_id: continuitySource ? str(continuitySource.run_id) : null,
          produced_at: continuitySource ? str(continuitySource.produced_at) : null,
          age_minutes: continuitySource && Number.isFinite(continuitySource.age_minutes) ? continuitySource.age_minutes : null,
          specialists: continuitySource ? asArray(continuitySource.specialists).filter((entry) => typeof entry === 'string') : [],
          real_store_data: continuitySource ? continuitySource.real_store_data === true : null,
          reason: str(continuity.reason),
        }
      : null,
    proposed_actions: proposedActions,
    risk,
    compliance: complianceStatuses,
    approval_state: pending.length > 0 ? 'pending' : lastExecution ? lastExecution.decision || 'decided' : 'not_needed',
    execution_state: executionState,
    verification_state: verificationState,
    // Only real store changes: the correction tools, approved and executed.
    mutations: executedStoreChanges.map((entry) => ({
      approval_id: entry.approval_id,
      tool_id: entry.tool_id,
      entity_id: entry.entity_id,
      proposed_value: entry.proposed_value,
      verification_status: entry.verification_status,
      decided_at: entry.decided_at,
    })),
    clarification: clarification ? str(routing.reason) : null,
  };
}

// A saved run record, reduced to one History row for the owner. Handles every run kind the
// run store holds; an unrecognised kind is described only by its own saved status.
function describeRunRecordForOwner(record) {
  if (!isPlainObject(record)) return null;
  const result = isPlainObject(record.result) ? record.result : {};

  if (record.kind === 'orchestrate') {
    const view = describeChiefResultForOwner({
      result,
      runId: record.run_id,
      objective: record.objective,
      createdAt: record.created_at,
      channel: record.channel,
    });
    return {
      status: view.status,
      status_text: view.status_text,
      agent: view.specialists_used.length > 0 ? `Chief → ${view.specialists_used.join(', ')}` : 'Chief',
      platform: view.platform,
      approval_state: view.approval_state,
      execution_state: view.execution_state,
      verification_state: view.verification_state,
      mutation_count: view.mutations.length,
    };
  }

  if (record.kind === 'autonomous_cycle') {
    const steps = asArray(result.steps).filter(isPlainObject);
    const executed = steps.filter((step) => step.outcome === 'executed');
    const status = record.status === 'success' ? 'success' : record.status === 'error' ? 'failed' : 'partial';
    return {
      status,
      status_text: STATUS_TEXT[status],
      agent: 'Autonomous cycle',
      platform: null,
      approval_state: steps.some((step) => step.outcome === 'approval_required') ? 'pending' : 'not_needed',
      execution_state: executed.length > 0 ? 'executed' : steps.some((step) => step.outcome === 'observed') ? 'observed' : 'not_completed',
      verification_state: executed.length > 0 && executed.every((step) => step.verification === 'verified')
        ? 'verified'
        : executed.length > 0 ? 'not_verified' : 'not_applicable',
      mutation_count: executed.length,
    };
  }

  const status = record.status === 'success'
    ? 'success'
    : record.status === 'error' || record.status === 'failed'
      ? 'failed'
      : record.status === 'needs_clarification' ? 'needs_clarification' : 'partial';
  const toolId = isPlainObject(result.inputs) ? result.inputs.tool_id : null;
  return {
    status,
    status_text: STATUS_TEXT[status],
    agent: str(record.specialist_name) || str(record.specialist_id) || str(record.kind) || 'Run',
    platform: str(record.channel) || platformForTool(toolId),
    approval_state: asArray(result.approvals).some((approval) => isPlainObject(approval) && approval.status === 'required') ? 'pending' : 'not_needed',
    execution_state: result.completion_state === 'complete' ? 'completed' : 'not_completed',
    verification_state: result.completion_state === 'complete' ? 'passed' : 'not_verified',
    mutation_count: 0,
  };
}

module.exports = {
  OWNER_STATUSES,
  STATUS_TEXT,
  riskFor,
  platformForTool,
  describeProposedAction,
  describeChiefResultForOwner,
  describeRunRecordForOwner,
};
