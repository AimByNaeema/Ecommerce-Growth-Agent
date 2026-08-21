'use strict';

// A controlled test of the ONE agent against the owner's real business configuration
// (configuration/business.yaml). For each of the 10 requested capability areas, this
// checks two separate things:
//
//   1. STRUCTURAL capability - can the agent's existing schemas/workflows for this
//      area be exercised at all (module loads, createEmpty*/validate*/get* functions
//      work)? This does not require real business data - createEmpty*() helpers
//      already produce blank/unassessed records by design (see each schema's own
//      CLI block), so exercising them here invents nothing.
//   2. REAL DATA availability - does real, configured business data actually exist to
//      populate this area (configuration/business.yaml, data/products/, data/business/,
//      memory/state/)? If not, that is reported plainly - never guessed or filled in.
//
// This script does not call any external service, does not persist anything, and does
// not add any new agent capability - it only exercises what already exists.

const fs = require('fs');
const path = require('path');

const { REQUIRED_FIELDS, validateBusinessConfig, loadBusinessConfig } = require('../../tools/configValidator');
const { createEmptyProductRecord, validateProductRecordShape } = require('../../agent/core/productModel');
const { createEmptyMarketResearchRecord, validateMarketResearchShape } = require('../../agent/core/marketResearchModel');
const {
  createEmptyCustomerSegmentResearchRecord,
  validateCustomerSegmentResearchShape,
} = require('../../agent/core/customerSegmentResearchModel');
const {
  createEmptyCompetitorResearchRecord,
  validateCompetitorResearchShape,
} = require('../../agent/core/competitorResearchModel');
const {
  createEmptyOpportunityAnalysis,
  validateOpportunityAnalysisShape,
} = require('../../agent/core/opportunityAnalysisModel');
const { getProductOpportunityAnalysisWorkflow } = require('../../workflows/productOpportunityAnalysisWorkflow');
const { createEmptySeoResearchRecord, validateSeoResearchShape } = require('../../agent/core/seoResearchModel');
const { getKeywordResearchWorkflow } = require('../../workflows/keywordResearchWorkflow');
const {
  createEmptyListingOptimizationRecord,
  validateListingOptimizationShape,
} = require('../../agent/core/listingOptimizationModel');
const {
  createEmptyMarketingAnalysisRecord,
  validateMarketingAnalysisShape,
} = require('../../agent/core/marketingAnalysisModel');
const { getContentMarketingWorkflow } = require('../../workflows/contentMarketingWorkflow');
const {
  createEmptyGrowthOpportunityRecord,
  validateGrowthOpportunityShape,
} = require('../../agent/core/growthOpportunityModel');
const {
  createEmptyResearchRecord,
  validateResearchRecordShape,
  CONFIDENCE_LEVELS,
  RELEVANCE_LEVELS,
  RESEARCH_VERIFICATION_STATUSES,
} = require('../../agent/core/researchRecordModel');
const { getAnalyticsInsightWorkflow, STATEMENT_TYPES } = require('../../workflows/analyticsInsightWorkflow');
const { getContract } = require('../../agent/core/agentContract');
const { createEmptyState, validateStateShape } = require('../../agent/core/stateModel');
const { getMemoryRules } = require('../../agent/core/memoryRules');
const { getContextBoundaries } = require('../../agent/core/contextBoundaries');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BUSINESS_CONFIG_PATH = path.join(REPO_ROOT, 'configuration', 'business.yaml');

function dirHasRealFiles(relativeDir) {
  const dirPath = path.join(REPO_ROOT, relativeDir);
  if (!fs.existsSync(dirPath)) return false;
  const entries = fs.readdirSync(dirPath).filter((name) => name.toLowerCase() !== 'readme.md');
  return entries.length > 0;
}

// --- Load the owner's real business configuration (never invented) ---
const businessConfigExists = fs.existsSync(BUSINESS_CONFIG_PATH);
let businessConfig = null;
let businessConfigMissing = [...REQUIRED_FIELDS];
let businessConfigLoadError = null;

