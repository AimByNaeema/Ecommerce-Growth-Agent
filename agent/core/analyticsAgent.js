'use strict';

// The Analytics & Optimization Agent (CLAUDE.md section 2, specialist #7: "Store
// performance, growth metrics, and optimization recommendations"). Supports 10
// capabilities: sales, products, customers, conversion, traffic, marketing,
// advertising, inventory, growth opportunities, and insights.
//
// Deterministic only - no AI API call, no synthesis. This module itself still makes no
// external call and stays Shopify-agnostic (agent/core/ never depends on integrations/
// or tools/ - see tools/productDataRetrievalTool.js's header for this project's
// standing rule); the live, read-only connection to real store data lives in
// integrations/adapters/shopifyClient.js and tools/analyticsDataTool.js, which call
// into this module's capability functions with real data already reshaped into the
// same plain params a caller with hand-supplied evidence would use - so every
// capability here works identically whether its actualMetrics/calculatedMetrics/
// estimatedMetrics came from a live pull or from a human. This module's own job is to
// validate whatever it's given, compose it into the existing analytics schemas
// (agent/core/analyticsModel.js, agent/core/growthOpportunityModel.js - both reused
// as-is, aside from additive fields on analyticsModel.js, see its own header), and
// grade it honestly - never to synthesize or guess a metric, a trend, or an
// assessment. Same philosophy and structure as agent/core/researchAgent.js,
// agent/core/seoAgent.js, agent/core/listingAgent.js, agent/core/marketingAgent.js,
// and agent/core/socialAdvertisingAgent.js: retrieval (build + validate records),
// analysis (flatten findings/evidence/source, derive honest limitations), and
// recommendation (relay only what the caller supplied) stay distinct, composed by one
// thin composeResult(). Also follows workflows/analyticsInsightWorkflow.js's own
// statement taxonomy: every "data" capability below produces a DATA-stage
// observed_fact (actual_metrics) / calculated_result (calculated_metrics) / hypothesis
// (estimated_metrics) - see agent/core/analyticsModel.js's header for the full
// 4-way actual/calculated/estimated/recommended split; growth_opportunities produces
// an OPPORTUNITY-stage hypothesis (from growthOpportunityModel.js) - never presented
// as more certain than its stage allows.
//
// Capability -> schema mapping:
//   - sales, products, customers, conversion, traffic, marketing, advertising, and
//     inventory all compose one agent/core/analyticsModel.js snapshot record, each
//     capability populating only its own category's { summary, actual_metrics,
//     calculated_metrics, estimated_metrics, verification_status } sub-object (sales
//     -> sales, products -> product_performance, customers -> customer_behavior,
//     conversion -> conversion, traffic -> traffic, marketing ->
//     marketing_performance, advertising -> advertising_performance, inventory ->
//     inventory) - every other category on that same snapshot stays at its untouched
//     empty/unverified default, never invented for a capability that wasn't asked for.
//   - growth_opportunities composes agent/core/growthOpportunityModel.js records
//     directly (already scoped for exactly this: upselling, cross-selling, retention,
//     repeat purchases, customer re-engagement) - not a snapshot category, because
//     workflows/analyticsInsightWorkflow.js's own OPPORTUNITY stage is explicitly a
//     hypothesis derived from data, not a DATA-stage observed fact. Accepts an array of
//     entries, mirroring agent/core/marketingAgent.js's conversion_opportunities shape.
//   - insights is the analytics insight engine: it composes agent/core/insightModel.js
//     records (metric, current_state, comparison, possible_cause, opportunity,
//     recommendation, confidence, evidence) - its own dedicated schema, since a
//     per-metric insight needs fields none of the other capabilities carry. Given an
//     array of raw metric-comparison entries (currentValue, comparisonValue, ...),
//     agent/core/insightEngine.js mechanically computes each one's percent change and
//     decides whether it's significant enough to surface at all (a defined,
//     adjustable threshold, never a judgment call) - only significant entries are
//     composed into records and returned, exactly as requested ("for each significant
//     insight"). possible_cause, opportunity, and recommendation are always
//     caller-supplied hypotheses - this engine never invents an explanation. CAUSATION
//     HONESTY: a possible_cause stated with no evidence can never carry 'high'
//     confidence - see analyzeInsights() below and agent/core/insightModel.js's header
//     for the full guard (correlation is never asserted as causation without
//     evidence).
//
// actual_metrics/calculated_metrics/estimated_metrics are never mixed into one
// another, and recommendations never live on the category record at all - they stay
// only in the common result envelope's own `recommendations` field, the same
// separation agent/core/advertisingPerformanceModel.js's header already established.
//
// analyticsModel.js's category sub-shape (unlike marketingAnalysisModel.js/
// growthOpportunityModel.js) carries no evidence field of its own - so, exactly like
// agent/core/seoAgent.js's buildOnPageEvidence, supporting evidence is an optional,
// separately-supplied list composed via agent/core/researchAgent.js's
// retrieveResearchData('generic', ...) rather than reimplemented here.
//
// Confidence: caller-asserted only, defaulting to 'unassessed' - same convention as
// every other module in this project. A 'verified' claim asserted without evidence is
// downgraded back to 'unverified' (same honesty guard as every other agent's).

