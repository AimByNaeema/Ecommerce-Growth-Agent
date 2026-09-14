'use strict';

// PROPOSAL EXECUTION - "Apply the proposed SEO title and meta description only to the 200 Wild Flowers
// Clipart product from the pending approval."
//
// THE FAILURE. objectiveInterpretation.js classifies a clause by its verb, and "apply" is an operation
// no tool performs on its own - so the whole request was refused as "asks for something no capability
// here can do", although the thing to apply already existed: a pending SEO proposal the Chief had put
// in front of the owner, with exact before/after values, held in durable approval state.
//
// WHAT WAS MISSING WAS THE OBJECT, NOT A VERB. "Apply" has no meaning without something to apply. When
// its object is an EXISTING PROPOSAL - the approval system's own record ("from the pending approval",
// "the proposal") or a value it proposed ("the proposed SEO title") - the request is to execute that
// record, and whether that is possible is a question about STATE, answered here from the approval store:
//   1. decideProposalExecution reads the request's structure: a clause led by an apply/change verb
//      (objectiveInterpretation.js's APPLY_CHANGE_VERBS and mutationIntent.js's MUTATION_VERBS, reused)
//      in a sentence that refers to a proposal record. Any other operation in the same message is not
//      silently dropped - it is reported back as a separate request.
//   2. resolveProposalExecution finds the ONE stored proposal it means: this business only, still
//      pending or approved, made for the store this process reads now, for the product the request
//      names (matched against the proposals' own product names), and the fields it names (matched
//      against the proposal's own field names). Nothing ambiguous is guessed: two matching products,
//      two different proposals for one product, a field the proposal does not contain, or a product
//      with no proposal is a question back to the owner - with the candidates - and no approval.
//   3. The resolved change is the proposal's own before/after values, never text from the request.
//      The Chief then creates an approval for shopify_product_seo_update through the ordinary gated
//      path; integrations/shopifyProductSeoUpdate.js re-verifies it against the stored proposal before
//      the approval is created and again before anything is written.
//
// Deterministic and free: no model call, no store read, no write. It grants nothing.

const approvalStore = require('../../approvals/approvalStore');
const runHistoryStore = require('./runHistoryStore');
const { MUTATION_VERBS } = require('./mutationIntent');
const { APPLY_CHANGE_VERBS, FUNCTION_WORDS, tokens, lemmaCandidates, singularForm } = require('./objectiveInterpretation');
const { currentStoreReference } = require('./researchContext');
const seoUpdate = require('../../integrations/shopifyProductSeoUpdate');

const APPLICATION_TOOL_ID = seoUpdate.TOOL_ID;
const APPLICATION_KIND = 'seo_metadata_application';

// Verbs that execute a change. Reused lists only.
const EXECUTION_VERBS = new Set([...APPLY_CHANGE_VERBS, ...MUTATION_VERBS]);
// The approval system's own record nouns, and the participles a proposed value is named by.
const PROPOSAL_RECORD_NOUNS = new Set(['proposal', 'approval']);
const PROPOSAL_PARTICIPLES = new Set(['proposed', 'suggested', 'recommended']);
// Confirming the change IS the execution path's own independent re-read, so a clause asking for it is
// answered by the execution rather than being a separate request.
const VERIFY_VERBS = new Set(['verify', 'confirm', 'reread', 'recheck']);
// Words that lead a request without being its verb ("please go ahead and apply ...").
const LEAD_FILLERS = new Set([
  'please', 'kindly', 'now', 'then', 'and', 'also', 'so', 'ok', 'okay', 'just', 'go', 'ahead', 'first', 'next',
  'finally', 'can', 'could', 'would', 'will', 'you', 'let', 's', 'lets', 'us',
]);
const PRODUCT_NOUNS = new Set(['product', 'listing', 'item']);
const NAME_DETERMINERS = new Set(['the', 'my', 'our', 'this', 'that']);
const MAX_NAME_WORDS = 12;
const MAX_LISTED_CANDIDATES = 10;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tenantOf(businessId) {
  return isNonEmptyString(businessId) ? businessId.trim() : null;
}

