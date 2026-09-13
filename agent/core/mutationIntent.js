'use strict';

// MUTATION-INTENT CLASSIFICATION - the deterministic gate in front of every tool that
// changes real store data.
//
// ===================================================================================
// WHY THIS EXISTS (a real production-validation defect, not a hypothetical)
// ===================================================================================
// Read-only production validation issued this plainly read-only request:
//
//   "Analyze my Shopify products for vendor and inventory"
//
// and the orchestrator selected shopify_vendor_correction - a MUTATION tool. The
// downstream gates held (classification -> approval_required, so nothing executed and
// no live data changed), but selection itself was wrong, and a wrong selection still
// produces a pending human approval to mutate data that nobody asked to mutate.
//
// ROOT CAUSE. Tool selection is word-overlap scoring over each tool's own id, title,
// description and category (identifyRequiredCapability, and buildPlanStep's candidate
// scoring). The three correction tools' descriptions are dense with exactly the NOUNS a
// read-only diagnostic request uses - "vendor", "inventory", "product", "Shopify",
// "mismatch", "correction". Word-overlap scoring has no concept of an ACTION versus its
// SUBJECT, so those shared nouns let the mutation tool outscore the read tool. Measured
// before this gate, "Check my Shopify products for vendor mismatches" scored
// shopify_vendor_correction 9 against product_data_retrieval 2.
//
// No re-weighting fixes that: the words carrying the read/write distinction ("analyze"
// versus "fix") appear in neither tool's description, so there is nothing for overlap
// scoring to find. The distinction has to be stated explicitly, which is what this
// module does.
//
// ===================================================================================
// THE RULE
// ===================================================================================
// A mutation tool may be SELECTED only when the request states an explicit, unambiguous
// action to change something. Everything else - read intent, no intent, or both at once
// - fails closed to non-mutating behaviour. Mentioning a mutable SUBJECT ("vendor",
// "inventory", "product", "mismatch", "issue", "error", "correction") is never, on its
// own, intent to mutate it.
//
// SHAPED LIKE hasCatalogueExpansionIntent (orchestratorExecutionContract.js), which
// solved the same class of problem the same way: deterministic regex over the request
// text, one definition consulted everywhere, no model call, no network. It decides only
// whether a mutation tool is ELIGIBLE for selection. It grants nothing: business
// authorization, platform enablement, permissions, compliance, approval, publish
// authorization, audit and execution verification all run exactly as before, unchanged,
// on anything this gate lets through.

// The three tools that change real store data are named by
// integrations/approvedCorrectionDispatch.js, which is already the single source of
// truth for "which tool is a mutation" (its CORRECTION_DISPATCH map is what actually
// dispatches them). Re-exported through here so routing has one import for the whole
// question, and so a fourth correction added there is automatically gated here too -
// there is deliberately no second hand-maintained list of mutation tools.
const { CORRECTION_TOOL_IDS, isCorrectionTool } = require('../../integrations/approvedCorrectionDispatch');

const REQUEST_INTENTS = ['mutation', 'read_only', 'ambiguous'];

// ---------------------------------------------------------------------------------
// Explicit mutation intent
// ---------------------------------------------------------------------------------
//
// Base and gerund forms only. Past tense is deliberately excluded: "products that were
// changed" and "the vendor was updated" describe an observed STATE, which is a read.
//
// Each verb must not be preceded by a determiner or copula, which is what separates the
// verb "correct the vendor" from the adjective "the correct vendor" / "is correct" -
// found by adversarial testing, because "Show me the correct vendor names" would
// otherwise register as mutation intent.
const MUTATION_VERBS = [
  'fix', 'fixing',
  'correct', 'correcting',
  'update', 'updating',
  'change', 'changing',
  'replace', 'replacing',
  'modify', 'modifying',
  'edit', 'editing',
  'repair', 'repairing',
];

// Words that turn a following verb into an adjective or a description of something that
// already happened, rather than an instruction to act.
const NON_ACTION_PREFIX = '(?:the|a|an|is|are|was|were|be|been|being|its|their|our|my|this|that|these|those|no|not)';

