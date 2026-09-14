'use strict';

// STORE OPPORTUNITY PRIORITISATION - the Chief's ranked answer to "what should I do first",
// built ONLY from research the Chief has already completed on a real store.
//
// WHERE IT SITS. Cross-specialist aggregation belongs to the Chief (CLAUDE.md section 2), the
// same way crossAgentContext.js's gatherGrowthOpportunityDrafts/gatherSalesGrowthPlanEvidence
// read a plan's completed steps. This module is a pure function over completed plan steps: it
// runs no tool, calls no model, reads no store and writes nothing.
//
// THE RESEARCH BASIS. STORE_RESEARCH_BASIS names the completed reads a store prioritisation
// stands on - the Product specialist's live product read, the SEO specialist's audit of those
// real listings, and the Analytics & Optimization specialist's live sales read. It is the same
// read-only work the Dashboard's store analysis already runs, declared once so the Chief can
// (a) recognise a prior run that covers it and (b) run exactly it when no such run exists.
//
// NOTHING IS INVENTED. Every opportunity is one recommendation the SEO/listing audit actually
// made, with the real number of products it applies to and the real product names. "Why it
// matters" is a fixed explanation per audit dimension, never a claim about this store. Impact
// is stated only as what the data supports - how many audited products are affected, and how
// many of those are published. No revenue impact is claimed, because the order read does not
// attribute sales to individual products; that is said, not estimated. Fewer than the maximum
// opportunities is reported as fewer - the list is never padded.

const BASIS_PLATFORM = 'shopify';

const STORE_RESEARCH_BASIS = [
  { specialistId: 'product', capabilityId: 'product_discovery', toolId: 'product_data_retrieval', covers: 'the store\'s products and listing fields' },
  { specialistId: 'seo', capabilityId: 'seo_quality_check', toolId: 'seo_quality_check', covers: 'SEO/listing quality of every product read' },
  { specialistId: 'analytics_optimization', capabilityId: 'sales', toolId: 'analytics_data_retrieval', covers: 'orders and revenue' },
];

// The owner view lists at most this many entries (agent/core/ownerRunView.js MAX_LIST_ENTRIES).
const MAX_OPPORTUNITIES = 10;

const METHODOLOGY =
  'One opportunity per distinct SEO/listing audit recommendation. Ranked by the number of audited ' +
  'products it applies to (descending); ties go to quick wins, then to the recommendation affecting ' +
  'more published products, then alphabetically. Impact is the affected share of the audited catalogue; ' +
  'no revenue impact is estimated unless sales are attributed to products.';

// Labels are seoQualityChecker.js's DIMENSION_LABELS; unlabeled recommendations come from its
// store-listing field checks (checkStoreListingFields).
const STORE_LISTING_LABEL = 'Store listing';

const EFFORT_BY_LABEL = {
  Metadata: 'quick_win',
  Title: 'quick_win',
  'Missing information': 'quick_win',
  [STORE_LISTING_LABEL]: 'quick_win',
  'Content quality': 'higher_effort',
  'Keyword targeting': 'higher_effort',
  'Search intent': 'higher_effort',
  'Product accuracy': 'higher_effort',
  'Over-optimization': 'higher_effort',
  'Internal linking opportunities': 'higher_effort',
};

const EFFORT_REASON = {
  quick_win: 'Edits an existing field on each affected product in Shopify admin - no new research or long-form writing.',
  higher_effort: 'Needs new or expanded content written for each affected product.',
};

const WHY_BY_LABEL = {
  Metadata:
    'When a product has no custom SEO title or description, Shopify falls back to the product title and the start of the description in search results, so the snippet shoppers see is not one you chose.',
  Title: 'The product title is the first thing shoppers and search engines read; one outside the checked length range can be cut off in search results.',
  'Content quality': 'A thin or missing description gives shoppers little to decide on and gives search engines little to index.',
  'Missing information': 'A listing missing this field gives shoppers and search engines less to go on.',
};

// Mirrors seoQualityChecker.js's STORE_LISTING_FIELD_CHECKS, one entry per field it checks.
const STORE_LISTING_WHY = [
  { pattern: /publish/i, field: 'status', why: 'Products that are not ACTIVE are not published to the storefront, so shoppers and search engines cannot see or buy them.' },
  { pattern: /product type/i, field: 'product_type', why: 'Products without a product type are uncategorised in the store and in search.' },
  { pattern: /tags/i, field: 'tags', why: 'Products without tags are harder to find and group in the store.' },
  { pattern: /vendor/i, field: 'vendor', why: 'The vendor field is empty on these products.' },
];

