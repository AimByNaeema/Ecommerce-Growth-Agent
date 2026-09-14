'use strict';

// OBJECTIVE INTERPRETATION - what each part of an owner's objective ASKS FOR.
//
// ===================================================================================
// THE DEFECT THIS REPLACES
// ===================================================================================
// planRouting (orchestratorExecutionContract.js) splits an objective at sentences, commas
// and "and", then routes every fragment by word overlap with capability descriptions. That
// asked the wrong question of every fragment - "which capability do your NOUNS name?" - and
// never "what does this fragment ASK FOR?". Both failure directions came from that one gap:
//
//   - Ordinary read language dead-ended the whole objective whenever a fragment's words were
//     not in a description or a closed framing list: "Identify the most important actions
//     needed to increase sales", "tell me what is driving the drop in revenue", "summarise
//     the trends". Each earlier fix grew a word list; the next phrasing hit the next word.
//   - A consequential request was silently re-read as analysis because its NOUN routed:
//     "Delete my worst products", "Buy ads for my best products", "Hire a photographer for my
//     store" and "Analyse my eBay store's sales" all planned a read.
//
// ===================================================================================
// THE MODEL
// ===================================================================================
// Every clause is classified by its SPEECH ACT, read from sentence structure (its predicate,
// question form, subject, determiners and prepositions), before routing is consulted:
//
//   safety               "Do not make any changes", "Keep it read-only"      - a run constraint
//   inform               "Identify ...", "Why are they ...?", "Can you tell me ...", and the
//                        list items that continue one ("..., why it matters, and the fix")
//   goal                 "I want to increase my sales"                       - the purpose
//   scope                "For each opportunity", "Using real store data"     - context
//   produce              "Write new titles", "Plan a campaign"               - a draft output
//   change               "Fix the vendor", "Update the inventory"           - store mutation
//   unsupported_action   "Book a photoshoot", "Delete my products", "Spend $500 on ads"
//   unsupported_platform "Compare my prices with Amazon", "my eBay store"
//
// The verb classes below mirror the three operations this system's tools can perform
// (tools/toolRegistry.js TOOL_OPERATIONS): READ (find out and report), WRITE (produce a draft
// for review) and EXECUTE (the gated store corrections - mutationIntent.js's MUTATION_VERBS,
// reused, never copied). A read-type clause is understood without having to name a capability.
// A CONSEQUENTIAL operation no tool performs - moving money, publishing or sending, deleting or
// deactivating, engaging an outside party, applying a change outside the gated corrections - is
// refused with a reason instead of being re-read as analysis because its noun happened to route.
// Any other verb ("reformat my listing", "schedule a calendar entry") is routed exactly as
// before, by its nouns, so an unfamiliar verb never blocks a request and never bypasses a gate.
//
// orchestratorExecutionContract.js then decides at OBJECTIVE level: which clauses are the
// business TASK (they select specialists through the existing scorer), and which are framing,
// scope or constraints that attach to that task. A read-type clause no longer has to name a
// capability to be understood; it has to not introduce an unrelated subject.
//
// WHY THIS IS NOT ANOTHER VOCABULARY PATCH. Subject matter is never listed here. Whether a
// noun phrase belongs to the objective is judged against the system's OWN declared vocabulary
// (the specialist and capability registries and the tool registry, passed in by the caller)
// plus the objective's own words - so adding a capability automatically widens what the Chief
// understands. Platforms come from integrations/adapters/platformSupportRegistry.js. The only
// word classes defined here are closed GRAMMATICAL classes (determiners, prepositions,
// auxiliaries, pronouns) and the verb classes of the three tool operations. An unfamiliar
// ordinary word can no longer block a read request, because only a noun phrase made ENTIRELY
// of words unknown to both the system and the objective is treated as a new subject.
//
// Deterministic and free: no model call, no network. It grants nothing - routing, capability
// selection, the mutation-intent gate, permissions, approvals, compliance, verification,
// audit and budgets all run unchanged on whatever it lets through.

