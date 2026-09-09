'use strict';

// Intellectual-property risk INDICATORS for Etsy listing content.
//
// WHY THIS EXISTS ALONGSIDE THE ENGINE'S OWN CHECK. compliance/complianceEngine.js's
// checkIpIndicators() already flags affiliation wording and any brand the CALLER declares
// in business_context.third_party_brands. That is sound, but it only ever finds names
// somebody already thought to declare. A shop selling invitation designs is exposed to
// exactly the opposite risk: a protected character or franchise nobody listed. This module
// adds the detection that closes that gap, and feeds it in through the engine's existing
// applyAdditionalFindings() extension point - complianceEngine.js is NOT modified.
//
// ===================================================================================
// THIS IS NOT A SAFE-LIST, AND THE MARKS LIST IS NOT THE POINT.
// ===================================================================================
// A curated list of famous brands, used alone, quietly asserts that everything NOT on it
// is safe - which is false, and is the single most dangerous shape this module could
// take. So detection here has TWO independent passes and the second is the important one:
//
//   PASS 1 - PROTECTED_MARK_INDICATORS. Well-known marks, matched literally. This list is
//            NON-EXHAUSTIVE and is labelled as such everywhere it is reported. Its only
//            job is to catch the obvious cases early with a clear reason.
//
//   PASS 2 - detectUnresolvedProperNouns(). Structural, list-free. It finds capitalized
//            name-shaped phrases that are NOT accounted for by this shop's own declared
//            vocabulary (its brands, its product/occasion words) and by an ordinary-
//            language exclusion set. An unrecognized name is reported as UNRESOLVED -
//            meaning "this checker cannot establish what this is", not "this is
//            infringing". That is what makes the absence of a name from pass 1 stop
//            implying safety.
//
// ===================================================================================
// EVERY FINDING IS REVIEW OR INFO. NEVER BLOCK. NEVER A REWRITE.
// ===================================================================================
// Whether a use of a name is infringing, nominative, descriptive, licensed, or simply a
// coincidence is a legal determination. This module makes none of them. Its findings are
// therefore review/info only, and it is applied through applyAdditionalFindings(), which
// REFUSES block severity outright - so the "unclear IP goes to a human" rule is enforced
// by the engine's own construction, not merely by this file's good intentions.
//
// It also, deliberately, offers NO remediation. There is no suggested replacement wording,
// no brand-stripping helper, no "safe" rewrite of a flagged title. Automatically rewriting
// around a detected mark would defeat the detection - it would remove the evidence a human
// needs while leaving the underlying design exactly as it was. The recommended action is
// always human review, and a mark that has been removed only to satisfy this checker is
// explicitly named as the wrong outcome.

const { createComplianceFinding } = require('./complianceModel');

// Pass 1. Well-known marks, character names and franchises that appear frequently in
// invitation/party designs. NON-EXHAUSTIVE BY CONSTRUCTION - see this file's header.
// Presence here means "obviously worth a human look"; absence means nothing at all.
const PROTECTED_MARK_INDICATORS = [
  // Entertainment studios, franchises and characters
  'disney', 'pixar', 'marvel', 'dc comics', 'star wars', 'harry potter', 'pokemon', 'pokémon',
  'hello kitty', 'sanrio', 'bluey', 'peppa pig', 'winnie the pooh', 'mickey mouse', 'minnie mouse',
  'frozen elsa', 'paw patrol', 'cocomelon', 'spider-man', 'spiderman', 'batman', 'superman',
  'barbie', 'lego', 'minecraft', 'roblox', 'sonic the hedgehog', 'super mario', 'nintendo',
  'my little pony', 'transformers', 'teenage mutant ninja turtles', 'sesame street', 'dr. seuss',
  'the very hungry caterpillar', 'moana', 'encanto', 'toy story', 'cars lightning mcqueen',
  'baby shark', 'gabby\'s dollhouse', 'blippi', 'thomas the tank engine', 'stitch lilo',
  // Consumer and sportswear brands
  'nike', 'adidas', 'gucci', 'louis vuitton', 'chanel', 'prada', 'burberry', 'starbucks',
  'coca-cola', 'coca cola', 'jordan brand', 'supreme',
  // Sports leagues and organizations
  'nfl', 'nba', 'fifa', 'uefa', 'premier league', 'olympics', 'olympic',
];

