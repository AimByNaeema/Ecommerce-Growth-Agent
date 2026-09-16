'use strict';

// WHAT A RESEARCH REQUEST ASKS FOR - markets, live market research, and data sources this system does not have.
//
// WHY THIS EXISTS (found by the Global Research Audit):
//   - "Compare global market demand ... across the United States, United Kingdom, Canada and Australia" was
//     refused with 'No known capability matches "Canada"': a country in a list was read as an unknown subject.
//   - "What are the current rising trends ... fads versus lasting trends?" routed to a capability that only
//     structures trend data a caller already supplies, so it answered with nothing while live research existed.
//   - "Get Google Trends search volume ..." became an SEO task: a data source nobody connected was treated as
//     ordinary wording instead of being refused as unavailable.
//
// DETERMINISTIC AND CLOSED. Every list below is a closed vocabulary (country and region names, named external
// data services) or a phrase SHAPE requiring a combination of words. Nothing here grants a capability: live
// research still runs only through the existing tool, its providers, budgets and gates, and a data source that
// is not connected is refused - never pretended.

const MARKET_NAMES = [
  ['United States', ['united states', 'united states of america', 'usa', 'u.s.', 'u.s.a.', 'us market']],
  ['United Kingdom', ['united kingdom', 'uk', 'u.k.', 'great britain', 'britain', 'england']],
  ['Canada', ['canada']],
  ['Australia', ['australia']],
  ['New Zealand', ['new zealand']],
  ['Ireland', ['ireland']],
  ['Germany', ['germany']],
  ['France', ['france']],
  ['Spain', ['spain']],
  ['Italy', ['italy']],
  ['Netherlands', ['netherlands', 'holland']],
  ['Belgium', ['belgium']],
  ['Sweden', ['sweden']],
  ['Norway', ['norway']],
  ['Denmark', ['denmark']],
  ['Finland', ['finland']],
  ['Poland', ['poland']],
  ['Portugal', ['portugal']],
  ['Switzerland', ['switzerland']],
  ['Austria', ['austria']],
  ['Japan', ['japan']],
  ['South Korea', ['south korea', 'korea']],
  ['China', ['china']],
  ['India', ['india']],
  ['Pakistan', ['pakistan']],
  ['Bangladesh', ['bangladesh']],
  ['Singapore', ['singapore']],
  ['Malaysia', ['malaysia']],
  ['Indonesia', ['indonesia']],
  ['Philippines', ['philippines']],
  ['Vietnam', ['vietnam']],
  ['Thailand', ['thailand']],
  ['United Arab Emirates', ['united arab emirates', 'uae']],
  ['Saudi Arabia', ['saudi arabia']],
  ['Turkey', ['turkey', 'turkiye']],
  ['South Africa', ['south africa']],
  ['Nigeria', ['nigeria']],
  ['Egypt', ['egypt']],
  ['Brazil', ['brazil']],
  ['Mexico', ['mexico']],
  ['Argentina', ['argentina']],
  ['Chile', ['chile']],
  ['Colombia', ['colombia']],
  ['European Union', ['european union', 'eu']],
  ['Europe', ['europe']],
  ['North America', ['north america']],
  ['Latin America', ['latin america']],
  ['Asia', ['asia']],
  ['Middle East', ['middle east']],
  ['Africa', ['africa']],
  ['Oceania', ['oceania']],
  ['Worldwide', ['worldwide', 'global market', 'global markets', 'globally', 'international markets']],
];

// Named external data services and metrics this project has no integration for. A request that depends on
// one is refused with that name, rather than routed as if the words were an ordinary task.
const UNSUPPORTED_DATA_SOURCES = [
  ['Google Trends', /\bgoogle\s+trends?\b/i],
  ['search volume data', /\b(?:monthly\s+)?(?:search|keyword)\s+volumes?\b/i],
  ['SEMrush', /\bsemrush\b/i],
  ['Ahrefs', /\bahrefs\b/i],
  ['Similarweb', /\bsimilar\s?web\b/i],
  ['Jungle Scout', /\bjungle\s?scout\b/i],
  ['Helium 10', /\bhelium\s?10\b/i],
  ['Keepa', /\bkeepa\b/i],
  ['Best Sellers Rank data', /\bbest\s?sellers?\s+rank(?:s|ing)?\b|\bbsr\b/i],
  ['eRank', /\berank\b/i],
  ['Marmalead', /\bmarmalead\b/i],
  ['EverBee', /\beverbee\b/i],
  ['AliExpress supplier data', /\baliexpress\b/i],
  ['Alibaba supplier data', /\balibaba\b/i],
  ['CJ Dropshipping supplier data', /\bcj\s?dropshipping\b/i],
  ['Spocket supplier data', /\bspocket\b/i],
  // Checked after every named service, so a named one is reported by its own name. The store's recorded vendor
  // field is not supplier data and is not matched here.
  ['Supplier and sourcing data', /\bsuppliers?\b|\bsourcing\b|\bmoqs?\b|\bminimum\s+order\s+quantit(?:y|ies)\b|\bmanufacturers?\b|\bwholesalers?\b|\bwholesale\s+(?:price|cost)s?\b|\blead\s+times?\b/i],
];