const { MUTATION_VERBS, hasExplicitMutationIntent } = require('./mutationIntent');
const { knownPlatformNames, isPlatformIntegrated } = require('../../integrations/adapters/platformSupportRegistry');

// Run-wide constraints. Stripped before a clause is classified; they only ever narrow a run.
const SAFETY_CONSTRAINT_REGEX =
  /\b(?:do\s+not|don['’]?t|never|without)\s+(?:make|making|change|changing|modify|modifying|edit|editing|update|updating|touch|touching|alter|altering|write|writing)(?:\s+(?:any|anything|a|the))?(?:\s+(?:changes?|anything|edits?|updates?|modifications?|writes?))?\b|\bno\s+changes?\b|\bread[\s-]?only\b/gi;

// --- Verb classes: the three tool operations -----------------------------------------

// READ: asking to be told something about the store or the market.
const READ_VERBS = new Set([
  'analyze', 'analyse', 'review', 'check', 'audit', 'inspect', 'examine', 'evaluate', 'assess',
  'investigate', 'diagnose', 'study', 'explore', 'scan', 'look', 'find', 'identify', 'detect',
  'spot', 'discover', 'determine', 'research', 'measure', 'track', 'monitor', 'estimate',
  'calculate', 'count', 'quantify', 'forecast', 'predict', 'interpret', 'understand', 'see',
  'view', 'retrieve', 'get', 'fetch', 'pull', 'go', 'focus', 'compare', 'rank', 'sort',
  'prioritise', 'prioritize', 'explain', 'describe', 'show', 'list', 'recommend', 'suggest',
  'advise', 'propose', 'summarise', 'summarize', 'outline', 'detail', 'highlight', 'include',
  'provide', 'present', 'clarify', 'justify', 'specify', 'note', 'flag', 'tell', 'give',
  'point', 'break', 'walk', 'mention', 'return', 'report', 'answer',
]);

// WRITE: producing a draft or plan for the owner to review (never publishing it).
const PRODUCE_VERBS = new Set([
  'write', 'rewrite', 'create', 'generate', 'draft', 'plan', 'prepare', 'build', 'design',
  'produce', 'develop', 'optimize', 'optimise', 'improve', 'segment', 'score', 'validate',
  'brainstorm', 'craft', 'compose', 'run', 'do', 'perform', 'conduct', 'make', 'come', 'put',
  'work',
]);

// Desired business outcomes - the PURPOSE of an objective, not an operation to perform.
const OUTCOME_VERBS = new Set([
  'increase', 'grow', 'boost', 'raise', 'lift', 'improve', 'reduce', 'lower', 'cut',
  'decrease', 'maximise', 'maximize', 'minimise', 'minimize', 'sell', 'earn', 'win', 'drive',
  'attract', 'convert', 'retain', 'recover', 'understand', 'know', 'learn', 'see', 'avoid',
  'prevent', 'stop', 'beat', 'outperform', 'scale', 'expand',
]);

// EXECUTE: the store corrections, gated downstream. Reused from mutationIntent.js.
const CHANGE_VERBS = new Set(MUTATION_VERBS);

// Applying a change the system did not produce through a gated correction. Named on its own because
// ONE object makes this operation performable: an existing proposal held in the approval system
// ("Apply the proposed SEO title ... from the pending approval"). agent/core/proposalExecution.js
// resolves that object against durable approval state; without it these verbs stay refused below.
const APPLY_CHANGE_VERBS = ['apply', 'implement', 'push', 'sync', 'enable', 'activate'];

// Operations with real-world consequences that NO tool in this system performs (there is no
// payment, publishing, outbound messaging, deletion or hiring tool - tools/toolRegistry.js).
// Grouped by consequence, not by phrasing: a request for one of them is refused with a reason.
const CONSEQUENTIAL_ACTION_VERBS = new Set([
  // money
  'buy', 'purchase', 'pay', 'spend', 'charge', 'refund', 'invest', 'fund', 'transfer', 'bid',
  // publication and outbound communication
  'publish', 'unpublish', 'post', 'repost', 'send', 'email', 'text', 'message', 'tweet', 'share',
  'announce', 'broadcast', 'upload', 'submit',
  // deletion and deactivation
  'delete', 'remove', 'erase', 'destroy', 'archive', 'cancel', 'disable', 'deactivate',
  'discontinue', 'terminate', 'unsubscribe',
  // outside parties and systems
  'hire', 'fire', 'book', 'commission', 'sign', 'subscribe', 'install', 'uninstall', 'deploy',
  'connect', 'integrate',
  // applying a change outside the gated corrections
  ...APPLY_CHANGE_VERBS,
]);

// --- Closed grammatical classes -------------------------------------------------------

const OPENERS = new Set([
  'and', 'also', 'then', 'please', 'finally', 'plus', 'so', 'next', 'lastly', 'now', 'first',
  'firstly', 'secondly', 'additionally', 'but', 'or', 'ok', 'okay',
]);
const DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'each', 'every', 'all', 'any', 'some',
  'my', 'our', 'your', 'their', 'its', 'his', 'her', 'both', 'no', 'which', 'whose',
]);
// Determiners that open a noun phrase whose subject must belong to the objective. The
// demonstratives (this/that/these/those) are absent on purpose: they always point at something
// already established ("why that matters", "these issues").
const NOUN_PHRASE_DETERMINERS = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'their', 'his', 'her', 'some']);
const PREPOSITIONS = new Set([
  'for', 'with', 'by', 'from', 'to', 'of', 'in', 'on', 'at', 'about', 'into', 'per', 'as',
  'across', 'within', 'without', 'over', 'under', 'between', 'through', 'during', 'after',
  'before', 'among', 'regarding', 'including', 'via', 'around', 'against', 'toward', 'towards',
  'than', 'like', 'based', 'using', 'since', 'until', 'beyond', 'versus', 'vs',
]);
// Prepositions that extend a noun phrase instead of ending it ("the drop in revenue").
const PHRASE_EXTENDING_PREPOSITIONS = new Set(['of', 'in']);
const WH_WORDS = new Set(['why', 'how', 'what', 'which', 'where', 'when', 'whether', 'who', 'whom', 'whose']);
const AUXILIARIES = new Set([
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'do', 'does', 'did', 'can', 'could',
  'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had', 's', 're',
  'll', 've', 'd', 'not', 't',
]);
const SUBJECT_PRONOUNS = new Set(['i', 'we', 'you', 'they', 'he', 'she']);
const DESIRE_VERBS = new Set([
  'want', 'wants', 'need', 'needs', 'like', 'hope', 'aim', 'wish', 'intend', 'plan', 'trying',
  'try', 'looking', 'expect', 'goal', 'objective', 'priority', 'aiming', 'hoping', 'planning',
]);
// Words that refer back to something the objective already established.
const REFERRING_WORDS = new Set([
  'it', 'its', 'they', 'them', 'their', 'this', 'that', 'these', 'those', 'each', 'every',
  'one', 'ones', 'anything', 'something', 'everything', 'nothing',
]);
const CONJUNCTIONS = new Set(['and', 'or', 'but', 'nor', 'so', 'yet', 'then', 'if', 'because', 'while', 'than']);

