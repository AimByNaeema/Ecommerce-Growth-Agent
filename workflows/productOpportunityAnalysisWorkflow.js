'use strict';

// The ordered process that turns gathered evidence into a structured product opportunity
// analysis. Composes products/productResearchArchitecture.js (how evidence gets
// gathered) with agent/core/opportunityAnalysisModel.js (the structured output shape) and
// agent/core/researchRecordModel.js (the evidence/finding shape) - a multi-step process
// combining existing capability modules, which is what workflows/ is for.
//
// PRODUCT_OPPORTUNITY_ANALYSIS_STAGES / getProductOpportunityAnalysisWorkflow() below
// remain the conceptual 8-stage description of the full pipeline - unchanged.
//
// analyzeProductOpportunityFromMarket() is real, executable logic connecting global
// market intelligence (workflows/globalEcommerceMarketResearchWorkflow.js's
// compareGlobalMarkets(), already wired to the Chief as the
// global_market_opportunity_analysis tool) to Product Opportunity analysis
// (agent/core/productAgent.js's analyzeProductOpportunity()):
//
//   Market -> Category -> Trend -> Product -> Competition -> Economics -> Opportunity
//
// Reuses, never duplicates: agent/core/productAgent.js's analyzeProductOpportunity()
// unmodified for demand/competition/market_relevance(market_fit)/risks(product_risk),
// and its exported buildDimension() for commercial_potential (the "Economics" stage -
// pricing/cost inputs only, never a computed margin, matching
// agent/core/productAgent.js's buildProfitabilityInputs()). This function only derives
// evidence - {topic, finding, source} entries built from literal, already caller-
// supplied market-row content - from the market row into the exact evidence-param
// shape those two already expect; it never synthesizes an assessment or a confidence
// level. `assessment` stays whatever the caller of this function explicitly supplies
// (default '', same honest empty default as everywhere else in this codebase);
// `confidence` stays whatever the caller explicitly asserts (default 'unassessed',
// downgraded back to 'unassessed' if no evidence backs it) - never invented from
// evidence volume or presence. This is how "do not present estimates as verified
// facts" is enforced structurally, not just by convention.
//
// customer_fit, differentiation, and evidence_quality (3 of
// agent/core/opportunityAnalysisModel.js's 8 dimensions) are not part of the named
// Market -> Category -> Trend -> Product -> Competition -> Economics -> Opportunity
// pipeline and stay at their honest empty default - same scope discipline
// analyzeProductOpportunity() already applies to its own 4 dimensions.
//
// This workflow stops once the structured opportunityAnalysisModel.js record is
// produced. No stage here scores, ranks, or decides anything - no automated
// recommendation/verdict.

const {
  createEmptyMarketConnectedOpportunity,
  validateMarketConnectedOpportunityShape,
} = require('../agent/core/marketConnectedOpportunityModel');
const { validateOpportunityAnalysisShape } = require('../agent/core/opportunityAnalysisModel');
const { analyzeProductOpportunity, buildDimension } = require('../agent/core/productAgent');

