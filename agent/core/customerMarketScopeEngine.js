'use strict';

// Customer context -> related-market scope. The FIRST stage of the customer-related
// global market opportunity research pipeline (workflows/customerMarketOpportunityWorkflow.js).
//
// WHY THIS EXISTS. Product research that starts from "what is trending" returns ten
// products nobody asked about. This module makes the research start from the customer's
// OWN business instead: what they already sell, in which categories, to whom, on which
// channels. Everything downstream is scoped by what comes out of here, which is what
// turns "10 trending products" into "10 opportunities for THIS business".
//
// EVERY VALUE IS A REAL STRING THIS BUSINESS ALREADY USES. Nothing here invents a market,
// a segment, or an adjacency. `primary_market` and `related_markets` are the customer's
// own category vocabulary, counted; `buyer_intents` are tags/keywords that genuinely
// recur across their own catalogue; `geographies` come from configuration/business.yaml
// only when it states them. Adjacent markets the customer does NOT already sell in are
// deliberately NOT guessed here - discovering those is the job of the live research
// stage, where each one arrives with a citation. A locally-invented adjacency would be
// exactly the fabrication the rest of this project refuses.
//
// NEEDS_INFORMATION IS A REAL OUTCOME. With too little real context to identify a niche,
// this returns status 'needs_information' naming what is missing, rather than proceeding
// on a guessed market - see assessSufficiency below.
//
// PURE AND OFFLINE: no network call, no model call, no credential. It only reshapes data
// the caller already retrieved through the existing tools.

const { CHANNELS } = require('./channelModel');

// A catalogue this small cannot establish a niche - two products could be anything. The
// threshold is deliberately low (this is "is there a business here at all", not a
// statistical sample) and is reported in the result so a reader can see the bar.
const MIN_PRODUCTS_FOR_NICHE = 3;
// A term must recur before it counts as a buyer intent. A tag used once is a detail of
// one product; a tag used repeatedly is what this business is actually about.
const MIN_TERM_RECURRENCE = 2;
// Bounded so one enormous catalogue cannot produce an unusable scope (or an unbounded
// research prompt downstream).
const MAX_RELATED_MARKETS = 12;
const MAX_BUYER_INTENTS = 20;