const FUNCTION_WORDS = new Set([
  ...DETERMINERS, ...PREPOSITIONS, ...WH_WORDS, ...AUXILIARIES, ...SUBJECT_PRONOUNS, ...REFERRING_WORDS,
  ...CONJUNCTIONS, 'me', 'us', 'him', 'myself', 'ourselves', 'there', 'here', 'more', 'most',
  'less', 'least', 'up', 'out', 'down', 'off', 'just', 'only', 'also', 'very', 'really', 'please',
  'own', 'same', 'other', 'others', 'such', 'too', 'much', 'many', 'few', 'lot', 'lots',
]);

// Parts and qualities of an answer - never a business subject in their own right.
const ANSWER_STRUCTURE_WORDS = new Set([
  'top', 'bottom', 'highest', 'lowest', 'high', 'low', 'biggest', 'smallest', 'largest',
  'best', 'worst', 'main', 'key', 'major', 'minor', 'critical', 'important', 'urgent',
  'exact', 'exactly', 'specific', 'concrete', 'detailed', 'brief', 'short', 'clear',
  'simple', 'full', 'complete', 'quick', 'first', 'next', 'last', 'ranked', 'priority',
  'level', 'issue', 'problem', 'finding', 'result', 'reason', 'cause', 'impact', 'effect',
  'improvement', 'recommendation', 'suggestion', 'step', 'action', 'option', 'alternative',
  'opportunity', 'example', 'detail', 'summary', 'explanation', 'overview', 'breakdown',
  'list', 'table', 'bullet', 'point', 'number', 'count', 'score', 'comparison', 'difference',
  'risk', 'benefit', 'way', 'order', 'item', 'entry',
]);