// What the requester can do instead. Live web research is offered only where it genuinely covers the question: it
// researches markets, trends and competitors - it does not look up suppliers, supplier prices, MOQs or lead times,
// so offering it for those would promise data that will not come back.
function unsupportedDataSourceAlternative(name) {
  if (/supplier/i.test(String(name || ''))) {
    return 'Supplier and sourcing details (suppliers, supplier prices, MOQs, lead times) are not looked up by any connected source, live web research included. Unit costs recorded in your store can be used for margin questions.';
  }
  return 'You can ask for live web research on the same question instead, which uses cited sources where a research provider is available.';
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MARKET_PATTERNS = MARKET_NAMES.map(([name, aliases]) => [
  name,
  // Longest alias first, so "united states of america" is not read as "america" alone.
  new RegExp(`(?:^|[^a-z])(?:${[...aliases].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![a-z])`, 'i'),
]);

// Every word of every market name, so a clause made of market names reads as scope, never as an unknown subject.
const MARKET_WORDS = new Set(
  MARKET_NAMES.flatMap(([name, aliases]) => [name, ...aliases])
    .flatMap((text) => text.toLowerCase().split(/[^a-z]+/))
    .filter((word) => word.length > 1)
);

// The canonical market names a request mentions, in the order given.
function detectMarketNames(text) {
  const value = String(text || '');
  // Lower-case "us" is the pronoun and never a market. Upper-case "US" is the country abbreviation, as in a
  // list like "UK, US, Canada" - matched case-sensitively, so "tell us" stays a pronoun. "USA", "U.S." and
  // "US market" match in any case.
  const found = [];
  for (const [name, pattern] of MARKET_PATTERNS) {
    const match = pattern.exec(value);
    if (match) found.push({ name, at: match.index });
  }
  const upperUs = /(?<![A-Za-z.])US(?![A-Za-z.])/.exec(value);
  if (upperUs) {
    const existing = found.find((entry) => entry.name === 'United States');
    if (!existing) found.push({ name: 'United States', at: upperUs.index });
    else existing.at = Math.min(existing.at, upperUs.index);
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.name).filter((name, i, all) => all.indexOf(name) === i);
}

function isMarketWord(word) {
  return MARKET_WORDS.has(String(word || '').toLowerCase());
}

// A clause made only of market names and list joiners ("United Kingdom", "Canada and Australia.") - the tail
// of a list of markets the clause splitter separated from the clause it belongs to.
const LIST_JOINERS = new Set(['and', 'or', 'the', 'in', 'of', 'across', 'plus', 'also', 'both', 'including']);
function isMarketListFragment(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean).filter((word) => !LIST_JOINERS.has(word));
  if (words.length === 0) return false;
  return words.every((word) => MARKET_WORDS.has(word)) && detectMarketNames(text).length > 0;
}

// A prohibition names a data source without asking for it: "do not invent search volume, sales, or demand
// metrics" forbids fabricated figures, it does not request search-volume data. A mention counts as prohibited when
// a negation comes before it in the same sentence with no later request joined in ("but", "instead", "then").
const NEGATION_CUE = /\b(?:do\s+not|don['’]t|never|without|avoid|not|no)\b/gi;
const REQUEST_RESUMES = /\b(?:but|instead|then|also|however)\b/i;

function isProhibitedMention(value, matchIndex) {
  const sentenceStart = Math.max(...['.', '!', '?', ';', '\n'].map((mark) => value.lastIndexOf(mark, matchIndex - 1))) + 1;
  const before = value.slice(sentenceStart, matchIndex);
  let lastNegation = -1;
  for (const cue of before.matchAll(NEGATION_CUE)) lastNegation = cue.index + cue[0].length;
  if (lastNegation < 0) return false;
  return !REQUEST_RESUMES.test(before.slice(lastNegation));
}

// A named data source the request depends on that this system has no integration for, or null. A mention that is
// only prohibited never counts; any mention that is asked for does.
function unsupportedDataSourceIn(text) {
  const value = String(text || '');
  for (const [name, pattern] of UNSUPPORTED_DATA_SOURCES) {
    const everywhere = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of value.matchAll(everywhere)) {
      if (!isProhibitedMention(value, match.index)) return name;
    }
  }
  return null;
}

// LIVE MARKET RESEARCH INTENT: a request about market demand or trends out in the market - not about the
// store's own records, not about competitors (live competitor research answers those), and not about trend
// data the requester already holds (the Research specialist structures supplied evidence).
const MARKET_SIGNAL = /\b(?:trend(?:s|ing)?|rising|emerging|seasonal(?:ity)?|fads?|(?:market|global|consumer|buyer|customer|product)\s+demand|demand\s+(?:for|in|across)|in\s+demand)\b/i;
const OWN_RECORDS = /\b(?:my|our)\s+(?:\w+\s+){0,2}(?:orders?|sales|revenue|traffic|visitors|conversions?|inventory|customers?|analytics)\b|\b(?:orders?|sales|revenue|traffic|conversion\s+rate)\s+(?:from|over|in)\s+the\s+last\b/i;
const SUPPLIED_EVIDENCE = /\b(?:we|i)\s+(?:have\s+)?observed\b|\b(?:following|these|supplied|provided|given)\s+(?:trends?|signals?|topics?|data)\b/i;
const COMPETITOR_FOCUS = /\bcompetitors?\b|\brivals?\b/i;

function hasLiveMarketResearchIntent(text) {
  const value = String(text || '');
  if (!MARKET_SIGNAL.test(value)) return false;
  if (OWN_RECORDS.test(value) || SUPPLIED_EVIDENCE.test(value) || COMPETITOR_FOCUS.test(value)) return false;
  return true;
}

module.exports = {
  MARKET_NAMES,
  UNSUPPORTED_DATA_SOURCES,
  detectMarketNames,
  isMarketWord,
  isMarketListFragment,
  unsupportedDataSourceIn,
  unsupportedDataSourceAlternative,
  hasLiveMarketResearchIntent,
};