const PRODUCT_OPPORTUNITY_ANALYSIS_STAGES = [
  {
    id: 'assess_demand',
    title: 'Assess demand',
    description:
      'Evaluate customer demand for the candidate using evidence gathered so far (products/productResearchArchitecture.js identify_demand_signals), producing agent/core/opportunityAnalysisModel.js demand.',
  },
  {
    id: 'assess_competition',
    title: 'Assess competition',
    description:
      'Evaluate existing competitors or alternatives using evidence gathered so far (products/productResearchArchitecture.js identify_competition), producing agent/core/opportunityAnalysisModel.js competition.',
  },
  {
    id: 'assess_customer_fit',
    title: 'Assess customer fit',
    description:
      "Evaluate fit with the business's target customer (agent/core/productModel.js target_customer), producing agent/core/opportunityAnalysisModel.js customer_fit.",
  },
  {
    id: 'assess_differentiation',
    title: 'Assess differentiation',
    description:
      'Evaluate how the candidate differs from existing alternatives identified during assess_competition, producing agent/core/opportunityAnalysisModel.js differentiation.',
  },
  {
    id: 'assess_market_relevance',
    title: 'Assess market relevance',
    description:
      "Evaluate fit with the business's target markets (configuration/business.yaml; agent/core/productModel.js market), using products/productResearchArchitecture.js identify_market_fit, producing agent/core/opportunityAnalysisModel.js market_relevance.",
  },
  {
    id: 'assess_commercial_potential',
    title: 'Assess commercial potential',
    description:
      "Evaluate the candidate's commercial potential using the evidence gathered so far, producing agent/core/opportunityAnalysisModel.js commercial_potential.",
  },
  {
    id: 'assess_risks',
    title: 'Assess risks',
    description:
      'Evaluate risks identified for the candidate using the evidence gathered so far, producing agent/core/opportunityAnalysisModel.js risks.',
  },
  {
    id: 'assess_evidence_quality',
    title: 'Assess evidence quality',
    description:
      'Evaluate how strong and complete the evidence backing the above assessments is (agent/core/researchRecordModel.js confidence/verification_status across the records used), producing agent/core/opportunityAnalysisModel.js evidence_quality.',
  },
];

function getProductOpportunityAnalysisWorkflow() {
  return PRODUCT_OPPORTUNITY_ANALYSIS_STAGES;
}

// ---------------------------------------------------------------------------------
// Market -> Category -> Trend -> Product -> Competition -> Economics -> Opportunity
// ---------------------------------------------------------------------------------

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// A generic research-record-shaped evidence entry (see
// agent/core/researchRecordModel.js / agent/core/researchAgent.js's buildGenericRecord),
// built only from content the market row already carries as caller-supplied - never a
// synthesized judgment.
function buildGenericEvidenceEntry(topic, finding, source) {
  return { topic, finding: finding || '', source: normalizeArray(source) };
}

// Category / Trend - derived from a scalar facet ({value, evidence, has_evidence}),
// e.g. workflows/globalEcommerceMarketResearchWorkflow.js's row.category/row.trends.
// Only produces an entry when the facet actually carries evidence - an empty facet
// contributes nothing, never a placeholder.
//
// `value` is a plain string for some facets (category) and an array of strings for
// others (demand_signals, trends, risks, opportunities - agent/core/marketResearchModel.js
// defines those as array fields). A string passes through as the entry's `finding`;
// an array is merged into `source` alongside the facet's own evidence instead - never
// joined/formatted into a synthesized sentence, and never assigned to `finding` as-is
// (which would corrupt it into a nested array rather than the plain string
// agent/core/researchRecordModel.js expects).
function deriveScalarFacetEvidence(facet, label) {
  if (!facet || !facet.has_evidence) return [];
  const isStringValue = typeof facet.value === 'string';
  const finding = isStringValue ? facet.value : '';
  const valueAsSource = Array.isArray(facet.value) ? facet.value : [];
  return [buildGenericEvidenceEntry(label, finding, [...valueAsSource, ...normalizeArray(facet.evidence)])];
}

// Competition - derived from the row's competition entry facet
// ({status, entries: [{competitor, positioning, strengths, weaknesses, evidence}]}).
function deriveCompetitionEvidenceEntries(competitionFacet) {
  if (!competitionFacet || !Array.isArray(competitionFacet.entries)) return [];
  return competitionFacet.entries
    .filter((entry) => Array.isArray(entry.evidence) && entry.evidence.length > 0)
    .map((entry) => buildGenericEvidenceEntry(`Competitor: ${entry.competitor}`, entry.positioning, entry.evidence));
}