function tokens(text) {
  return String(text || '')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((raw) => ({ raw, lower: raw.toLowerCase() }));
}

// Singular form, for matching "issues" to "issue" and "priorities" to "priority" only.
function singularForm(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// Base-form candidates for a verb as typed: "hiring" -> hire, "running" -> run, "flags" -> flag.
function lemmaCandidates(word) {
  const candidates = [word];
  if (word.length > 5 && word.endsWith('ing')) {
    const base = word.slice(0, -3);
    candidates.push(base, `${base}e`);
    if (/(.)\1$/.test(base)) candidates.push(base.slice(0, -1));
  }
  if (word.length > 4 && word.endsWith('ies')) candidates.push(`${word.slice(0, -3)}y`);
  if (word.length > 4 && word.endsWith('es')) candidates.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) candidates.push(word.slice(0, -1));
  return candidates;
}

// Which tool operation a verb names, if any. Change is checked first so a mutation verb can
// never be read as anything milder.
function verbClass(word) {
  const candidates = lemmaCandidates(String(word || '').toLowerCase());
  if (candidates.some((candidate) => CHANGE_VERBS.has(candidate))) return 'change';
  if (candidates.some((candidate) => READ_VERBS.has(candidate))) return 'read';
  if (candidates.some((candidate) => PRODUCE_VERBS.has(candidate))) return 'produce';
  if (candidates.some((candidate) => OUTCOME_VERBS.has(candidate))) return 'outcome';
  return null;
}

function isConsequentialAction(word) {
  return lemmaCandidates(String(word || '').toLowerCase()).some((candidate) => CONSEQUENTIAL_ACTION_VERBS.has(candidate));
}

function isInstructionWord(word) {
  const lower = String(word || '').toLowerCase();
  const cls = verbClass(lower);
  return cls === 'read' || cls === 'produce' || FUNCTION_WORDS.has(lower) || ANSWER_STRUCTURE_WORDS.has(singularForm(lower)) || ANSWER_STRUCTURE_WORDS.has(lower);
}

function refersBack(text) {
  return tokens(text).some((token) => REFERRING_WORDS.has(token.lower));
}

function collectSafetyConstraints(text) {
  return (String(text || '').match(SAFETY_CONSTRAINT_REGEX) || []).map((constraint) => constraint.trim());
}

// A platform the system knows by name but has no integration for, mentioned in the clause.
// A name that is also part of the system's own capability vocabulary ("social" in Social &
// Advertising) names a capability subject, not a foreign platform, and is ignored.
function unsupportedPlatformIn(text, systemVocabulary) {
  const words = new Set(tokens(text).map((token) => token.lower));
  for (const platform of knownPlatformNames()) {
    if (isPlatformIntegrated(platform)) continue;
    if (systemVocabulary && systemVocabulary.has(platform)) continue;
    if (words.has(platform)) return platform;
  }
  return null;
}