// Ordinary language that is capitalized for grammatical reasons rather than because it
// names anything. Excluded from pass 2 so the structural detector reports NAMES, not
// sentence starts and headings. Kept intentionally small: over-growing this list would
// slowly turn pass 2 back into a safe-list.
const COMMON_CAPITALIZED_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those', 'it', 'its',
  'you', 'your', 'yours', 'we', 'our', 'ours', 'i', 'my', 'mine', 'they', 'their', 'he', 'she',
  'is', 'are', 'was', 'were', 'be', 'been', 'will', 'would', 'can', 'could', 'may', 'might', 'must',
  'do', 'does', 'did', 'have', 'has', 'had', 'get', 'gets', 'got', 'make', 'makes', 'made',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'from', 'by', 'as', 'no', 'not', 'all', 'any', 'each',
  'please', 'note', 'thank', 'thanks', 'welcome', 'includes', 'included', 'instant', 'download',
  'digital', 'file', 'files', 'printable', 'print', 'edit', 'editable', 'template', 'invitation',
  'invitations', 'invite', 'invites', 'card', 'cards', 'party', 'birthday', 'wedding', 'baby',
  'shower', 'bridal', 'announcement', 'thank you', 'rsvp', 'details', 'size', 'sizes', 'color',
  'colors', 'colour', 'colours', 'text', 'name', 'date', 'time', 'venue', 'how', 'what', 'when',
  'where', 'why', 'who', 'after', 'before', 'once', 'also', 'just', 'only', 'more', 'most', 'new',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
  // Everyday listing-copy vocabulary. These are ordinary words that happen to be
  // capitalized in marketing prose ("Featuring...", "Perfect for..."), and leaving them
  // out makes them glue onto an adjacent real name - which then matches no declared
  // vocabulary entry, silently breaking the "declare it and it stops being reported"
  // escape hatch. Still deliberately a modest list: growing it without limit would turn
  // pass 2 back into the safe-list this module exists to avoid.
  'featuring', 'features', 'perfect', 'beautiful', 'custom', 'customize', 'customise',
  'personalized', 'personalise', 'personalised', 'matching', 'order', 'orders', 'buy',
  'use', 'using', 'add', 'added', 'send', 'receive', 'design', 'designs', 'designed',
  'simply', 'easily', 'available', 'ready', 'comes', 'come', 'works', 'work', 'choose',
  'select', 'enter', 'change', 'save', 'share', 'enjoy', 'love', 'great', 'best', 'high',
  'quality', 'free', 'set', 'sets', 'pack', 'bundle', 'theme', 'themed', 'style', 'styled',
  'modern', 'minimal', 'elegant', 'cute', 'fun', 'kids', 'girl', 'boy', 'anniversary',
]);

// A name-shaped phrase: one to four consecutive Capitalized words. Deliberately does not
// require multiple words - a single unrecognized capitalized name is exactly the case
// worth reporting.
const PROPER_NOUN_PATTERN = /\b[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3}\b/g;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalize(value) {
  return String(value).trim().toLowerCase();
}