function lowerWords(text) {
  return tokens(text).map((token) => token.lower);
}

function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map(normalizeSpace)
    .filter(Boolean);
}

function leadVerb(clause) {
  return lowerWords(clause).find((word) => !LEAD_FILLERS.has(word)) || null;
}

function isExecutionVerb(word) {
  return Boolean(word) && lemmaCandidates(word).some((candidate) => EXECUTION_VERBS.has(candidate));
}

// How text refers to a record the approval system holds: 'record' when it names the record itself
// ("the pending approval", "your proposal"), 'value' when it only names a value as proposed ("the
// proposed SEO title"), or null.
function proposalReferenceKind(text) {
  const words = lowerWords(text);
  if (words.some((word) => PROPOSAL_RECORD_NOUNS.has(singularForm(word)))) return 'record';
  const namesValue = words.some(
    (word, index) => PROPOSAL_PARTICIPLES.has(word) && words.slice(index + 1, index + 4).some((next) => !FUNCTION_WORDS.has(next))
  );
  return namesValue ? 'value' : null;
}

function referencesExistingProposal(text) {
  return proposalReferenceKind(text) !== null;
}

// Does this objective ask to execute an existing proposal? Structure only - no state is read.
//
// Returns { applies: false } or { applies: true, execution_text, additional_requests,
// answered_by_execution }. additional_requests are clauses asking for a different operation; the
// caller must not act on the proposal while ignoring them.
function decideProposalExecution({ objective, routingResult } = {}) {
  const interpretation = asArray(routingResult && routingResult.interpretation).filter((entry) => isPlainObject(entry) && isNonEmptyString(entry.clause));
  if (interpretation.length === 0) return { applies: false };

  const sentences = sentencesOf(objective);
  const sentenceOf = (clause) => {
    const needle = normalizeSpace(clause).replace(/[.!?;]+$/, '');
    return sentences.find((sentence) => sentence.includes(needle)) || normalizeSpace(clause);
  };

  const executionSentences = new Set();
  const executionActs = new Set();
  let namesRecord = false;
  for (const entry of interpretation) {
    if (!isExecutionVerb(leadVerb(entry.clause))) continue;
    const sentence = sentenceOf(entry.clause);
    const kind = proposalReferenceKind(sentence);
    if (!kind) continue;
    if (kind === 'record') namesRecord = true;
    executionSentences.add(sentence);
    executionActs.add(entry.act);
  }
  if (executionSentences.size === 0) return { applies: false };

  // "Analyse my SEO issues and apply the recommended improvements": a value called "recommended" or
  // "proposed" refers to an EXISTING proposal only when this message produces none itself. When the
  // same message also asks for work (a routed task) and never names the approval record, the
  // recommendations are that work's output - not a stored proposal - and routing answers it as before.
  if (!namesRecord) {
    const isExecutionClause = (entry) =>
      executionSentences.has(sentenceOf(entry.clause)) && (isExecutionVerb(leadVerb(entry.clause)) || executionActs.has(entry.act));
    const asksForOtherWork = interpretation.some(
      (entry) => entry.disposition === 'task' && !isExecutionClause(entry) && !VERIFY_VERBS.has(leadVerb(entry.clause))
    );
    if (asksForOtherWork) return { applies: false };
  }

  const additional = [];
  const answeredByExecution = [];
  for (const entry of interpretation) {
    const inExecutionSentence = executionSentences.has(sentenceOf(entry.clause));
    const lead = leadVerb(entry.clause);
    if (inExecutionSentence && (isExecutionVerb(lead) || executionActs.has(entry.act))) continue;
    if (['constraint', 'framing'].includes(entry.disposition) || entry.act === 'safety' || entry.act === 'empty') continue;
    if (lead && VERIFY_VERBS.has(lemmaCandidates(lead).find((candidate) => VERIFY_VERBS.has(candidate)) || lead)) {
      answeredByExecution.push(entry.clause);
      continue;
    }
    additional.push(entry.clause);
  }

  return {
    applies: true,
    execution_text: [...executionSentences].join(' '),
    additional_requests: additional,
    answered_by_execution: answeredByExecution,
  };
}