// A platform this system is connected to ("shopify", "etsy"). Naming it says WHERE to look, not
// WHAT to look at, so on its own it never decides which specialist a clause belongs to.
function isConnectedPlatformName(word) {
  const lower = String(word || '').toLowerCase();
  return knownPlatformNames().includes(lower) && isPlatformIntegrated(lower);
}

// The act an embedded verb names after a desire ("I want to <verb>", "we need help <verb>ing").
function actForEmbeddedVerb(word) {
  if (isConsequentialAction(word)) return { act: 'unsupported_action', verb: word };
  switch (verbClass(word)) {
    case 'read': return { act: 'inform' };
    case 'produce': return { act: 'produce' };
    case 'outcome': return { act: 'goal' };
    case 'change': return { act: 'change', verb: word };
    default: return { act: 'goal' };
  }
}

// Classifies one clause. previousAct: the act of the clause before it in the SAME sentence,
// which a list item or a bare coordinated noun continues. knownWord(word): whether a word
// belongs to the system's vocabulary or the objective's own wording.
function interpretClause(clauseText, { previousAct = null, previousNegated = false, knownWord = () => false, systemVocabulary = null } = {}) {
  const safety = collectSafetyConstraints(clauseText);
  const remaining = String(clauseText || '').replace(SAFETY_CONSTRAINT_REGEX, ' ');
  const rawWords = tokens(remaining);
  // NEGATION CARRIES THROUGH A DISJUNCTIVE LIST. "Do not create, approve, or execute any write approval"
  // is split at its commas, but "approve" and "or execute any write approval" are still governed by the
  // "Do not" - they are more things NOT to do, never instructions of their own. A clause continuing a
  // negated clause in the same sentence inherits the negation when it is a bare list item or is joined
  // by "or"/"nor". "and" is not treated this way: "Don't change prices, and write new titles" asks for
  // the titles.
  if (previousNegated && rawWords.length > 0 && (['or', 'nor'].includes(rawWords[0].lower) || rawWords.length === 1)) {
    return { act: 'scope', negated: true, continuation: true, safety };
  }
  let words = rawWords;
  while (words.length > 0 && OPENERS.has(words[0].lower)) words = words.slice(1);

  const contentLeft = words.filter((token) => !FUNCTION_WORDS.has(token.lower));
  if (words.length === 0 || (safety.length > 0 && contentLeft.length <= 1)) {
    return { act: safety.length > 0 ? 'safety' : 'empty', safety };
  }

  const platform = unsupportedPlatformIn(remaining, systemVocabulary);
  if (platform) return { act: 'unsupported_platform', platform, safety };

  // Request wrappers: "can you ...", "could you please ...", "help me ...", "let me know ...".
  if (['can', 'could', 'would', 'will'].includes(words[0].lower) && words[1] && words[1].lower === 'you') {
    words = words.slice(2);
    while (words.length > 0 && OPENERS.has(words[0].lower)) words = words.slice(1);
    if (words.length === 0) return { act: 'inform', safety };
  }
  if (words[0].lower === 'help' && words[1] && words[1].lower === 'me' && words[2]) words = words.slice(2);
  if (words[0].lower === 'let' && words[1] && words[1].lower === 'me' && words[2] && words[2].lower === 'know') {
    return { act: 'inform', safety };
  }

  const first = words[0].lower;
  const questionForm = /\?\s*$/.test(String(clauseText).trim());

  // Negated instructions about the answer ("don't include drafts", "never mind the fees").
  if ((first === 'don' && words[1] && words[1].lower === 't') || first === 'never' || (first === 'do' && words[1] && words[1].lower === 'not')) {
    return { act: 'scope', negated: true, safety };
  }

  if (isConsequentialAction(first)) return { act: 'unsupported_action', verb: first, safety };
  const cls = verbClass(first);
  if (cls === 'change' || (first === 'set' && hasExplicitMutationIntent(remaining))) return { act: 'change', verb: first, safety };
  if (cls === 'read') return { act: 'inform', verb: first, safety };
  if (cls === 'produce') return { act: 'produce', verb: first, safety };

  if (WH_WORDS.has(first) || AUXILIARIES.has(first)) {
    // A continuing list item ("why it matters") or a question ("How are my sales doing?").
    return { act: previousAct && previousAct !== 'scope' ? previousAct : 'inform', inherited: Boolean(previousAct), safety };
  }

  // "I want to grow sales", "we need help hiring a photographer", "I'd like a summary".
  if (SUBJECT_PRONOUNS.has(first)) {
    const window = words.slice(1, 6).map((token) => token.lower);
    const desireAt = window.findIndex((word) => DESIRE_VERBS.has(word));
    if (desireAt !== -1) {
      const after = window.slice(desireAt + 1);
      const toAt = after.indexOf('to');
      if (after[0] === 'help' && after[1] && after[1] !== 'with') return { ...actForEmbeddedVerb(after[1]), safety };
      if (after[0] === 'help') return { act: 'goal', safety };
      if (toAt !== -1 && after[toAt + 1]) {
        const embedded = after[toAt + 1] === 'you' || after[toAt + 1] === 'me' ? after[toAt + 2] : after[toAt + 1];
        if (embedded) return { ...actForEmbeddedVerb(embedded), safety };
      }
      return { act: 'inform', safety };
    }
    const verb = words[1] ? words[1].lower : null;
    if (verb && verbClass(verb) === 'change') return { act: 'change', verb, safety };
    return { act: 'scope', statement: true, safety };
  }

  // A noun phrase opening a clause: the next item of a list in the same sentence, or context.
  if (DETERMINERS.has(first) || /^\d+$/.test(first)) {
    if (previousAct && previousAct !== 'scope') return { act: previousAct, inherited: true, safety };
    return { act: questionForm ? 'inform' : 'scope', safety };
  }

  // "For each opportunity", "Using real store data", "Based on the analysis".
  if (PREPOSITIONS.has(first) || (/(?:ing|ed)$/.test(first) && first.length > 4)) {
    return { act: 'scope', safety };
  }

  // A bare phrase with an unrecognised first word. Verb-object shape ("book a photoshoot",
  // "post my products") is an action this system does not perform. A plain noun phrase is a
  // coordinated list item of the previous clause ("Check products, inventory, orders") or
  // context. A lone word continues the list it belongs to.
  const second = words[1] ? words[1].lower : null;
  const verbObjectShape = second && (DETERMINERS.has(second) || SUBJECT_PRONOUNS.has(second) || ['me', 'us', 'it', 'them', 'him'].includes(second));
  if (!verbObjectShape && (words.length === 1 || knownWord(first) || previousAct)) {
    if (previousAct) return { act: previousAct === 'scope' ? 'scope' : previousAct, continuation: true, safety };
    return { act: questionForm ? 'inform' : 'scope', safety };
  }
  // An imperative whose verb is in no operation class and is not consequential ("reformat my
  // listing content", "schedule a calendar entry"): routed exactly as before, by its nouns.
  return { act: 'act', verb: first, safety };
}

