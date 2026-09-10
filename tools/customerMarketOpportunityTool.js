'use strict';

// The catalogue_expansion_opportunities tool (tools/toolRegistry.js). Assembles the
// customer's OWN real business context, then hands it to
// workflows/customerMarketOpportunityWorkflow.js, which researches the market that context
// defines and returns the Top N opportunities for THIS business.
//
// A THIN ASSEMBLER, the same shape as tools/etsyShopDataTool.js: no research logic, no
// scoring, no ranking and no HTTP of its own lives here. Its one job is to gather real
// customer data through the EXISTING retrieval paths and pass it on:
//
//   configuration/business.yaml     via tools/configValidator.js's loadBusinessConfig
//   the business's Shopify products via tools/productDataRetrievalTool.js
//   the business's Etsy listings    via tools/etsyListingDataTool.js (read-only)
//
// CHANNELS STAY SEPARATE. Each catalogue record keeps its own `channel` stamp end to end
// (agent/core/channelModel.js), and the two channels are never merged into one record.
// They are counted together only as evidence about ONE business's own product range -
// which is what a niche is - and every contributing record stays individually
// attributable. A channel that is not connected simply contributes nothing.
//
// DEGRADES HONESTLY. A channel that fails to read is reported as a limitation and the run
// continues on what it did get; if NOTHING real can be read, the workflow returns
// needs_information rather than researching a guessed market.
//
// WHY THE REGISTRY ID AND THESE MODULE NAMES DIFFER. The registered tool id is
// `catalogue_expansion_opportunities`, not `customer_market_opportunity_research`, and that
// is deliberate: agent/core/orchestratorExecutionContract.js routes free text by word
// overlap against a tool's own id, title and description, so an id containing
// market/opportunity/research outscored every sibling Research capability on any objective
// mentioning a market (verified - it changed this project's pinned "market competitor
// research" and "Research the best market opportunity ..." routing outcomes). The modules
// keep their descriptive names; only the routing-visible id is distinctive.
//
// NEVER THROWS. Returns the honest {status, result, error} envelope every TOOL_EXECUTORS
// entry uses.

const path = require('path');
const { loadBusinessConfig } = require('./configValidator');
const productDataRetrievalTool = require('./productDataRetrievalTool');
const etsyListingDataTool = require('./etsyListingDataTool');
const etsyReadClient = require('../integrations/adapters/etsyReadClient');
const shopifyClient = require('../integrations/adapters/shopifyClient');
const {
  runCustomerMarketOpportunityResearch,
  DEFAULT_TOP_LIMIT,
} = require('../workflows/customerMarketOpportunityWorkflow');

const BUSINESS_CONFIG_PATH = path.join(__dirname, '..', 'configuration', 'business.yaml');
// Bounded reads: this is a niche-identification sample, not a catalogue export. A larger
// pull would spend real API quota to sharpen a signal that is already clear.
const SHOPIFY_SAMPLE_LIMIT = 50;
const ETSY_SAMPLE_LIMIT = 25;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// The business's own Shopify products, projected to the fields the scope engine reads.
// Each keeps channel: 'shopify'.
async function readShopifyCatalogue(businessId, limitations) {
  if (!shopifyClient.isConfigured({ businessId })) {
    limitations.push('Shopify is not configured, so no Shopify product contributed to the customer context.');
    return [];
  }
  try {
    const outcome = await productDataRetrievalTool.runProductDataRetrievalTool({ businessId, limit: SHOPIFY_SAMPLE_LIMIT });
    if (outcome.status === 'failed') {
      limitations.push(`Shopify products could not be read: ${outcome.error}`);
      return [];
    }
    // runProductDataRetrievalTool returns its agent/core/productModel.js records as a
    // PLAIN ARRAY on `result` - not wrapped in a specialized_records envelope the way the
    // analysis tools are. Both shapes are accepted so a future envelope change cannot
    // silently reduce this to zero products (which is exactly what reading only the
    // envelope did: the store's 50 real products all disappeared and the market scope
    // quietly fell back to declared categories alone).
    const records = Array.isArray(outcome.result)
      ? outcome.result
      : asArray(outcome.result && outcome.result.specialized_records);
    return records
      .map((record) => ({
        channel: 'shopify',
        title: record.product_identity || record.title || null,
        category: record.category || null,
        // productModel carries no tags field; the title and category are the real signal.
        tags: asArray(record.tags),
        product_type: record.product_model || record.product_type || null,
        price: record.pricing && record.pricing.price ? record.pricing.price : null,
      }))
      .filter((entry) => entry.title);
  } catch (err) {
    limitations.push(`Shopify products could not be read: ${err.message}`);
    return [];
  }
}