// Truncates a quoted fragment so a finding's reason never carries a long passage of the
// content it is describing. Same intent as complianceEngine.js's own bound().
function bound(value, maxLength = 80) {
  const text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

// Case-insensitive literal search. Never compiles caller-supplied text as a regular
// expression, matching compliancePolicy.js's stated rule for caller-supplied policy data.
function findLiteral(content, term) {
  const index = normalize(content).indexOf(normalize(term));
  return index === -1 ? null : { start: index, end: index + String(term).length };
}

// The vocabulary this shop has legitimately declared as its own: its brand names, plus
// any product/occasion words the caller states it trades in. Anything here is NOT
// reported by pass 2 - not because it is safe in general, but because this business has
// accounted for it.
function buildKnownVocabulary(businessContext = {}) {
  const vocabulary = new Set();
  const sources = [
    businessContext.brand_names,
    businessContext.brandNames,
    businessContext.known_vocabulary,
    businessContext.knownVocabulary,
    businessContext.product_categories,
    businessContext.productCategories,
  ];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (!isNonEmptyString(entry)) continue;
      vocabulary.add(normalize(entry));
      // Individual words too, so a declared brand "Digital Studio" also accounts for
      // "Digital" and "Studio" appearing on their own.
      for (const word of normalize(entry).split(/\s+/)) if (word) vocabulary.add(word);
    }
  }
  return vocabulary;
}

// Pass 2, the structural detector. Returns the name-shaped phrases in `content` that this
// shop's declared vocabulary and ordinary language do not account for.
//
// Reports UNRESOLVED, not "infringing". A person's own name, a venue, a made-up character,
// and a protected franchise all look identical to this function - which is the honest
// position, and why the verdict it drives is REVIEW.
function detectUnresolvedProperNouns(content, knownVocabulary = new Set()) {
  if (!isNonEmptyString(content)) return [];

  const seen = new Set();
  const unresolved = [];

  // A word that is accounted for: ordinary capitalized language, or something this shop
  // has declared. Used both to trim a match and to discard one entirely.
  const isAccountedFor = (word) => COMMON_CAPITALIZED_WORDS.has(word) || knownVocabulary.has(word);

  for (const match of String(content).matchAll(PROPER_NOUN_PATTERN)) {
    const matched = match[0].trim();
    const words = matched.split(/\s+/);

    // TRIM THE EDGES FIRST. A sentence-initial ordinary word ("Featuring Thornfield
    // Manor", "Please Note Aveline Marchetti") is capitalized for grammar, not because it
    // names anything - but left attached it produces a phrase that no declared vocabulary
    // entry could ever match, which would quietly break the "declare it and it stops being
    // reported" escape hatch. Trimming accounted-for words from both ends leaves the
    // actual name, so the phrase reported is the phrase a human would declare.
    let start = 0;
    let end = words.length;
    while (start < end && isAccountedFor(normalize(words[start]))) start += 1;
    while (end > start && isAccountedFor(normalize(words[end - 1]))) end -= 1;
    if (start >= end) continue;

    const phrase = words.slice(start, end).join(' ');
    const normalized = normalize(phrase);
    if (seen.has(normalized)) continue;

    // Accounted for as a whole phrase by this shop's declared vocabulary.
    if (knownVocabulary.has(normalized)) continue;
    // A single letter or a bare number is not a name.
    if (normalized.length < 3) continue;

    const offsetInMatch = matched.indexOf(phrase);
    const absoluteStart = match.index + (offsetInMatch === -1 ? 0 : offsetInMatch);

    seen.add(normalized);
    unresolved.push({ phrase, start: absoluteStart, end: absoluteStart + phrase.length });
  }

  return unresolved;
}

// Pass 1, the known-marks detector.
function detectProtectedMarks(content) {
  if (!isNonEmptyString(content)) return [];
  const detected = [];
  for (const mark of PROTECTED_MARK_INDICATORS) {
    const range = findLiteral(content, mark);
    if (range) detected.push({ mark, ...range });
  }
  return detected;
}