// The first noun phrase that introduces a subject unrelated to the objective: opened by a
// determiner, not inside a prepositional phrase, referring to nothing already established,
// and made ENTIRELY of words neither the system nor the objective uses. "the flibbertigibbet
// dance" and "my tax obligations" qualify; "the actual issue", "the drop in revenue" and "the
// weakest titles" do not, because one of their words belongs. A bare continuation (no
// determiner) is checked as a phrase of its own unless it continues a prepositional phrase.
function unrelatedNounPhrase(clauseText, knownWord, { bareContinuation = false, includePrepositionalObjects = false } = {}) {
  const words = tokens(String(clauseText || '').replace(SAFETY_CONSTRAINT_REGEX, ' '));
  const isUnrelated = (phrase) => {
    const content = phrase.filter((word) => !FUNCTION_WORDS.has(word) && !/^\d+$/.test(word));
    if (content.length === 0) return false;
    return content.every((word) => !knownWord(word) && !isInstructionWord(word));
  };
  const collectPhrase = (start) => {
    const phrase = [];
    for (let j = start; j < words.length; j += 1) {
      const word = words[j].lower;
      if (PHRASE_EXTENDING_PREPOSITIONS.has(word)) continue;
      if (PREPOSITIONS.has(word) || CONJUNCTIONS.has(word) || WH_WORDS.has(word) || AUXILIARIES.has(word) || SUBJECT_PRONOUNS.has(word) || DETERMINERS.has(word)) break;
      if (REFERRING_WORDS.has(word)) return [];
      phrase.push(word);
    }
    return phrase;
  };

  if (bareContinuation) {
    let start = 0;
    while (start < words.length && OPENERS.has(words[start].lower)) start += 1;
    const phrase = collectPhrase(start);
    if (isUnrelated(phrase)) return phrase.join(' ');
  }
  for (let i = 0; i < words.length; i += 1) {
    if (!NOUN_PHRASE_DETERMINERS.has(words[i].lower)) continue;
    const before = i > 0 ? words[i - 1].lower : null;
    // A prepositional object qualifies the request ("for the holiday season") - except in a goal
    // statement, where it is the thing the owner needs help with ("help with the X").
    if (!includePrepositionalObjects && before && PREPOSITIONS.has(before) && !PHRASE_EXTENDING_PREPOSITIONS.has(before)) continue;
    const phrase = collectPhrase(i + 1);
    if (isUnrelated(phrase)) return `${words[i].raw} ${phrase.join(' ')}`;
  }
  return null;
}