if (businessConfigExists) {
  try {
    businessConfig = loadBusinessConfig(BUSINESS_CONFIG_PATH);
    businessConfigMissing = validateBusinessConfig(businessConfig).missing;
  } catch (err) {
    businessConfigLoadError = err.message;
  }
} else {
  businessConfigLoadError = `Business configuration file not found: ${BUSINESS_CONFIG_PATH}`;
}

function configListNonEmpty(field) {
  if (!businessConfig) return false;
  const value = businessConfig[field];
  return Array.isArray(value) && value.length > 0;
}

const results = [];

function record(id, title, structural, data) {
  results.push({ id, title, structural, data });
}

// --- 1. Business context ---
record(
  'business_context',
  'Business context',
  { pass: true, detail: 'configValidator.js loads; REQUIRED_FIELDS (12) and validateBusinessConfig() are callable.' },
  businessConfigExists && businessConfigMissing.length === 0
    ? { available: true, detail: 'configuration/business.yaml exists and all 12 required fields are present.' }
    : {
        available: false,
        detail: businessConfigExists
          ? `configuration/business.yaml exists but is incomplete. Missing fields: ${businessConfigMissing.join(', ')}`
          : `configuration/business.yaml does not exist. Missing fields (all required): ${businessConfigMissing.join(', ')}. Copy configuration/business.example.yaml to configuration/business.yaml and fill in the real business's values.`,
      }
);

// --- 2. Product context ---
{
  const emptyProduct = createEmptyProductRecord('(no product set)');
  const validation = validateProductRecordShape(emptyProduct);
  const hasRealProducts = dirHasRealFiles('data/products');
  record(
    'product_context',
    'Product context',
    { pass: validation.valid, detail: validation.valid ? 'productModel.js createEmptyProductRecord()/validateProductRecordShape() work correctly.' : `validation errors: ${validation.errors.join(', ')}` },
    hasRealProducts
      ? { available: true, detail: 'data/products/ contains real product entries.' }
      : { available: false, detail: 'data/products/ has no entries beyond its README - no real product catalog has been loaded yet.' }
  );
}

// --- 3. Customer/market research ---
{
  const emptyMarket = createEmptyMarketResearchRecord('', '');
  const marketValidation = validateMarketResearchShape(emptyMarket);
  const emptySegment = createEmptyCustomerSegmentResearchRecord('');
  const segmentValidation = validateCustomerSegmentResearchShape(emptySegment);
  const structuralPass = marketValidation.valid && segmentValidation.valid;

  const missingConfigArrays = ['target_markets', 'countries', 'customer_segments'].filter(
    (field) => !configListNonEmpty(field)
  );

  record(
    'customer_market_research',
    'Customer/market research',
    {
      pass: structuralPass,
      detail: structuralPass
        ? 'marketResearchModel.js and customerSegmentResearchModel.js createEmpty*/validate* work correctly.'
        : `validation errors: ${[...marketValidation.errors, ...segmentValidation.errors].join(', ')}`,
    },
    missingConfigArrays.length === 0
      ? { available: true, detail: 'business config has real target_markets, countries, and customer_segments to research against.' }
      : {
          available: false,
          detail: !businessConfig
            ? 'blocked: no business configuration is loaded (see business_context above).'
            : `business config is missing real values for: ${missingConfigArrays.join(', ')} - nothing to research yet.`,
        }
  );
}

// --- 4. Competitor research ---
{
  const emptyCompetitor = createEmptyCompetitorResearchRecord('(no competitor set)');
  const validation = validateCompetitorResearchShape(emptyCompetitor);
  record(
    'competitor_research',
    'Competitor research',
    { pass: validation.valid, detail: validation.valid ? 'competitorResearchModel.js createEmpty*/validate* work correctly.' : `validation errors: ${validation.errors.join(', ')}` },
    { available: false, detail: 'no competitor research has been recorded yet - no persistence layer exists to store real records.' }
  );
}