// "correct" is the one verb here that is also a common ADJECTIVE, so it is scored
// separately from the rest. The determiner guard alone is not enough: it catches "the
// correct vendor" but not the predicate form "Is the vendor correct on product X?",
// where "correct" follows a noun and would otherwise read as an instruction to correct
// it. Found by adversarial probing after the first version of this gate shipped.
const MUTATION_VERBS_EXCEPT_CORRECT = MUTATION_VERBS.filter((verb) => verb !== 'correct');

const MUTATION_VERB_PATTERN = new RegExp(
  `(?<!\\b${NON_ACTION_PREFIX}\\s)\\b(?:${MUTATION_VERBS_EXCEPT_CORRECT.join('|')})\\b`,
  'i'
);

const CORRECT_VERB_PATTERN = new RegExp(`(?<!\\b${NON_ACTION_PREFIX}\\s)\\bcorrect\\b`, 'i');

// A copula or perception verb earlier in the same sentence makes a later "correct" a
// predicate adjective - "is the vendor correct", "do the vendors look correct" - which
// is a question about state, not an instruction to change it.
const CORRECT_AS_ADJECTIVE_PATTERN =
  /\b(?:is|are|was|were|be|been|being|look|looks|looked|seem|seems|seemed|appear|appears|appeared)\b[^.?!]{0,40}\bcorrect\b/i;

// "set" is handled separately because it is far more dangerous than the others: "a set
// of designs", "the product set", "set of files" are all nouns. It counts as mutation
// intent only in its unmistakable imperative shape - "set the vendor to X", "set
// inventory to 0" - i.e. followed by an object and then "to".
const SET_MUTATION_PATTERN = /(?<!\b(?:a|the|this|that|product|design|file|data)\s)\bset\b(?!\s+of\b)[^.?!]{0,40}\bto\b/i;

// ---------------------------------------------------------------------------------
// Read / analysis intent
// ---------------------------------------------------------------------------------
//
// The vocabulary of asking about state rather than changing it. A request carrying any
// of these is asking to be told something.
const READ_INTENT_PATTERN = new RegExp(
  [
    '\\banaly[sz]e\\b', '\\banaly[sz]ing\\b', '\\banalysis\\b',
    '\\bcheck(?:ing|s)?\\b',
    '\\binspect(?:ing|s)?\\b',
    '\\bshow\\b', '\\bshowing\\b',
    '\\blist(?:ing|s)?\\b',
    '\\bview(?:ing|s)?\\b',
    '\\breport(?:ing|s)?\\b',
    '\\binvestigat(?:e|ing|es)\\b',
    '\\brevie?w(?:ing|s)?\\b',
    '\\bsummar(?:ise|ize|ising|izing|y)\\b',
    '\\baudit(?:ing|s)?\\b',
    '\\bcompar(?:e|ing|es)\\b',
    '\\bfind(?:ing|s)?\\b',
    '\\bidentify(?:ing)?\\b', '\\bidentifies\\b',
    '\\bdetect(?:ing|s)?\\b',
    '\\bretriev(?:e|ing|es)\\b',
    '\\bget\\b', '\\bfetch(?:ing|es)?\\b',
    '\\btell\\s+me\\b',
    '\\bwhat\\s+(?:are|is|was|were)\\b',
    '\\bhow\\s+many\\b',
    '\\bhow\\s+much\\b',
    '\\bwhich\\b',
    '\\bstatus\\b',
    '\\bare\\s+there\\b',
    '\\bdo\\s+(?:i|we)\\s+have\\b',
  ].join('|'),
  'i'
);

function hasExplicitMutationIntent(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (MUTATION_VERB_PATTERN.test(text)) return true;
  if (SET_MUTATION_PATTERN.test(text)) return true;
  // "correct" counts only where it is genuinely the verb - see the two patterns above.
  return CORRECT_VERB_PATTERN.test(text) && !CORRECT_AS_ADJECTIVE_PATTERN.test(text);
}