const FIELD_NAME_PATTERN = /\b(meta_title|meta_description|url_slug|alt_text|product_title|description)\b/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function findBasisStep(steps, basis) {
  return (
    asArray(steps).find(
      (step) =>
        isPlainObject(step) &&
        step.selected_specialist &&
        step.selected_specialist.id === basis.specialistId &&
        step.inputs &&
        step.inputs.capability_id === basis.capabilityId &&
        step.inputs.tool_id === basis.toolId
    ) || null
  );
}

function stepSucceeded(step) {
  return Boolean(step) && step.completion_state === 'complete' && isPlainObject(step.outputs) && step.outputs.status === 'success';
}

// Which basis entries a set of steps covers with a completed, successful result.
function describeBasisCoverage(steps) {
  return STORE_RESEARCH_BASIS.map((basis) => {
    const step = findBasisStep(steps, basis);
    return {
      specialist_id: basis.specialistId,
      capability_id: basis.capabilityId,
      tool_id: basis.toolId,
      covers: basis.covers,
      available: stepSucceeded(step),
    };
  });
}

function coversResearchBasis(steps) {
  return describeBasisCoverage(steps).every((entry) => entry.available);
}

function splitLabel(text) {
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(String(text));
  return match ? { label: match[1], text: match[2] } : { label: STORE_LISTING_LABEL, text: String(text) };
}

function fieldNamed(text) {
  const match = FIELD_NAME_PATTERN.exec(text);
  return match ? match[1].toLowerCase() : null;
}

function effortFor(label, text) {
  if (label === 'Missing information' && fieldNamed(text) === 'description') return 'higher_effort';
  return EFFORT_BY_LABEL[label] || 'higher_effort';
}

function whyFor(label, text) {
  if (label === STORE_LISTING_LABEL) {
    const entry = STORE_LISTING_WHY.find((candidate) => candidate.pattern.test(text));
    return entry ? entry.why : 'The store listing check flagged this field on these products.';
  }
  return WHY_BY_LABEL[label] || `The SEO audit's ${label} check flagged this on these products.`;
}

function metricsByLabel(metrics) {
  const byLabel = {};
  for (const metric of asArray(metrics)) {
    if (isPlainObject(metric) && typeof metric.label === 'string' && !(metric.label in byLabel)) byLabel[metric.label] = metric;
  }
  return byLabel;
}

// The store's sales context as read - relayed, never interpreted into an opportunity.
function describeSales(salesStep) {
  if (!stepSucceeded(salesStep)) return null;
  const result = isPlainObject(salesStep.outputs.result) ? salesStep.outputs.result : {};
  const snapshot = asArray(result.specialized_records).find((record) => isPlainObject(record) && isPlainObject(record.sales));
  if (!snapshot) return null;
  const calculated = metricsByLabel(snapshot.sales.calculated_metrics);
  const actualOrders = asArray(snapshot.sales.actual_metrics).filter((metric) => isPlainObject(metric) && metric.label === 'order');
  const valueOf = (metric) => (metric ? { value: metric.value, unit: metric.unit || null } : null);
  return {
    orders_read: calculated.orders_count ? calculated.orders_count.value : actualOrders.length,
    total_revenue: valueOf(calculated.total_revenue),
    average_order_value: valueOf(calculated.average_order_value),
    // Whether any order carries a per-product attribution. The live order read does not.
    attributed_to_products: actualOrders.some((order) => asArray(order.lineItems).length > 0),
  };
}

// Groups every recommendation the audit made across all products (not just its top-10 summary),
// with the real product names each applies to.
function gatherAuditRecommendations(checks) {
  const groups = new Map();
  for (const check of asArray(checks)) {
    if (!isPlainObject(check) || check.status === 'failed') continue;
    const product = typeof check.subject_reference === 'string' ? check.subject_reference : null;
    const own = new Set([
      ...asArray(check.result && check.result.recommendations),
      ...asArray(check.store_listing && check.store_listing.recommendations),
    ]);
    for (const full of own) {
      if (typeof full !== 'string' || !full.trim()) continue;
      const group = groups.get(full) || { full, ...splitLabel(full), products: [] };
      if (product && !group.products.includes(product)) group.products.push(product);
      groups.set(full, group);
    }
  }
  const all = [...groups.values()];
  // A "[Missing information] <field> is missing." entry restates another recommendation about the
  // same field ("[Metadata] Add a meta_description."). It is folded into that one, not listed twice.
  return all.filter((group) => {
    if (group.label !== 'Missing information') return true;
    const field = fieldNamed(group.text);
    return !field || !all.some((other) => other !== group && other.label !== 'Missing information' && fieldNamed(other.text) === field);
  });
}

function publishedLookup(productStep) {
  const status = new Map();
  const wrapper = isPlainObject(productStep && productStep.outputs) ? productStep.outputs : {};
  for (const source of asArray(wrapper.listing_sources)) {
    if (!isPlainObject(source) || typeof source.product_reference !== 'string') continue;
    const fields = isPlainObject(source.store_fields) ? source.store_fields : {};
    status.set(source.product_reference, typeof fields.status === 'string' ? fields.status : null);
  }
  return status;
}