// The business's own Etsy listings, read-only. Each keeps channel: 'etsy'.
async function readEtsyCatalogue(businessId, limitations) {
  if (!etsyReadClient.canRead({ businessId })) {
    limitations.push('Etsy is not connected for reading, so no Etsy listing contributed to the customer context.');
    return [];
  }
  try {
    const outcome = await etsyListingDataTool.runEtsyListingDataTool({ businessId, limit: ETSY_SAMPLE_LIMIT });
    if (outcome.status === 'failed') {
      limitations.push(`Etsy listings could not be read: ${outcome.error}`);
      return [];
    }
    return asArray(outcome.result && outcome.result.listings)
      .map((entry) => entry.listing)
      .filter(Boolean)
      .map((listing) => ({
        channel: listing.channel || 'etsy',
        title: listing.title || null,
        category: null,
        tags: asArray(listing.tags),
        product_type: listing.listing_type || null,
        price: listing.price || null,
      }))
      .filter((entry) => entry.title);
  } catch (err) {
    limitations.push(`Etsy listings could not be read: ${err.message}`);
    return [];
  }
}

function readBusinessConfig(limitations) {
  try {
    return loadBusinessConfig(BUSINESS_CONFIG_PATH);
  } catch (err) {
    limitations.push(`configuration/business.yaml could not be read: ${err.message}`);
    return null;
  }
}

async function runCustomerMarketOpportunityTool(researchParams) {
  const params = researchParams && typeof researchParams === 'object' ? researchParams : {};
  const businessId = params.businessId || null;
  const limitations = [];

  try {
    const businessConfig = readBusinessConfig(limitations);

    // Both channels are read independently and neither can break the other.
    const [shopify, etsy] = await Promise.all([
      readShopifyCatalogue(businessId, limitations),
      readEtsyCatalogue(businessId, limitations),
    ]);
    const catalogue = shopify.concat(etsy);

    const result = await runCustomerMarketOpportunityResearch({
      businessConfig,
      catalogue,
      excludedCategories: asArray(params.excludedCategories),
      limit: Number.isFinite(Number(params.limit)) && Number(params.limit) > 0 ? Number(params.limit) : DEFAULT_TOP_LIMIT,
      discoveryBatches: params.discoveryBatches,
      shortlistSize: params.shortlistSize,
      businessId,
      tokensUsedThisRun: Number(params.tokensUsedThisRun) || 0,
    });

    // The tool's own retrieval limitations join the workflow's research limitations, so a
    // reader sees every reason this result is narrower than it could be.
    result.limitations = limitations.concat(asArray(result.limitations));

    // Real Claude usage from the run's batched web_search calls, surfaced at the TOP level
    // because that is where agent/core/orchestratorExecutionContract.js's runExecutor reads
    // it for a MODEL_CALL_TOOL_IDS entry. Without this the most expensive tool in the
    // project would be recorded in the usage ledger as a single flat tool call.
    const usage = (result.research_summary && result.research_summary.usage) || {};
    const usageFields = {
      model: usage.model || null,
      tokensUsed: usage.tokensUsed || 0,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
    };

    if (result.status === 'needs_information') {
      // Honestly 'empty', not 'failed': the pipeline ran correctly and its correct answer
      // is that this business's context does not establish a niche to research.
      return { status: 'empty', result, error: null, ...usageFields };
    }
    return { status: result.status === 'complete' ? 'success' : 'partial', result, error: null, ...usageFields };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { SHOPIFY_SAMPLE_LIMIT, ETSY_SAMPLE_LIMIT, readShopifyCatalogue, readEtsyCatalogue, runCustomerMarketOpportunityTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - customer_market_opportunity_research (read-only):\n');
  runCustomerMarketOpportunityTool({}).then((outcome) => {
    console.log(`Status: ${outcome.status}`);
    if (outcome.error) console.log(`Reported: ${outcome.error}`);
    if (outcome.result) {
      console.log(`Research status : ${outcome.result.status}`);
      console.log(`Primary market  : ${outcome.result.market_scope && outcome.result.market_scope.primary_market}`);
      console.log(`Candidates      : ${JSON.stringify(outcome.result.candidate_count)}`);
      console.log(`Top opportunities: ${outcome.result.top_opportunities.length}`);
      for (const item of outcome.result.top_opportunities) {
        console.log(`  ${item.rank}. ${item.product}  (fit ${item.scores.customer_fit}, coverage ${item.scores.evidence_coverage})`);
      }
      console.log('\nLimitations:');
      for (const item of outcome.result.limitations) console.log(`  - ${item}`);
    }
  });
}