// Economics - derived from the row's pricing entry facet
// ({status, entries: [{competitor, pricing_evidence, evidence}]}). Inputs only: real
// pricing evidence strings pass through as-is, never combined into a computed margin
// or formatted into a synthesized sentence.
function derivePricingEvidenceEntries(pricingFacet) {
  if (!pricingFacet || !Array.isArray(pricingFacet.entries)) return [];
  return pricingFacet.entries
    .filter((entry) => Array.isArray(entry.evidence) && entry.evidence.length > 0)
    .map((entry) =>
      buildGenericEvidenceEntry(`Pricing: ${entry.competitor}`, '', [
        ...normalizeArray(entry.pricing_evidence),
        ...normalizeArray(entry.evidence),
      ])
    );
}

function requireValidMarketRow(marketRow, fnName) {
  if (!marketRow || typeof marketRow !== 'object' || Array.isArray(marketRow)) {
    throw new Error(
      `${fnName} requires a \`marketRow\` object (one row from compareGlobalMarkets()'s \`comparison\` array).`
    );
  }
  if (typeof marketRow.market !== 'string' || marketRow.market.trim() === '') {
    throw new Error(`${fnName} requires \`marketRow.market\` to be a non-empty string.`);
  }
}

// Product - the candidate must already be present in the market row's
// specialized_records (never invents a candidate that isn't already there).
function findProductInMarketRow(marketRow, productIdentity, fnName) {
  if (typeof productIdentity !== 'string' || productIdentity.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`productIdentity\` string.`);
  }
  const products =
    marketRow.specialized_records && Array.isArray(marketRow.specialized_records.products)
      ? marketRow.specialized_records.products
      : null;
  if (!products) {
    throw new Error(`${fnName} requires \`marketRow.specialized_records.products\` to be an array.`);
  }
  const product = products.find((record) => record.product_identity === productIdentity);
  if (!product) {
    throw new Error(`${fnName} could not find product "${productIdentity}" in the supplied market row.`);
  }
  return product;
}

function analyzeProductOpportunityFromMarket(params = {}) {
  const fnName = 'analyzeProductOpportunityFromMarket';
  const { marketRow } = params;
  requireValidMarketRow(marketRow, fnName);
  const productRecord = findProductInMarketRow(marketRow, params.productIdentity, fnName);

  const demandEvidence = [
    ...deriveScalarFacetEvidence(marketRow.trends, `Trend in ${marketRow.market}`),
    ...deriveScalarFacetEvidence(marketRow.demand_signals, `Demand signals in ${marketRow.market}`),
  ];
  const marketFitEvidence = deriveScalarFacetEvidence(marketRow.category, `Category in ${marketRow.market}`);
  const competitionEvidence = deriveCompetitionEvidenceEntries(marketRow.competition);
  const pricingEvidenceEntries = derivePricingEvidenceEntries(marketRow.pricing);

  const productAgentResult = analyzeProductOpportunity({
    productIdentity: productRecord.product_identity,
    category: productRecord.category,
    productModel: productRecord.product_model,
    description: productRecord.description,
    positioning: productRecord.positioning,
    targetCustomer: productRecord.target_customer,
    market: productRecord.market,
    pricing: productRecord.pricing,
    availability: productRecord.availability,
    source: productRecord.source,
    researchStatus: productRecord.research_status,
    researchDate: params.researchDate,
    demandAssessment: params.demandAssessment,
    demandEvidence,
    demandConfidence: params.demandConfidence,
    competitionAssessment: params.competitionAssessment,
    competitionEvidence,
    competitionConfidence: params.competitionConfidence,
    marketFitAssessment: params.marketFitAssessment,
    marketFitEvidence,
    marketFitConfidence: params.marketFitConfidence,
    productRiskAssessment: params.productRiskAssessment,
    productRiskEvidence: params.productRiskEvidence,
    productRiskConfidence: params.productRiskConfidence,
    costComponents: pricingEvidenceEntries,
  });

  const commercialPotentialBuilt = buildDimension(
    {
      commercialPotentialAssessment: params.commercialPotentialAssessment,
      commercialPotentialEvidence: pricingEvidenceEntries,
      commercialPotentialConfidence: params.commercialPotentialConfidence,
    },
    'commercial_potential',
    fnName
  );

  const opportunityAnalysis = productAgentResult.specialized_records.opportunity_analysis;
  opportunityAnalysis.commercial_potential = commercialPotentialBuilt.dimension;
  const opportunityValidation = validateOpportunityAnalysisShape(opportunityAnalysis);
  if (!opportunityValidation.valid) {
    throw new Error(
      `${fnName} produced an invalid opportunity analysis record: ${opportunityValidation.errors.join('; ')}`
    );
  }

  const limitations = [...productAgentResult.limitations];
  if (commercialPotentialBuilt.limitation) limitations.push(commercialPotentialBuilt.limitation);
  limitations.push(
    'No field in this result is a computed statistic - every dimension is either caller-supplied content or a structural evidence-presence signal.'
  );

  const result = createEmptyMarketConnectedOpportunity(productRecord.product_identity);
  result.market = marketRow.market;
  result.country = marketRow.country || '';
  result.opportunity_analysis = opportunityAnalysis;
  result.limitations = limitations;
  result.research_date = params.researchDate || todayIsoDate();
  result.specialized_records = {
    market_row: marketRow,
    product_record: productRecord,
    product_agent_result: productAgentResult,
  };

  const validation = validateMarketConnectedOpportunityShape(result);
  if (!validation.valid) {
    throw new Error(
      `${fnName} produced an invalid market-connected opportunity record: ${validation.errors.join('; ')}`
    );
  }
  return result;
}