function naturalList(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function prioritizeStoreOpportunities({ steps = [], limit = MAX_OPPORTUNITIES } = {}) {
  const coverage = describeBasisCoverage(steps);
  const productStep = findBasisStep(steps, STORE_RESEARCH_BASIS[0]);
  const seoStep = findBasisStep(steps, STORE_RESEARCH_BASIS[1]);
  const salesStep = findBasisStep(steps, STORE_RESEARCH_BASIS[2]);
  const sales = describeSales(salesStep);
  const limitations = [];

  const seoResult = stepSucceeded(seoStep) && isPlainObject(seoStep.outputs.result) ? seoStep.outputs.result : null;
  const audited = seoResult && Number.isInteger(seoResult.products_checked) ? seoResult.products_checked : 0;
  const status = publishedLookup(stepSucceeded(productStep) ? productStep : null);

  let candidates = [];
  if (seoResult && audited > 0) {
    candidates = gatherAuditRecommendations(seoResult.checks).map((group) => {
      const effort = effortFor(group.label, group.text);
      const published = group.products.filter((name) => status.get(name) === 'ACTIVE');
      return { group, effort, published };
    });
  } else {
    limitations.push('No completed SEO/listing audit is in the research, so no listing opportunity could be ranked.');
  }

  candidates.sort(
    (a, b) =>
      b.group.products.length - a.group.products.length ||
      (a.effort === b.effort ? 0 : a.effort === 'quick_win' ? -1 : 1) ||
      b.published.length - a.published.length ||
      a.group.full.localeCompare(b.group.full)
  );

  const opportunities = candidates.slice(0, Math.max(0, limit)).map(({ group, effort, published }, index) => {
    const affected = group.products.length;
    const startWith = (published.length > 0 ? published : group.products).slice(0, 3);
    const title = group.label === STORE_LISTING_LABEL ? group.text : `${group.label}: ${group.text}`;
    const evidence = [
      `SEO/listing audit of ${audited} real store product(s): "${group.full}" applies to ${affected}.`,
    ];
    if (status.size > 0) evidence.push(`Shopify product read: ${published.length} of the ${affected} affected product(s) are ACTIVE (published).`);
    return {
      rank: index + 1,
      title,
      issue: group.text,
      dimension: group.label,
      effort,
      effort_reason: EFFORT_REASON[effort],
      evidence,
      why_it_matters: whyFor(group.label, group.text),
      estimated_impact: {
        affected_products: affected,
        audited_products: audited,
        share_of_audited_catalogue_percent: audited > 0 ? Math.round((affected / audited) * 100) : null,
        published_affected_products: status.size > 0 ? published.length : null,
        revenue: null,
        revenue_note:
          sales && sales.attributed_to_products
            ? 'Orders carry product line items, but per-product revenue is not computed by this ranking.'
            : 'No revenue impact is estimated: the order read does not attribute sales to individual products.',
      },
      first_action: `${group.text} Start with ${naturalList(startWith)}${affected > startWith.length ? `, then the other ${affected - startWith.length}` : ''}.`,
      affected_products: group.products.slice(0, 10),
      requires_store_change: true,
    };
  });

  if (candidates.length < limit && seoResult) {
    limitations.push(`The research supports ${candidates.length} distinct opportunit${candidates.length === 1 ? 'y' : 'ies'}; the list is not padded to ${limit}.`);
  }
  for (const entry of asArray(seoResult && seoResult.not_assessed)) {
    if (isPlainObject(entry) && entry.label) limitations.push(`${entry.label} was not assessed: ${entry.reason}`);
  }
  if (sales) {
    limitations.push(
      `Sales context: ${sales.orders_read} order(s) were read${sales.total_revenue ? ` (${sales.total_revenue.value} ${sales.total_revenue.unit || ''} total)`.replace(' )', ')') : ''}; orders are not attributed to products, so no sales-based opportunity is ranked.`
    );
  } else {
    limitations.push('No completed sales read is in the research, so no sales context is available.');
  }

  return {
    platform: BASIS_PLATFORM,
    methodology: METHODOLOGY,
    limit,
    available: candidates.length,
    basis_coverage: coverage,
    audited_products: audited,
    sales,
    opportunities,
    quick_wins: opportunities.filter((entry) => entry.effort === 'quick_win').map((entry) => entry.rank),
    higher_effort: opportunities.filter((entry) => entry.effort === 'higher_effort').map((entry) => entry.rank),
    limitations,
  };
}

module.exports = {
  BASIS_PLATFORM,
  STORE_RESEARCH_BASIS,
  MAX_OPPORTUNITIES,
  METHODOLOGY,
  describeBasisCoverage,
  coversResearchBasis,
  prioritizeStoreOpportunities,
};