// The store a stored proposal was made for: its own stamp, or the stamp of the research run it names.
function proposalStoreReference(params, tenant) {
  if (isNonEmptyString(params.store_reference)) return params.store_reference;
  if (!isNonEmptyString(params.source_run_id)) return null;
  try {
    const record = runHistoryStore.getRunRecordById(params.source_run_id);
    if (!record || (record.business_id || null) !== tenant) return null;
    const stamp = isPlainObject(record.research_context) ? record.research_context : null;
    return stamp && isNonEmptyString(stamp.store_reference) ? stamp.store_reference : null;
  } catch (err) {
    return null;
  }
}

// Every product name the request gives: quoted text, and the words between a determiner and a product
// noun ("the 200 Wild Flowers Clipart product"). Each is a list of content words.
function namedProducts(text) {
  const names = [];
  for (const match of String(text || '').matchAll(/["“]([^"”]{2,160})["”]/g)) {
    const words = lowerWords(match[1]).filter((word) => !FUNCTION_WORDS.has(word));
    if (words.length > 0) names.push(words);
  }
  const words = lowerWords(text);
  words.forEach((word, index) => {
    if (!PRODUCT_NOUNS.has(singularForm(word))) return;
    for (let start = index - 1; start >= Math.max(0, index - MAX_NAME_WORDS - 1); start -= 1) {
      if (!NAME_DETERMINERS.has(words[start])) continue;
      const name = words.slice(start + 1, index).filter((entry) => !FUNCTION_WORDS.has(entry));
      if (name.length > 0) names.push(name);
      return;
    }
  });
  return names;
}

// The SEO fields a request names, read against the proposal's own field names: "SEO title" and "meta
// title" name seo.title (meta_title), "meta description" names seo.description (meta_description).
// A product's own title or description ("the product title") is named too, so it can be refused.
function namedFields(text) {
  const words = lowerWords(text).map(singularForm);
  const fields = new Set();
  const productFields = new Set();
  for (const [shopifyField, definition] of Object.entries(seoUpdate.SEO_FIELDS)) {
    const segments = [...shopifyField.split('.'), ...definition.field.split('_')];
    const head = segments[segments.length - 1];
    const qualifiers = new Set(segments.filter((segment) => segment !== head));
    words.forEach((word, index) => {
      if (word !== head || index === 0) return;
      if (qualifiers.has(words[index - 1])) fields.add(shopifyField);
      else if (PRODUCT_NOUNS.has(words[index - 1])) productFields.add(`product ${head}`);
    });
  }
  return { fields, productFields };
}

function changeSignature(changes) {
  return JSON.stringify(asArray(changes).filter(isPlainObject).map((change) => [change.shopify_field, normalizeSpace(change.before), change.after]));
}

function describeCandidate(candidate) {
  return {
    approval_id: candidate.approval_id,
    approval_status: candidate.status,
    product_reference: candidate.product_reference,
    fields: asArray(candidate.changes).filter(isPlainObject).map((change) => change.shopify_field),
  };
}

function listNames(candidates) {
  const names = [];
  for (const candidate of candidates) {
    if (candidate.product_reference && !names.includes(candidate.product_reference)) names.push(candidate.product_reference);
  }
  return names.slice(0, MAX_LISTED_CANDIDATES).map((name) => `"${name}"`).join(', ');
}

// Resolves a proposal-execution request to ONE stored proposal and the exact changes to apply.
//
// Returns { status: 'resolved', source, applied_changes, not_applied, research_params, considered }
// or { status: 'not_resolved' | 'ambiguous', reason, candidates, considered }.
function resolveProposalExecution({
  objective,
  executionText = objective,
  businessId = null,
  storeReference = undefined,
  storeDir = undefined,
  now = new Date(),
} = {}) {
  const tenant = tenantOf(businessId);
  const currentStore = storeReference !== undefined ? storeReference : currentStoreReference({ businessId: tenant });
  const considered = { proposals: 0, not_applicable: 0, other_store: 0, store_unknown: 0 };
  const unresolved = (status, reason, candidates = []) => ({ status, reason, candidates: candidates.map(describeCandidate), considered });

  const candidates = [];
  for (const envelope of approvalStore.listStoredApprovals(storeDir ? { storeDir } : {})) {
    if ((envelope.business_id || null) !== tenant) continue;
    const request = envelope.approval_request;
    const params = isPlainObject(request.execution_request) && isPlainObject(request.execution_request.research_params)
      ? request.execution_request.research_params
      : {};
    if (request.tool_id !== seoUpdate.SOURCE_PROPOSAL_TOOL_ID || params.proposal_kind !== seoUpdate.SOURCE_PROPOSAL_KIND) continue;
    considered.proposals += 1;
    const expired = envelope.expires_at && new Date(envelope.expires_at).getTime() <= new Date(now).getTime();
    if (envelope.execution_state === 'cancelled' || !seoUpdate.APPLICABLE_SOURCE_STATUSES.includes(request.status) || expired) {
      considered.not_applicable += 1;
      continue;
    }
    const proposalStore = proposalStoreReference(params, tenant);
    if (!proposalStore || !currentStore) {
      considered.store_unknown += 1;
      continue;
    }
    if (proposalStore !== currentStore) {
      considered.other_store += 1;
      continue;
    }
    candidates.push({
      approval_id: request.id,
      status: request.status,
      stored_at: envelope.stored_at,
      product_reference: isNonEmptyString(params.product_reference) ? params.product_reference : null,
      product_id: isNonEmptyString(params.shopify_product_id) ? params.shopify_product_id : null,
      changes: asArray(params.proposed_changes).filter(isPlainObject),
      source_run_id: isNonEmptyString(params.source_run_id) ? params.source_run_id : null,
      store_reference: proposalStore,
    });
  }

  if (candidates.length === 0) {
    const why = [];
    if (considered.not_applicable > 0) why.push(`${considered.not_applicable} were rejected, cancelled or expired`);
    if (considered.other_store > 0) why.push(`${considered.other_store} were made for a different store`);
    if (considered.store_unknown > 0) why.push(`${considered.store_unknown} could not be matched to the connected store`);
    return unresolved(
      'not_resolved',
      considered.proposals === 0
        ? 'There is no SEO change proposal waiting in the approval system for this business, so there is nothing to apply. Ask the Chief to propose the SEO changes first. Nothing was changed.'
        : `None of the ${considered.proposals} stored SEO proposal(s) can be applied (${why.join('; ')}). Nothing was changed.`
    );
  }

  // Which product. An approval id named in the request is exact; otherwise the product name it gives.
  const byId = candidates.filter((candidate) => String(objective || '').includes(candidate.approval_id));
  const names = namedProducts(executionText);
  const nameMatches = (candidate) => {
    const title = new Set(lowerWords(candidate.product_reference));
    return names.some((name) => name.every((word) => title.has(word)));
  };
  let chosenGroup;
  if (byId.length === 1) {
    if (names.length > 0 && !nameMatches(byId[0])) {
      return unresolved('not_resolved', `Approval ${byId[0].approval_id} is for "${byId[0].product_reference}", which is not the product named in the request. Nothing was changed.`, byId);
    }
    chosenGroup = byId;
  } else {
    if (names.length === 0) {
      return unresolved(
        'not_resolved',
        `Which product should the proposed SEO change be applied to? Pending SEO proposals exist for: ${listNames(candidates)}. Nothing was changed.`,
        candidates
      );
    }
    const matched = candidates.filter(nameMatches);
    const products = [...new Set(matched.map((candidate) => candidate.product_id || candidate.product_reference))];
    if (products.length === 0) {
      return unresolved(
        'not_resolved',
        `No pending SEO proposal is for the product named in the request. Pending SEO proposals exist for: ${listNames(candidates)}. Nothing was changed.`,
        candidates
      );
    }
    if (products.length > 1) {
      return unresolved(
        'ambiguous',
        `The product named in the request matches more than one proposed product: ${listNames(matched)}. Name the product exactly. Nothing was changed.`,
        matched
      );
    }
    chosenGroup = matched;
  }

  // Which proposal for that product. Repeated proposals with identical values are one proposal (the
  // newest record is used); proposals with different values are the owner's to choose between.
  const signatures = [...new Set(chosenGroup.map((candidate) => changeSignature(candidate.changes)))];
  if (signatures.length > 1) {
    return unresolved(
      'ambiguous',
      `"${chosenGroup[0].product_reference}" has ${signatures.length} different pending SEO proposals (${chosenGroup.map((candidate) => candidate.approval_id).join(', ')}). Say which approval to apply. Nothing was changed.`,
      chosenGroup
    );
  }
  const source = chosenGroup.slice().sort((a, b) => String(b.stored_at).localeCompare(String(a.stored_at)))[0];
  if (!source.product_id) {
    return unresolved('not_resolved', `SEO proposal ${source.approval_id} does not identify a Shopify product, so it cannot be applied. Nothing was changed.`, [source]);
  }

  // Which fields.
  const { fields, productFields } = namedFields(executionText);
  if (productFields.size > 0) {
    return unresolved(
      'not_resolved',
      `SEO proposal ${source.approval_id} only covers the SEO title and meta description; it never changes the ${[...productFields].join(' or ')}. Nothing was changed.`,
      [source]
    );
  }
  const proposedFields = new Set(source.changes.map((change) => change.shopify_field));
  const missing = [...fields].filter((field) => !proposedFields.has(field));
  if (missing.length > 0) {
    return unresolved(
      'not_resolved',
      `SEO proposal ${source.approval_id} for "${source.product_reference}" does not propose a ${missing.map((field) => seoUpdate.SEO_FIELDS[field].label).join(' or ')} change, so it cannot be applied. Nothing was changed.`,
      [source]
    );
  }
  const wanted = fields.size > 0 ? fields : proposedFields;
  const appliedChanges = source.changes
    .filter((change) => wanted.has(change.shopify_field) && Object.prototype.hasOwnProperty.call(seoUpdate.SEO_FIELDS, change.shopify_field))
    .map((change) => ({ shopify_field: change.shopify_field, field: change.field, before: typeof change.before === 'string' ? change.before : '', after: change.after }));
  const checked = seoUpdate.validateAppliedChanges(appliedChanges);
  if (!checked.ok) {
    return unresolved('not_resolved', `SEO proposal ${source.approval_id} cannot be applied as stored: ${checked.reason} Nothing was changed.`, [source]);
  }

  return {
    status: 'resolved',
    source: describeCandidate(source),
    applied_changes: appliedChanges,
    not_applied: source.changes.filter((change) => !wanted.has(change.shopify_field)).map((change) => change.shopify_field),
    research_params: {
      platform: seoUpdate.PLATFORM,
      proposal_kind: APPLICATION_KIND,
      productId: source.product_id,
      productReference: source.product_reference,
      sourceApprovalId: source.approval_id,
      sourceRunId: source.source_run_id,
      storeReference: source.store_reference,
      appliedChanges,
    },
    considered,
  };
}

module.exports = {
  APPLICATION_TOOL_ID,
  APPLICATION_KIND,
  referencesExistingProposal,
  decideProposalExecution,
  resolveProposalExecution,
};