// --- 5. Product opportunity analysis ---
{
  const emptyAnalysis = createEmptyOpportunityAnalysis('(no opportunity set)');
  const validation = validateOpportunityAnalysisShape(emptyAnalysis);
  const stages = getProductOpportunityAnalysisWorkflow();
  const structuralPass = validation.valid && stages.length === 8;
  record(
    'product_opportunity_analysis',
    'Product opportunity analysis',
    {
      pass: structuralPass,
      detail: structuralPass
        ? `opportunityAnalysisModel.js createEmpty*/validate* work correctly; productOpportunityAnalysisWorkflow.js exposes all ${stages.length} stages.`
        : `validation errors: ${validation.errors.join(', ')}; stage count: ${stages.length}`,
    },
    { available: false, detail: 'requires real product context and real research evidence (both unavailable - see items 2-4 above).' }
  );
}

// --- 6. Keyword/SEO work ---
{
  const emptySeo = createEmptySeoResearchRecord('(no keyword set)');
  const seoValidation = validateSeoResearchShape(emptySeo);
  const keywordStages = getKeywordResearchWorkflow();
  const emptyListing = createEmptyListingOptimizationRecord('(no product set)');
  const listingValidation = validateListingOptimizationShape(emptyListing);
  const structuralPass = seoValidation.valid && keywordStages.length === 7 && listingValidation.valid;
  record(
    'keyword_seo_work',
    'Keyword/SEO work',
    {
      pass: structuralPass,
      detail: structuralPass
        ? `seoResearchModel.js and listingOptimizationModel.js createEmpty*/validate* work correctly; keywordResearchWorkflow.js exposes all ${keywordStages.length} stages.`
        : `seo errors: ${seoValidation.errors.join(', ')}; listing errors: ${listingValidation.errors.join(', ')}; stage count: ${keywordStages.length}`,
    },
    { available: false, detail: 'requires a real product/category and real keyword evidence (unavailable - no live keyword API is configured, per seoResearchModel.js).' }
  );
}

// --- 7. Marketing opportunity ---
{
  const emptyMarketing = createEmptyMarketingAnalysisRecord('', '');
  const validation = validateMarketingAnalysisShape(emptyMarketing);
  const contentStages = getContentMarketingWorkflow();
  const structuralPass = validation.valid && contentStages.length === 7;
  const hasChannels = configListNonEmpty('marketing_channels');
  record(
    'marketing_opportunity',
    'Marketing opportunity',
    {
      pass: structuralPass,
      detail: structuralPass
        ? `marketingAnalysisModel.js createEmpty*/validate* work correctly; contentMarketingWorkflow.js exposes all ${contentStages.length} stages.`
        : `validation errors: ${validation.errors.join(', ')}; stage count: ${contentStages.length}`,
    },
    hasChannels
      ? { available: true, detail: 'business config has real marketing_channels to plan against.' }
      : {
          available: false,
          detail: !businessConfig
            ? 'blocked: no business configuration is loaded (see business_context above).'
            : 'business config has no real marketing_channels configured yet.',
        }
  );
}

// --- 8. Growth opportunity ---
{
  const emptyGrowth = createEmptyGrowthOpportunityRecord('unclassified', '(no product set)');
  const validation = validateGrowthOpportunityShape(emptyGrowth);
  record(
    'growth_opportunity',
    'Growth opportunity',
    { pass: validation.valid, detail: validation.valid ? 'growthOpportunityModel.js createEmpty*/validate* work correctly.' : `validation errors: ${validation.errors.join(', ')}` },
    { available: false, detail: 'requires real, already-configured products and offers (unavailable - see item 2 above); no product/offer is ever invented here.' }
  );
}