module.exports = {
  PRODUCT_OPPORTUNITY_ANALYSIS_STAGES,
  getProductOpportunityAnalysisWorkflow,
  analyzeProductOpportunityFromMarket,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - product opportunity analysis workflow:\n');
  PRODUCT_OPPORTUNITY_ANALYSIS_STAGES.forEach((stage, index) => {
    console.log(`${index + 1}. [${stage.id}] ${stage.title}`);
    console.log(`   ${stage.description}`);
  });
  console.log('\nNo automated recommendation, score, or verdict is produced - only the structured,');
  console.log('evidence-based agent/core/opportunityAnalysisModel.js record.');

  console.log('\n--- analyzeProductOpportunityFromMarket (Market -> Category -> Trend -> Product -> Competition -> Economics -> Opportunity) ---');
  const { compareGlobalMarkets } = require('./globalEcommerceMarketResearchWorkflow');
  const comparison = compareGlobalMarkets({
    markets: [
      {
        country: 'DE',
        market: 'European Union',
        category: 'outdoor apparel',
        demandSignals: ['Rising search interest in insulated jackets (caller-supplied placeholder).'],
        trends: ['Growing preference for recycled materials (caller-supplied placeholder).'],
        evidence: ['(placeholder market evidence reference)'],
        competitors: [
          {
            competitor: '(Example EU Competitor Co.)',
            positioning: 'Premium, sustainable materials (caller-supplied placeholder).',
            pricingEvidence: ['(placeholder pricing page reference)'],
            source: ['(placeholder competitor source reference)'],
          },
        ],
        products: [
          {
            productIdentity: '(Example insulated jacket)',
            positioning: 'Mid-range, recycled materials (caller-supplied placeholder).',
            pricing: { currency: 'EUR', cost: '40', price: '90' },
            availability: 'available',
            source: ['(placeholder product source reference)'],
          },
        ],
      },
    ],
  });
  const marketRow = comparison.comparison[0];
  const result = analyzeProductOpportunityFromMarket({
    marketRow,
    productIdentity: '(Example insulated jacket)',
    demandAssessment: 'Caller-supplied placeholder assessment.',
    demandConfidence: 'medium',
  });
  console.log(JSON.stringify(result, null, 2));
  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('customer_fit, differentiation, and evidence_quality stay honestly empty - outside this pipeline\'s named scope.');
}