const {
  createEmptyAnalyticsSnapshot,
  validateAnalyticsSnapshotShape,
} = require('./analyticsModel');
const {
  createEmptyGrowthOpportunityRecord,
  validateGrowthOpportunityShape,
} = require('./growthOpportunityModel');
const {
  createEmptyInsightRecord,
  validateInsightShape,
} = require('./insightModel');
const { evaluateMetricSignificance } = require('./insightEngine');
const {
  ANALYTICS_CAPABILITIES,
  createEmptyAnalyticsAgentResult,
  validateAnalyticsAgentResultShape,
} = require('./analyticsAgentResultModel');
const { retrieveResearchData, deriveRecommendations } = require('./researchAgent');

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

function requireNonEmptyArray(value, fieldName, fnName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` array.`);
  }
}

function requireObjectEntry(entry, fieldName, fnName) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${fnName} requires each \`${fieldName}\` entry to be an object.`);
  }
}

// Never guesses content - only normalizes a missing/singular value into the array
// shape every model already expects.
function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------
// Retrieval - builds and validates specialized records from raw caller-supplied
// entries. This IS "data retrieval" in this deterministic-only architecture (see
// module header) - no live analytics provider is configured. Never invents an entry
// that wasn't supplied.
// ---------------------------------------------------------------------------------