// Whether a clause ends inside a prepositional phrase ("... by impact"), so a bare word that
// follows it ("and urgency") is that phrase's second object, not a subject of its own.
function endsInPrepositionalPhrase(clauseText) {
  const words = tokens(clauseText).map((token) => token.lower);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (PREPOSITIONS.has(words[i])) return true;
    if (DETERMINERS.has(words[i]) || verbClass(words[i]) || AUXILIARIES.has(words[i]) || SUBJECT_PRONOUNS.has(words[i])) return false;
  }
  return false;
}

// --- Reference to earlier work --------------------------------------------------------
//
// Whether an objective builds on work ALREADY DONE ("using the data you just analysed", "based on
// the previous analysis") rather than asking for new work. Read from grammar, never from subject
// matter:
//   1. the pronoun "you" followed - past only auxiliaries or adverbs - by the PAST form of a READ
//      or PRODUCE verb ("you just analysed", "you have checked", "what you found");
//   2. a noun naming an operation's OUTPUT attributed to "you" by a relative clause of
//      possession ("the Shopify research you already have", "the results you have on file");
//   3. an anterior or existence modifier (previous, earlier, prior, existing, ...) followed by a
//      noun naming such an output ("the previous analysis", "your existing research").
// A question ("what listings do you have?") is not a reference: "you" after an auxiliary is
// inverted question word order. An owner's possessive ("my existing listings") names the owner's
// own store data. Every word set below is a closed class: past-tense morphology of verbs already in
// the verb classes above, possession verbs, and temporal modifiers. "The last 30 days" or "my
// latest orders" refer to store data, not to earlier work, and do not match.