// The module's entry point: both passes, expressed as compliance findings.
//
// Returns findings only - it decides nothing, changes nothing, and publishes nothing. The
// caller applies them via complianceEngine.applyAdditionalFindings(), which re-derives the
// verdict and refuses any block severity.
function detectEtsyIpRisk({ content, businessContext = {} } = {}) {
  if (!isNonEmptyString(content)) {
    throw new Error('detectEtsyIpRisk requires non-empty content to check.');
  }

  const findings = [];
  const knownVocabulary = buildKnownVocabulary(businessContext);

  for (const { mark, start, end } of detectProtectedMarks(content)) {
    findings.push(
      createComplianceFinding({
        checkType: 'ip_indicators',
        ruleId: 'etsy_protected_mark_indicator',
        severity: 'review',
        reason:
          `The content references '${bound(mark)}', which appears on this project's non-exhaustive list of ` +
          'well-known protected marks, characters and franchises. This is a DETECTION, not a finding of ' +
          'infringement: whether this shop holds a licence, or whether the use is nominative or descriptive, ' +
          'cannot be established from the text.',
        detectedRange: { start, end },
        recommendedAction:
          'A human must confirm this shop has the rights to use this name and design, or the listing must not ' +
          'proceed. Do NOT simply delete the name to clear this flag - removing the wording while keeping an ' +
          'infringing design hides the risk instead of resolving it.',
      })
    );
  }

  const unresolved = detectUnresolvedProperNouns(content, knownVocabulary);
  for (const { phrase, start, end } of unresolved) {
    findings.push(
      createComplianceFinding({
        checkType: 'ip_indicators',
        ruleId: 'etsy_unresolved_proper_noun',
        severity: 'review',
        reason:
          `The content contains the name-shaped phrase '${bound(phrase)}', which is not accounted for by this ` +
          "business's declared brands or product vocabulary, and which this checker cannot resolve. It may be a " +
          'personal name, a venue, an original character, or a protected mark - those are indistinguishable from ' +
          'the text alone. Absence from any known-marks list is NOT evidence that a name is unprotected.',
        detectedRange: { start, end },
        recommendedAction:
          'A human must identify what this name refers to and confirm the shop may use it. Alternatively, declare ' +
          "it in the business's known vocabulary if it is this shop's own, so it stops being reported.",
      })
    );
  }

  if (findings.length > 0) {
    findings.push(
      createComplianceFinding({
        checkType: 'ip_indicators',
        ruleId: 'etsy_ip_detection_is_not_clearance',
        severity: 'info',
        reason:
          `${findings.length} intellectual-property indicator(s) were detected by a non-exhaustive marks list and a ` +
          'structural name detector. Neither can establish ownership, licensing, or infringement, and finding ' +
          'nothing would not have meant the content is clear.',
        recommendedAction: 'Treat every indicator above as a question for a human, not as a verdict.',
      })
    );
  }

  return findings;
}

module.exports = {
  PROTECTED_MARK_INDICATORS,
  COMMON_CAPITALIZED_WORDS,
  buildKnownVocabulary,
  detectProtectedMarks,
  detectUnresolvedProperNouns,
  detectEtsyIpRisk,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Etsy IP risk indicators (detection only, never a verdict):\n');
  console.log(`Pass 1 - known marks: ${PROTECTED_MARK_INDICATORS.length} entries, NON-EXHAUSTIVE by design.`);
  console.log('Pass 2 - structural: any unresolved name-shaped phrase, so absence from pass 1 implies nothing.\n');

  const businessContext = { brand_names: ['Digital Studio By Naeema'], product_categories: ['Invitation'] };
  const sample =
    'Mickey Mouse Birthday Invitation by Digital Studio By Naeema, featuring Thornfield Manor and Aveline Marchetti.';

  console.log(`Sample content: "${sample}"\n`);
  const findings = detectEtsyIpRisk({ content: sample, businessContext });
  for (const finding of findings) {
    console.log(`  [${finding.severity}] ${finding.rule_id}`);
    console.log(`      ${finding.reason.slice(0, 150)}…`);
  }
  console.log(`\nSeverities produced: ${[...new Set(findings.map((f) => f.severity))].join(', ')}`);
  console.log("No finding may be 'block' - applyAdditionalFindings() refuses that severity outright.");
  console.log('No rewrite, replacement wording, or brand-stripping helper is exported:');
  console.log(`  ${Object.keys(module.exports).join(', ')}`);
}