// --- 9. Evidence and verification ---
{
  const emptyResearch = createEmptyResearchRecord('(no topic set)');
  const researchValidation = validateResearchRecordShape(emptyResearch);
  const insightStages = getAnalyticsInsightWorkflow();
  const contract = getContract();
  const hasVerifyStage = contract.some((stage) => stage.id === 'verify_results');
  const hasHandleErrorsStage = contract.some((stage) => stage.id === 'handle_errors');
  const structuralPass =
    researchValidation.valid &&
    emptyResearch.confidence === 'unassessed' &&
    emptyResearch.relevance === 'unassessed' &&
    emptyResearch.verification_status === 'unverified' &&
    CONFIDENCE_LEVELS.includes('unassessed') &&
    RELEVANCE_LEVELS.includes('unassessed') &&
    RESEARCH_VERIFICATION_STATUSES.includes('unverified') &&
    insightStages.length === 7 &&
    STATEMENT_TYPES.length === 5 &&
    hasVerifyStage &&
    hasHandleErrorsStage;
  record(
    'evidence_and_verification',
    'Evidence and verification',
    {
      pass: structuralPass,
      detail: structuralPass
        ? 'researchRecordModel.js confidence/relevance/verification_status default to unassessed/unverified; analyticsInsightWorkflow.js STATEMENT_TYPES (5) distinguish fact from hypothesis; agentContract.js has verify_results and handle_errors stages.'
        : `research validation errors: ${researchValidation.errors.join(', ')}; verify_results present: ${hasVerifyStage}; handle_errors present: ${hasHandleErrorsStage}; insight stages: ${insightStages.length}; statement types: ${STATEMENT_TYPES.length}`,
    },
    { available: true, detail: 'this is an architectural convention, not business data - it applies regardless of whether real evidence has been gathered yet.' }
  );
}

// --- 10. Memory/state handling ---
{
  const emptyState = createEmptyState('(no objective set)');
  const stateValidation = validateStateShape(emptyState);
  const memoryRules = getMemoryRules();
  const contextBoundaries = getContextBoundaries();
  const structuralPass =
    stateValidation.valid &&
    memoryRules.qualities.length === 5 &&
    memoryRules.priorities.length === 6 &&
    memoryRules.exclusions.length === 2 &&
    contextBoundaries.length === 6;
  const hasRealState = dirHasRealFiles('memory/state');
  record(
    'memory_state_handling',
    'Memory/state handling',
    {
      pass: structuralPass,
      detail: structuralPass
        ? 'stateModel.js createEmptyState()/validateStateShape() work correctly; memoryRules.js and contextBoundaries.js are intact.'
        : `state validation errors: ${stateValidation.errors.join(', ')}`,
    },
    hasRealState
      ? { available: true, detail: 'memory/state/ contains real persisted state.' }
      : { available: false, detail: 'memory/state/ has no entries beyond its README - no persistence layer is implemented yet, so nothing has been saved.' }
  );
}

// --- Report ---
console.log('Smart E-Commerce Growth AI Agent - controlled agent test (owner\'s business configuration):\n');

console.log(`Business configuration path: ${BUSINESS_CONFIG_PATH}`);
console.log(`Exists: ${businessConfigExists}`);
if (businessConfigLoadError && !businessConfigExists) {
  console.log(`Result: NOT FOUND - ${businessConfigLoadError}`);
} else if (businessConfigMissing.length > 0) {
  console.log(`Result: INCOMPLETE - missing fields: ${businessConfigMissing.join(', ')}`);
} else {
  console.log('Result: COMPLETE - all 12 required fields present.');
}

console.log('\nCapability areas:\n');

let structuralFailures = 0;
results.forEach((result, index) => {
  const structuralLabel = result.structural.pass ? 'PASS' : 'FAIL';
  const dataLabel = result.data.available ? 'AVAILABLE' : 'MISSING';
  if (!result.structural.pass) structuralFailures += 1;
  console.log(`${index + 1}. [${result.id}] ${result.title}`);
  console.log(`   structural capability: ${structuralLabel} - ${result.structural.detail}`);
  console.log(`   real business data:    ${dataLabel} - ${result.data.detail}`);
});

const dataGaps = results.filter((result) => !result.data.available).length;

console.log('\nSummary:');
console.log(`  structural capability: ${results.length - structuralFailures}/${results.length} passed`);
console.log(`  real business data available: ${results.length - dataGaps}/${results.length} areas`);

if (structuralFailures > 0) {
  console.error('\nSTOP: confirmed structural errors found (see FAIL entries above) - these are code defects, not missing data.');
  process.exit(1);
}

if (!businessConfigExists || businessConfigMissing.length > 0) {
  console.error('\nSTOP: the owner\'s business configuration is missing or incomplete - reported above, not guessed.');
  console.error('No business data was invented to work around this.');
  process.exit(1);
}

console.log('\nAll structural capabilities pass and the business configuration is complete.');