function hasReadIntent(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  return READ_INTENT_PATTERN.test(text);
}

// Classifies one request (a whole objective, or a single routed clause).
//
// BOTH SIGNALS PRESENT IS 'ambiguous', NOT 'mutation'. "Analyze the vendors and fix
// them" states two different jobs in one breath; treating that as a mutation request
// would let a request that opens with "analyze" reach a mutation tool, which is the
// exact defect this module exists to close. The architecture already splits compound
// requests into clauses and classifies each one separately (see planRouting), so a
// genuine "...and fix them" survives as its own unambiguous clause - it does not need
// the whole-objective reading to be generous, and making it generous would reopen the
// hole. Neither signal present is 'ambiguous' too: an objective that states no action
// at all has not asked for a mutation.
function classifyRequestIntent(text) {
  const mutation = hasExplicitMutationIntent(text);
  const read = hasReadIntent(text);
  if (mutation && !read) return 'mutation';
  if (read && !mutation) return 'read_only';
  return 'ambiguous';
}

// THE ONE QUESTION ROUTING ASKS. A mutation tool is eligible only for an unambiguous
// mutation request; read-only and ambiguous both fail closed.
function maySelectMutationTool(text) {
  return classifyRequestIntent(text) === 'mutation';
}

// Filters a candidate tool list for one request. Non-mutation tools are never touched,
// so a request's normal routing is completely unchanged - this can only ever REMOVE a
// correction tool from consideration, never add, reorder or substitute anything.
function filterToolCandidatesByIntent(toolIds, text) {
  if (!Array.isArray(toolIds)) return [];
  if (maySelectMutationTool(text)) return toolIds.slice();
  return toolIds.filter((id) => !isCorrectionTool(id));
}

// The refusal a mutation tool gets when it was selected without mutation intent. Stated
// as a reason a person can act on: it names what was asked for and what to say instead.
function mutationIntentRefusalReason(toolId, text) {
  const intent = classifyRequestIntent(text);
  return (
    `Tool '${toolId}' changes real store data, and this request does not state an ` +
    `explicit instruction to change anything (intent: ${intent}). Naming a vendor, ` +
    `inventory, a product or a mismatch describes what to look at, not something to ` +
    `alter. To change data, say so explicitly - for example "fix the vendor on ...", ` +
    `"update the inventory for ..." - which then still requires the existing human ` +
    `approval before anything is executed.`
  );
}

module.exports = {
  REQUEST_INTENTS,
  MUTATION_VERBS,
  CORRECTION_TOOL_IDS,
  isCorrectionTool,
  hasExplicitMutationIntent,
  hasReadIntent,
  classifyRequestIntent,
  maySelectMutationTool,
  filterToolCandidatesByIntent,
  mutationIntentRefusalReason,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - mutation-intent gate (deterministic, no model call):\n');
  console.log(`Gated mutation tools: ${CORRECTION_TOOL_IDS.join(', ')}\n`);

  const samples = [
    'Analyze my Shopify products for vendor and inventory',
    'Check my Shopify products for vendor mismatches',
    'Show me Shopify vendor and inventory issues',
    'Review my product vendors and inventory',
    'Report inventory/vendor issues',
    'Show me the correct vendor names',
    'Fix the vendor mismatch on these Shopify products',
    'Correct the vendor for product X',
    'Update the vendor on product X',
    'Set the vendor to Digital Studio By Naeema',
  ];
  for (const sample of samples) {
    const intent = classifyRequestIntent(sample);
    const allowed = maySelectMutationTool(sample);
    console.log(`  [${intent.padEnd(9)}] mutation tool selectable: ${allowed ? 'YES' : 'no '}   ${sample}`);
  }

  console.log('\nThis gate only decides ELIGIBILITY for selection. It grants nothing:');
  console.log('permissions, compliance, approval, publish authorization and audit are unchanged.');
}