// Builds one analyticsModel.js snapshot, populating only the requested categoryId -
// every other category is left at createEmptyAnalyticsSnapshot's own untouched
// empty/unverified default. actualMetrics/calculatedMetrics/estimatedMetrics are kept
// as 3 separate arrays end to end - never merged into one another (see module header).
function buildAnalyticsSnapshotRecord(entry, categoryId, fnName) {
  const record = createEmptyAnalyticsSnapshot(entry.reportingPeriod || '');
  record[categoryId].summary = entry.summary || '';
  record[categoryId].actual_metrics = normalizeArray(entry.actualMetrics);
  record[categoryId].calculated_metrics = normalizeArray(entry.calculatedMetrics);
  record[categoryId].estimated_metrics = normalizeArray(entry.estimatedMetrics);
  record[categoryId].verification_status = entry.verificationStatus || 'unverified';

  const validation = validateAnalyticsSnapshotShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid analytics snapshot record: ${validation.errors.join('; ')}`);
  }
  return record;
}

function buildGrowthOpportunityRecord(entry, fnName) {
  requireNonEmptyString(entry.productReference, 'productReference', fnName);
  const record = createEmptyGrowthOpportunityRecord(entry.opportunityType || 'unclassified', entry.productReference);
  record.related_products = normalizeArray(entry.relatedProducts);
  record.target_segment = entry.targetSegment || '';
  record.offer = entry.offer || '';
  record.recommendation = entry.recommendation || '';
  record.evidence = normalizeArray(entry.evidence);
  record.verification_status = entry.verificationStatus || 'unverified';

  const validation = validateGrowthOpportunityShape(record);
  if (!validation.valid) {
    throw new Error(`${fnName} produced an invalid growth opportunity record: ${validation.errors.join('; ')}`);
  }
  return record;
}

// Optional supporting evidence for the analyticsModel.js snapshot-based capabilities,
// reusing researchAgent.js's generic record builder directly (same pattern
// agent/core/seoAgent.js's buildOnPageEvidence already established) - see module
// header for why analyticsModel.js's category sub-shape has no evidence field of its
// own to draw from directly.
function buildAnalyticsEvidence(evidenceEntries, fnName) {
  const records = retrieveResearchData('generic', normalizeArray(evidenceEntries), fnName);
  const evidence = records.filter((record) => record.finding).map((record) => record.finding);
  const source = records.flatMap((record) => record.source);
  return { evidence, source };
}

// ---------------------------------------------------------------------------------
// Analysis - pure analysis of already-retrieved growth_opportunity records: flattens
// findings/evidence/source and builds the honest limitations list. The 7 snapshot-
// based capabilities don't need this - their findings/evidence come straight from the
// one category they populated (see composeAnalyticsSnapshotResult below).
// ---------------------------------------------------------------------------------

function extractGrowthOpportunityRecord(record) {
  return {
    findings: [record.recommendation, record.offer].filter(Boolean),
    evidence: [...record.evidence],
    source: [],
    label: record.product_reference || '(unspecified product)',
  };
}

function analyzeGrowthOpportunityRecords(records, limitationHeader) {
  const findings = [];
  const evidence = [];
  const source = [];
  const limitations = [limitationHeader];

  for (const record of records) {
    const extracted = extractGrowthOpportunityRecord(record);
    findings.push(...extracted.findings);
    evidence.push(...extracted.evidence);
    source.push(...extracted.source);
    if (extracted.evidence.length === 0 && extracted.source.length === 0) {
      limitations.push(`No evidence was supplied for ${extracted.label}.`);
    }
  }

  return { findings, evidence, source, limitations };
}

// ---------------------------------------------------------------------------------
// Composition - a thin assembler: applies the verified-without-evidence honesty guard,
// builds the common agent/core/analyticsAgentResultModel.js envelope, and validates
// it. The only place every capability's result gets combined into one common shape.
// ---------------------------------------------------------------------------------

function composeResult({
  capability,
  topic,
  market,
  findings,
  evidence,
  source,
  confidence,
  limitations,
  recommendations,
  verificationStatus,
  researchDate,
  specializedRecords,
}) {
  const finalLimitations = [...limitations];
  const anyEvidenceSupplied = evidence.length > 0 || source.length > 0;

  let finalVerificationStatus = verificationStatus || 'unverified';
  if (finalVerificationStatus === 'verified' && !anyEvidenceSupplied) {
    finalVerificationStatus = 'unverified';
    finalLimitations.push('Verification status was downgraded to unverified because no evidence or source was supplied.');
  }

  const result = createEmptyAnalyticsAgentResult(capability, topic);
  result.market = market || '';
  result.findings = findings;
  result.evidence = evidence;
  result.source = source;
  result.confidence = confidence || 'unassessed';
  result.limitations = finalLimitations;
  result.recommendations = deriveRecommendations(recommendations);
  result.verification_status = finalVerificationStatus;
  result.research_date = researchDate || todayIsoDate();
  result.specialized_records = specializedRecords;

  const validation = validateAnalyticsAgentResultShape(result);
  if (!validation.valid) {
    throw new Error(`Composed Analytics agent result failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

// Deliberately provider-agnostic wording: this module is Shopify-agnostic and cannot
// itself say whether actual_metrics came from a live Shopify pull
// (tools/analyticsDataTool.js) or hand-supplied evidence (tools/analyticsTool.js) - see
// module header. Asserting "no live provider is configured" here would be dishonest
// once a live pull exists, so this only states what is always true regardless of
// source.
const ANALYTICS_SNAPSHOT_LIMITATION_HEADER =
  'This result reflects only the actual/calculated/estimated data supplied to this call - agent/core/analyticsAgent.js itself never fetches data on its own; see tools/analyticsTool.js (caller-supplied evidence) or tools/analyticsDataTool.js (live, read-only Shopify data) for where this data came from.';
const GROWTH_OPPORTUNITY_LIMITATION_HEADER =
  'No live sales/customer data platform is configured; this result reflects only caller-supplied evidence.';

// Formats one metrics array with a provenance label so flattened findings text stays
// traceable to actual/calculated/estimated even after composeResult() combines
// everything into one findings array - mirrors
// agent/core/socialAdvertisingAgent.js's formatMetricEntries labeling precedent.
function formatMetricsWithLabel(metrics, label) {
  return metrics.map((metric) => {
    const rendered = typeof metric === 'string' ? metric : JSON.stringify(metric);
    return `${label}: ${rendered}`;
  });
}

// Shared by the 8 snapshot-based capabilities - all build one analyticsModel.js
// snapshot record, populate exactly one category, and compose honest findings/
// evidence/limitations the same way, differing only in which category id and label
// they use.
function composeAnalyticsSnapshotResult(capability, categoryId, params, topicFallback, fnName) {
  const record = buildAnalyticsSnapshotRecord(params, categoryId, fnName);
  const { evidence, source } = buildAnalyticsEvidence(params.evidence, fnName);
  const category = record[categoryId];
  const findings = [
    category.summary,
    ...formatMetricsWithLabel(category.actual_metrics, 'Actual'),
    ...formatMetricsWithLabel(category.calculated_metrics, 'Calculated'),
    ...formatMetricsWithLabel(category.estimated_metrics, 'Estimated'),
  ].filter(Boolean);
  const limitations = [ANALYTICS_SNAPSHOT_LIMITATION_HEADER];
  if (evidence.length === 0 && source.length === 0) {
    limitations.push(`No evidence was supplied for ${categoryId}.`);
  }
  if (category.estimated_metrics.length > 0) {
    limitations.push(`${categoryId} includes estimated_metrics - these are approximations built on a stated assumption, not observed or mechanically calculated facts.`);
  }

  return composeResult({
    capability,
    topic: params.topic || topicFallback,
    market: params.market || '',
    findings,
    evidence,
    source,
    confidence: params.confidence,
    limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: [record],
  });
}

// ---------------------------------------------------------------------------------
// One function per supported capability.
// ---------------------------------------------------------------------------------

function analyzeSales(params = {}) {
  return composeAnalyticsSnapshotResult(
    'sales',
    'sales',
    params,
    `Sales analytics: ${params.reportingPeriod || '(no reporting period set)'}`,
    'analyzeSales'
  );
}

function analyzeProducts(params = {}) {
  return composeAnalyticsSnapshotResult(
    'products',
    'product_performance',
    params,
    `Product performance analytics: ${params.reportingPeriod || '(no reporting period set)'}`,
    'analyzeProducts'
  );
}

function analyzeCustomers(params = {}) {
  return composeAnalyticsSnapshotResult(
    'customers',
    'customer_behavior',
    params,
    `Customer behavior analytics: ${params.reportingPeriod || '(no reporting period set)'}`,
    'analyzeCustomers'
  );
}

function analyzeConversion(params = {}) {
  return composeAnalyticsSnapshotResult(
    'conversion',
    'conversion',
    params,
    `Conversion analytics: ${params.reportingPeriod || '(no reporting period set)'}`,
    'analyzeConversion'
  );
}

function analyzeTraffic(params = {}) {
  return composeAnalyticsSnapshotResult(
    'traffic',
    'traffic',
    params,
    `Traffic analytics: ${params.reportingPeriod || '(no reporting period set)'}`,
    'analyzeTraffic'
  );
}

function analyzeMarketingAnalytics(params = {}) {
  return composeAnalyticsSnapshotResult(
    'marketing',
    'marketing_performance',
    params,
    `Marketing performance analytics: ${params.reportingPeriod || '(no reporting period set)'}`,
    'analyzeMarketingAnalytics'
  );
}

function analyzeAdvertisingAnalytics(params = {}) {
  return composeAnalyticsSnapshotResult(
    'advertising',
    'advertising_performance',
    params,
    `Advertising performance analytics: ${params.reportingPeriod || '(no reporting period set)'}`,
    'analyzeAdvertisingAnalytics'
  );
}

function analyzeInventory(params = {}) {
  return composeAnalyticsSnapshotResult(
    'inventory',
    'inventory',
    params,
    `Inventory analytics: ${params.reportingPeriod || '(no reporting period set)'}`,
    'analyzeInventory'
  );
}

// Accepts an array of entries across any growth-opportunity type (upselling,
// cross-selling, retention, repeat purchases, customer re-engagement) - mirrors
// agent/core/marketingAgent.js's conversion_opportunities multi-entry shape.
function analyzeGrowthOpportunities(params = {}) {
  const fnName = 'analyzeGrowthOpportunities';
  const { opportunities, topic, market = '' } = params;
  requireNonEmptyArray(opportunities, 'opportunities', fnName);

  const records = opportunities.map((entry) => {
    requireObjectEntry(entry, 'opportunities', fnName);
    return buildGrowthOpportunityRecord(entry, fnName);
  });

  const analysis = analyzeGrowthOpportunityRecords(records, GROWTH_OPPORTUNITY_LIMITATION_HEADER);
  const productList = records.map((record) => record.product_reference).join(', ');
  return composeResult({
    capability: 'growth_opportunities',
    topic: topic || `Growth opportunities: ${productList}`,
    market,
    findings: analysis.findings,
    evidence: analysis.evidence,
    source: analysis.source,
    confidence: params.confidence,
    limitations: analysis.limitations,
    recommendations: params.recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: todayIsoDate(),
    specializedRecords: records,
  });
}

const INSIGHT_ENGINE_LIMITATION_HEADER =
  'No live analytics provider is configured; each insight reflects only the caller-supplied metric values and hypotheses given to this call.';

// The analytics insight engine. Given an array of raw metric-comparison entries
// (metric, currentValue, comparisonValue, comparisonLabel, unit, plus the
// caller-supplied hypotheses possibleCause/opportunity/recommendation/confidence/
// evidence), delegates the actual significance detection and comparison arithmetic to
// agent/core/insightEngine.js's evaluateMetricSignificance() - a metric whose change
// doesn't clear the significance threshold is skipped entirely, never composed into a
// record ("for each significant insight", not every supplied metric). Every returned
// record is built via agent/core/insightModel.js and enforces the causation-honesty
// guard: a possible_cause stated with no supporting evidence can never carry 'high'
// confidence (capped at 'medium') - correlation is never asserted as causation without
// evidence. This is a presence-only guard (whether evidence was supplied, not whether
// it actually substantiates the cause - see agent/core/insightModel.js's header).
function analyzeInsights(params = {}) {
  const fnName = 'analyzeInsights';
  const { metrics, topic, market = '', thresholdPercent } = params;
  requireNonEmptyArray(metrics, 'metrics', fnName);

  const insightLimitations = [];
  const skippedMetrics = [];
  const records = [];

  for (const entry of metrics) {
    requireObjectEntry(entry, 'metrics', fnName);
    requireNonEmptyString(entry.metric, 'metric', fnName);

    const significance = evaluateMetricSignificance({
      currentValue: entry.currentValue,
      comparisonValue: entry.comparisonValue,
      comparisonLabel: entry.comparisonLabel,
      unit: entry.unit,
      thresholdPercent,
    });
    if (!significance) {
      skippedMetrics.push(entry.metric);
      continue;
    }

    const record = createEmptyInsightRecord(entry.metric);
    record.current_state = entry.currentState || (entry.unit ? `${entry.currentValue} ${entry.unit}` : `${entry.currentValue}`);
    record.comparison = entry.comparison || significance.comparisonText;
    record.possible_cause = entry.possibleCause || '';
    record.opportunity = entry.opportunity || '';
    record.recommendation = entry.recommendation || '';
    record.evidence = normalizeArray(entry.evidence);

    const hasEvidence = record.evidence.length > 0;
    if (!hasEvidence) {
      insightLimitations.push(`No evidence was supplied for ${entry.metric}.`);
    }

    let confidence = entry.confidence || 'unassessed';
    if (record.possible_cause !== '' && !hasEvidence) {
      if (confidence === 'high') {
        confidence = 'medium';
        insightLimitations.push(
          `possible_cause for ${entry.metric} was downgraded from high confidence because no evidence was supplied to support it - correlation is never asserted as causation without evidence.`
        );
      } else {
        insightLimitations.push(
          `possible_cause for ${entry.metric} is an unproven hypothesis - no evidence was supplied to support it as a cause, not just as a correlated observation.`
        );
      }
    }
    record.confidence = confidence;

    let verificationStatus = entry.verificationStatus || 'unverified';
    if (verificationStatus === 'verified' && !hasEvidence) {
      verificationStatus = 'unverified';
      insightLimitations.push(`${entry.metric} verification_status was downgraded to unverified because no evidence was supplied.`);
    }
    record.verification_status = verificationStatus;

    const validation = validateInsightShape(record);
    if (!validation.valid) {
      throw new Error(`${fnName} produced an invalid insight record for metric '${entry.metric}': ${validation.errors.join('; ')}`);
    }
    records.push(record);
  }

  const findings = records.map((record) => `${record.metric}: ${record.current_state} (${record.comparison})`);
  const evidence = records.flatMap((record) => record.evidence);
  const recommendations = records.map((record) => record.recommendation).filter(Boolean);
  const limitations = [INSIGHT_ENGINE_LIMITATION_HEADER, ...insightLimitations];
  if (skippedMetrics.length > 0) {
    limitations.push(`${skippedMetrics.length} metric(s) did not clear the significance threshold and were excluded: ${skippedMetrics.join(', ')}.`);
  }

  const metricList = records.map((record) => record.metric).join(', ');
  return composeResult({
    capability: 'insights',
    topic: topic || `Analytics insights: ${metricList || '(no significant insights)'}`,
    market,
    findings,
    evidence,
    source: [],
    confidence: params.confidence,
    limitations,
    recommendations,
    verificationStatus: params.verificationStatus,
    researchDate: params.researchDate || todayIsoDate(),
    specializedRecords: records,
  });
}

const ANALYTICS_CAPABILITY_HANDLERS = {
  sales: analyzeSales,
  products: analyzeProducts,
  customers: analyzeCustomers,
  conversion: analyzeConversion,
  traffic: analyzeTraffic,
  marketing: analyzeMarketingAnalytics,
  advertising: analyzeAdvertisingAnalytics,
  inventory: analyzeInventory,
  growth_opportunities: analyzeGrowthOpportunities,
  insights: analyzeInsights,
};

// The single entry point: dispatches by capability to the matching function above.
// Never guesses an unrecognized capability - throws a clear error instead.
function runAnalyticsAgent({ capability, ...params } = {}) {
  const handler = ANALYTICS_CAPABILITY_HANDLERS[capability];
  if (!handler) {
    throw new Error(`Unknown Analytics capability: ${capability}. Must be one of: ${ANALYTICS_CAPABILITIES.join(', ')}`);
  }
  return handler(params);
}

module.exports = {
  analyzeSales,
  analyzeProducts,
  analyzeCustomers,
  analyzeConversion,
  analyzeTraffic,
  analyzeMarketingAnalytics,
  analyzeAdvertisingAnalytics,
  analyzeInventory,
  analyzeGrowthOpportunities,
  analyzeInsights,
  runAnalyticsAgent,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Analytics & Optimization Agent (deterministic, evidence-composition only):\n');

  const samples = [
    () =>
      analyzeSales({
        reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
        summary: 'Total revenue up 8% quarter-over-quarter (caller-supplied placeholder).',
        actualMetrics: [{ label: 'orders_count', value: 340 }],
        calculatedMetrics: [{ label: 'total_revenue', value: 128400, unit: 'USD' }, { label: 'average_order_value', value: 64, unit: 'USD' }],
        estimatedMetrics: [{ label: 'projected_monthly_revenue', value: 42800, unit: 'USD', assumption: 'Projected from the last 7 days of revenue, assuming a steady sales rate (caller-supplied placeholder).' }],
        evidence: [{ topic: 'Sales report', finding: 'Q1 sales export (caller-supplied placeholder).', source: ['(placeholder sales dashboard export)'] }],
      }),
    () =>
      analyzeProducts({
        reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
        summary: 'The insulated jacket line is the top-selling category (caller-supplied placeholder).',
        actualMetrics: [{ label: 'products_count', value: 48 }],
        calculatedMetrics: [{ label: 'out_of_stock_variants_count', value: 3 }],
      }),
    () =>
      analyzeCustomers({
        reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
        summary: 'Returning customers made up 22% of orders (caller-supplied placeholder).',
        actualMetrics: [{ label: 'customers_count', value: 210 }],
        calculatedMetrics: [{ label: 'repeat_purchase_rate', value: '22%' }],
      }),
    () =>
      analyzeConversion({
        reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
        summary: 'Checkout conversion rate held steady (caller-supplied placeholder).',
        actualMetrics: [{ label: 'conversion_rate', value: '2.8%' }],
      }),
    () =>
      analyzeTraffic({
        reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
        summary: 'Organic search traffic grew 15% (caller-supplied placeholder).',
        actualMetrics: [{ label: 'sessions', value: 42100 }],
      }),
    () =>
      analyzeMarketingAnalytics({
        reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
        summary: 'Email campaigns drove the highest-margin revenue (caller-supplied placeholder).',
        actualMetrics: [{ label: 'email_attributed_revenue', value: 18200, unit: 'USD' }],
      }),
    () =>
      analyzeAdvertisingAnalytics({
        reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
        summary: 'Meta Ads ROAS improved after the creative refresh (caller-supplied placeholder).',
        actualMetrics: [{ label: 'roas', value: 3.1 }],
      }),
    () =>
      analyzeInventory({
        reportingPeriod: '2026-Q1 (caller-supplied placeholder)',
        summary: 'Insulated jacket stock is running low (caller-supplied placeholder).',
        actualMetrics: [{ label: 'total_available_units', value: 42 }],
        calculatedMetrics: [{ label: 'out_of_stock_items_count', value: 2 }],
        estimatedMetrics: [{ label: 'estimated_days_of_inventory_remaining', value: 14, assumption: 'Assumes an average of 3 units sold per day (caller-supplied placeholder).' }],
      }),
    () =>
      analyzeGrowthOpportunities({
        opportunities: [
          {
            opportunityType: 'cross_selling',
            productReference: '(Example insulated jacket)',
            relatedProducts: ['(Example wool hat)'],
            recommendation: 'Recommend the wool hat alongside the jacket (caller-supplied placeholder).',
            evidence: ['(placeholder basket-analysis export)'],
          },
          { opportunityType: 'retention', productReference: '(Example insulated jacket)' },
        ],
      }),
    () =>
      analyzeInsights({
        metrics: [
          {
            metric: 'total_revenue',
            currentValue: 128400,
            comparisonValue: 109000,
            comparisonLabel: 'previous quarter',
            unit: 'USD',
            possibleCause: 'A site-wide promotion ran for 2 weeks during this quarter (caller-supplied placeholder).',
            opportunity: 'Extend the promotion cadence into next quarter (caller-supplied placeholder).',
            recommendation: 'Run a similar promotion next quarter and track attribution more closely (caller-supplied placeholder).',
            confidence: 'high',
            evidence: ['(placeholder promo campaign log: ran Jan 5-19, overlapping the revenue increase)'],
          },
          {
            // No evidence supplied for this possible_cause - demonstrates the
            // causation-honesty guard capping confidence at 'medium'.
            metric: 'checkout_conversion_rate',
            currentValue: 1.9,
            comparisonValue: 2.8,
            comparisonLabel: 'previous quarter',
            unit: '%',
            possibleCause: 'A recent checkout redesign may have introduced friction (caller-supplied placeholder, unconfirmed).',
            opportunity: 'Audit the new checkout flow for drop-off points (caller-supplied placeholder).',
            recommendation: 'Run a usability test on the redesigned checkout flow (caller-supplied placeholder).',
            confidence: 'high',
          },
          {
            // Below the default 10% significance threshold - excluded from the result.
            metric: 'average_order_value',
            currentValue: 65,
            comparisonValue: 64,
            comparisonLabel: 'previous quarter',
            unit: 'USD',
          },
        ],
      }),
  ];

  for (const sample of samples) {
    const result = sample();
    console.log(`--- ${result.capability} ---`);
    console.log(JSON.stringify(result, null, 2));
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