// Words that carry no market meaning on their own. Kept deliberately short: this is a
// stop list for obvious filler, not an attempt to judge which of the customer's own
// words matter - over-filtering here would quietly narrow their market.
const NON_MEANINGFUL_TERMS = new Set([
  'and', 'the', 'for', 'with', 'from', 'this', 'that', 'you', 'your', 'our',
  'new', 'best', 'top', 'set', 'pack', 'file', 'files', 'digital', 'download',
  'downloads', 'instant', 'printable', 'design', 'designs', 'template', 'templates',
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTerm(value) {
  return String(value).toLowerCase().trim().replace(/\s+/g, ' ');
}

// Counts how often each real string appears, strongest first. The COUNT is the evidence:
// a caller can always see why a term was selected, and re-derive it from the same input.
function countTerms(values) {
  const counts = new Map();
  for (const value of values) {
    if (!nonEmptyString(value)) continue;
    const term = normalizeTerm(value);
    if (term.length < 3 || NON_MEANINGFUL_TERMS.has(term)) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

// One normalized view of a product/listing from ANY channel, so the scope logic below
// never has to know whether a record came from Shopify or Etsy. The channel stamp is
// preserved on each entry, never dropped and never merged - two channels' catalogues are
// counted together only as evidence about ONE business's own range, which is what a
// niche is, and each contributing record stays individually attributable.
function normalizeCatalogueEntry(entry, channel) {
  if (!entry || typeof entry !== 'object') return null;
  const title = entry.title || entry.product_identity || entry.name || null;
  if (!nonEmptyString(title)) return null;
  return {
    channel: entry.channel || channel || null,
    title: String(title).trim(),
    category: nonEmptyString(entry.category) ? entry.category.trim() : null,
    tags: asArray(entry.tags).filter(nonEmptyString).map((t) => String(t).trim()),
    product_type: nonEmptyString(entry.product_type) ? entry.product_type.trim() : null,
    price: entry.price !== undefined ? entry.price : null,
  };
}

// Splits a title into candidate terms. Multi-word phrases are kept alongside single
// words because "bridal shower" is a market and "bridal" alone is not.
function titleTerms(title) {
  const words = normalizeTerm(title)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !NON_MEANINGFUL_TERMS.has(w));
  const phrases = [];
  for (let i = 0; i < words.length - 1; i += 1) phrases.push(`${words[i]} ${words[i + 1]}`);
  return words.concat(phrases);
}

// Builds the customer context from data the caller ALREADY retrieved through the existing
// tools - configuration/business.yaml plus the real Shopify products and/or Etsy listings.
// Retrieves nothing itself.
function extractCustomerContext({ businessConfig = null, catalogue = [] } = {}) {
  const config = businessConfig && typeof businessConfig === 'object' ? businessConfig : {};
  const entries = asArray(catalogue)
    .map((entry) => normalizeCatalogueEntry(entry, entry && entry.channel))
    .filter(Boolean);

  const byChannel = {};
  for (const channel of CHANNELS) {
    const forChannel = entries.filter((e) => e.channel === channel);
    if (forChannel.length > 0) byChannel[channel] = forChannel.length;
  }

  return {
    business_name: nonEmptyString(config.business_name) ? config.business_name : null,
    business_model: nonEmptyString(config.business_model) ? config.business_model : null,
    product_model: nonEmptyString(config.product_model) ? config.product_model : null,
    platform: nonEmptyString(config.platform) ? config.platform : null,
    // Only channels a real record actually came from - never every channel the system
    // could theoretically read.
    channels: Object.keys(byChannel),
    products_by_channel: byChannel,
    product_count: entries.length,
    // The customer's OWN declared categories and segments, verbatim.
    declared_categories: asArray(config.product_categories).filter(nonEmptyString),
    declared_segments: asArray(config.customer_segments).filter(nonEmptyString),
    declared_markets: asArray(config.target_markets).filter(nonEmptyString),
    declared_countries: asArray(config.countries).filter(nonEmptyString),
    catalogue_entries: entries,
  };
}

// Is there enough real context to identify this customer's niche? Returns the reasons it
// is NOT sufficient, so the caller can report NEEDS_INFORMATION naming each gap rather
// than proceeding on a guess.
function assessSufficiency(customerContext) {
  const missing = [];
  if (customerContext.product_count < MIN_PRODUCTS_FOR_NICHE && customerContext.declared_categories.length === 0) {
    missing.push(
      `The business has ${customerContext.product_count} retrievable product(s) and no declared product categories. ` +
        `At least ${MIN_PRODUCTS_FOR_NICHE} products, or a product_categories list in configuration/business.yaml, ` +
        'is needed before a niche can be identified rather than assumed.'
    );
  }
  if (!customerContext.business_name && !customerContext.business_model) {
    missing.push('Neither business_name nor business_model is configured, so there is no statement of what this business is.');
  }
  return missing;
}

// The research scope. Every field is either the customer's own real vocabulary or is
// explicitly reported as unknown - see this file's header on why adjacency is NOT
// invented here.
function deriveMarketScope(customerContext) {
  const entries = asArray(customerContext.catalogue_entries);

  // Category signal: the customer's declared categories, plus any category their real
  // records carry. Declared categories count once each (they are a stated list, not a
  // frequency), record categories count per record (frequency IS the signal).
  const categoryCounts = countTerms(
    customerContext.declared_categories.concat(entries.map((e) => e.category).filter(Boolean))
  );

  // The dominant category is the primary market. When nothing recurs there is no
  // dominant category, and that is reported as unknown rather than guessed.
  const primary = categoryCounts.length > 0 ? categoryCounts[0] : null;

  // Buyer intent: terms that genuinely RECUR across the real catalogue's titles and tags.
  const intentCounts = countTerms(
    entries.flatMap((e) => titleTerms(e.title).concat(e.tags.map(normalizeTerm)))
  ).filter((t) => t.count >= MIN_TERM_RECURRENCE);

  return {
    primary_market: primary ? primary.term : null,
    primary_market_basis: primary
      ? `Most frequent category across this business's own declared categories and retrieved catalogue (${primary.count} occurrence(s)).`
      : 'No category recurs across this business\'s declared categories or retrieved catalogue, so no primary market could be identified.',
    // The customer's OTHER real categories. Adjacent markets they do not already sell in
    // are found by the live research stage WITH citations, never asserted here.
    related_markets: categoryCounts.slice(1, 1 + MAX_RELATED_MARKETS).map((c) => c.term),
    related_markets_basis:
      'The remaining categories this business already sells in. Genuinely adjacent markets it does NOT yet sell in are discovered by the live research stage, each with a source, and are never assumed here.',
    buyer_intents: intentCounts.slice(0, MAX_BUYER_INTENTS).map((t) => t.term),
    buyer_intents_basis: `Terms recurring at least ${MIN_TERM_RECURRENCE} times across the real catalogue's titles and tags.`,
    // Stated only when configuration states them. No silent default to "global".
    geographies: customerContext.declared_markets.concat(customerContext.declared_countries),
    geographies_basis:
      customerContext.declared_markets.length > 0 || customerContext.declared_countries.length > 0
        ? 'target_markets / countries as declared in configuration/business.yaml.'
        : 'Not declared in configuration/business.yaml - geography is unknown, not assumed to be global.',
    channels: customerContext.channels,
    // Nothing real establishes what to exclude, so nothing is invented. A caller may
    // supply exclusions deliberately (see applyExclusions).
    excluded_categories: [],
    excluded_categories_basis:
      'No category is excluded by default: this business\'s own data does not establish what it would refuse to sell. Exclusions can be supplied deliberately by the caller.',
  };
}

// Caller-supplied exclusions, applied explicitly. Kept separate from derivation so an
// exclusion is always a stated decision, never something the engine inferred.
function applyExclusions(marketScope, excludedCategories) {
  const excluded = asArray(excludedCategories).filter(nonEmptyString).map(normalizeTerm);
  if (excluded.length === 0) return marketScope;
  return {
    ...marketScope,
    related_markets: marketScope.related_markets.filter((m) => !excluded.includes(normalizeTerm(m))),
    excluded_categories: excluded,
    excluded_categories_basis: 'Supplied explicitly by the caller for this run.',
  };
}

// The one entry point the workflow uses: real customer data in, scope + sufficiency out.
function buildCustomerMarketScope({ businessConfig = null, catalogue = [], excludedCategories = [] } = {}) {
  const customerContext = extractCustomerContext({ businessConfig, catalogue });
  const missing = assessSufficiency(customerContext);
  if (missing.length > 0) {
    return {
      status: 'needs_information',
      customer_context: customerContext,
      market_scope: null,
      missing_information: missing,
    };
  }

  const marketScope = applyExclusions(deriveMarketScope(customerContext), excludedCategories);
  // A scope with no primary market cannot direct research at anything - reported as a
  // gap rather than researched against an empty niche.
  if (!marketScope.primary_market) {
    return {
      status: 'needs_information',
      customer_context: customerContext,
      market_scope: marketScope,
      missing_information: [marketScope.primary_market_basis],
    };
  }

  return { status: 'complete', customer_context: customerContext, market_scope: marketScope, missing_information: [] };
}

module.exports = {
  MIN_PRODUCTS_FOR_NICHE,
  MIN_TERM_RECURRENCE,
  MAX_RELATED_MARKETS,
  MAX_BUYER_INTENTS,
  normalizeCatalogueEntry,
  countTerms,
  titleTerms,
  extractCustomerContext,
  assessSufficiency,
  deriveMarketScope,
  applyExclusions,
  buildCustomerMarketScope,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - customer market scope engine:\n');
  const demo = buildCustomerMarketScope({
    businessConfig: {
      business_name: '(Example digital design shop)',
      business_model: 'B2C digital products',
      product_categories: ['SVG design files', 'PNG clipart', 'SVG design files'],
      target_markets: ['(Example declared market)'],
    },
    catalogue: [
      { channel: 'shopify', title: 'Halloween Ghost SVG Bundle', category: 'SVG design files', tags: ['halloween', 'svg'] },
      { channel: 'shopify', title: 'Halloween Pumpkin SVG Cut File', category: 'SVG design files', tags: ['halloween', 'svg'] },
      { channel: 'etsy', title: 'Christmas PNG Clipart Set', category: 'PNG clipart', tags: ['christmas'] },
    ],
  });
  console.log(`Status: ${demo.status}`);
  console.log(`Primary market : ${demo.market_scope.primary_market}`);
  console.log(`  basis        : ${demo.market_scope.primary_market_basis}`);
  console.log(`Related markets: ${JSON.stringify(demo.market_scope.related_markets)}`);
  console.log(`Buyer intents  : ${JSON.stringify(demo.market_scope.buyer_intents)}`);
  console.log(`Channels       : ${JSON.stringify(demo.market_scope.channels)}`);
  console.log(`Geographies    : ${JSON.stringify(demo.market_scope.geographies)}`);
  console.log('\nEvery value above is a real string the example business already uses - no market is invented.');

  const insufficient = buildCustomerMarketScope({ businessConfig: {}, catalogue: [] });
  console.log(`\nWith no business context -> status: ${insufficient.status}`);
  for (const gap of insufficient.missing_information) console.log(`  - ${gap}`);
}