// Irregular past forms of verbs already in READ_VERBS/PRODUCE_VERBS - morphology only.
const IRREGULAR_PAST_FORMS = {
  found: 'find', did: 'do', done: 'do', ran: 'run', made: 'make', gave: 'give', got: 'get', gotten: 'get',
  saw: 'see', seen: 'see', wrote: 'write', written: 'write', built: 'build', told: 'tell', came: 'come',
  went: 'go', gone: 'go', broke: 'break', broken: 'break',
};
const ANTERIOR_MODIFIERS = new Set(['previous', 'earlier', 'prior', 'preceding', 'last', 'above', 'completed', 'existing']);
// Nouns that name an operation's output without being a verb themselves.
const OPERATION_OUTPUT_NOUNS = new Set(['result', 'outcome', 'output', 'finding']);
const POSSESSION_VERBS = new Set(['have', 'has', 'had', 've']);
const OWNER_POSSESSIVES = new Set(['my', 'our']);
const MAX_WORDS_BETWEEN = 2;

function isOperationBase(word) {
  return READ_VERBS.has(word) || PRODUCE_VERBS.has(word);
}

function isPastOperation(word) {
  if (IRREGULAR_PAST_FORMS[word]) return isOperationBase(IRREGULAR_PAST_FORMS[word]);
  if (word.length <= 4 || !word.endsWith('ed')) return false;
  const stem = word.slice(0, -2);
  const candidates = [stem, `${stem}e`];
  if (/(.)\1$/.test(stem)) candidates.push(stem.slice(0, -1));
  if (stem.endsWith('i')) candidates.push(`${stem.slice(0, -1)}y`);
  return candidates.some(isOperationBase);
}

function isOperationOutputNoun(word) {
  if (word.endsWith('ysis') || word.endsWith('yses')) {
    const base = word.slice(0, -4);
    return isOperationBase(`${base}yse`) || isOperationBase(`${base}yze`);
  }
  const singular = singularForm(word);
  if (OPERATION_OUTPUT_NOUNS.has(singular) || isOperationBase(singular)) return true;
  if (singular.length > 7 && singular.endsWith('ation')) return isOperationBase(singular.slice(0, -5));
  return false;
}

function isBridgeWord(word) {
  return AUXILIARIES.has(word) || FUNCTION_WORDS.has(word) || word.endsWith('ly') || word === 'already' || word === 'earlier';
}

function referencesPriorWork(text) {
  const words = tokens(text).map((token) => token.lower);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const lookahead = words.slice(index + 1, index + 2 + MAX_WORDS_BETWEEN);
    const before = words.slice(Math.max(0, index - 1 - MAX_WORDS_BETWEEN), index);
    if (word === 'you' && !(index > 0 && AUXILIARIES.has(words[index - 1]))) {
      const outputNamedBefore = before.some(isOperationOutputNoun);
      for (const next of lookahead) {
        if (isPastOperation(next) || (outputNamedBefore && POSSESSION_VERBS.has(next))) return true;
        if (!isBridgeWord(next)) break;
      }
    }
    if (
      ANTERIOR_MODIFIERS.has(word) &&
      !words.slice(Math.max(0, index - 2), index).some((previous) => OWNER_POSSESSIVES.has(previous)) &&
      lookahead.some(isOperationOutputNoun)
    ) {
      return true;
    }
  }
  return false;
}

module.exports = {
  SAFETY_CONSTRAINT_REGEX,
  READ_VERBS,
  PRODUCE_VERBS,
  APPLY_CHANGE_VERBS,
  lemmaCandidates,
  OUTCOME_VERBS,
  ANSWER_STRUCTURE_WORDS,
  FUNCTION_WORDS,
  tokens,
  singularForm,
  verbClass,
  isInstructionWord,
  refersBack,
  referencesPriorWork,
  collectSafetyConstraints,
  unsupportedPlatformIn,
  isConsequentialAction,
  isConnectedPlatformName,
  interpretClause,
  unrelatedNounPhrase,
  endsInPrepositionalPhrase,
};
