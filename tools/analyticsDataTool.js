'use strict';

// The analytics_data_retrieval tool (tools/toolRegistry.js). Read-only - it only
// retrieves live data from the connected Shopify store (orders, products, customers,
// inventory), never writes or changes anything. This is the "connect the Analytics
// Agent to available ecommerce data sources" tool: it calls
// integrations/adapters/shopifyClient.js's read-only getters, reshapes the results
// into actual_metrics and computes calculated_metrics/estimated_metrics via
// agent/core/analyticsMetricsCalculator.js, then calls straight into
// agent/core/analyticsAgent.js's existing capability functions - the same functions
// tools/analyticsTool.js calls with caller-supplied evidence. agent/core/ itself never
// depends on integrations/ or tools/ (see tools/productDataRetrievalTool.js's header
// for this project's standing rule) - that connection lives here instead.
//
// researchParams.analyticsCapability selects which capability to run - one of 'sales'
// (default), 'products', 'inventory', or 'customers'. Each pulls exactly the Shopify
// data that capability needs, nothing more (least-privilege, per CLAUDE.md section 3).
// 'conversion', 'traffic', 'marketing', 'advertising', and 'growth_opportunities'
// aren't backed by any Admin API data Shopify exposes read-only today, so they aren't
// offered here - use tools/analyticsTool.js with caller-supplied evidence for those.
//
// researchParams.limit (default 50) caps how many records are pulled per source -
// this is the read-only "first connection", not a full paginated ETL; a limitation
// always names the record count actually pulled so a capped result is never mistaken
// for a complete one.
//
// researchParams.periodDays, when supplied, is the number of days the pulled `sales`
// batch actually spans - required to compute
// estimated_metrics.projected_monthly_revenue
// (agent/core/analyticsMetricsCalculator.js's estimateProjectedMonthlyRevenue).
// Omitted entirely (no estimated_metrics) when periodDays isn't supplied - never
// guessed.
//
// researchParams.averageDailyUnitsSold, when supplied, is the caller's own assumed
// daily sell-through rate - required to compute
// estimated_metrics.estimated_days_of_inventory_remaining
// (estimateDaysOfInventoryRemaining). Omitted entirely when not supplied.
//
// 'customers' and 'inventory' both degrade gracefully and honestly: if the connected
// access token lacks the scope that source needs (read_customers, or read_locations/
// read_markets_home for inventory's per-location `location.name` field) - or any other
// Shopify error occurs - that source is reported as unavailable in limitations with the
// real error message, rather than throwing and failing the whole call. "customers where
// permitted" (see integrations/adapters/shopifyClient.js's header for what "permitted"
// means there: both API-scope permission and a privacy-conscious, non-PII-only field
// selection) and "inventory where permitted" follow the same reasoning: a real store's
// access token/app scopes are configured by its owner, outside this agent's control,
// so a missing optional scope for ONE source must never block every OTHER source's
// otherwise-successful analysis.
//
// Each retrieval attaches its own live-pull evidence citation (topic/finding/source)
// automatically when the caller doesn't supply one - the retrieved record count is
// real, verifiable evidence in its own right, distinct from a caller manually vouching
// for a claim. A caller-supplied `evidence` always takes precedence when present.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - Shopify isn't configured, researchParams is missing, or an
//                       unsupported analyticsCapability was requested
//   status 'empty'   - configured, but the live pull returned zero records
//   status 'partial' - the live pull succeeded but was degraded (e.g. customers denied)
//   status 'success' - the live pull returned at least one record

const shopifyClient = require('../integrations/adapters/shopifyClient');
const {
  calculateSalesMetrics,
  calculateProductMetrics,
  calculateInventoryMetrics,
  estimateProjectedMonthlyRevenue,
  estimateDaysOfInventoryRemaining,
} = require('../agent/core/analyticsMetricsCalculator');
const {
  analyzeSales,
  analyzeProducts,
  analyzeCustomers,
  analyzeInventory,
} = require('../agent/core/analyticsAgent');

// Reshapes one raw record into a compact actual_metrics entry - a plain relay of the
// fields integrations/adapters/shopifyClient.js already returns, no arithmetic.
function orderToActualMetric(order) {
  return { label: 'order', value: order.totalPrice, unit: order.currency, orderId: order.id, name: order.name, createdAt: order.createdAt };
}

function productToActualMetric(product) {
  return { label: 'product', value: product.title, status: product.status, id: product.id };
}

function inventoryItemToActualMetric(item) {
  const totalAvailable = (item.levels || []).reduce((sum, level) => {
    const available = typeof level.available === 'number' ? level.available : Number(level.available);
    return Number.isFinite(available) ? sum + available : sum;
  }, 0);
  return { label: 'inventory_item', sku: item.sku, id: item.id, available: totalAvailable };
}

function customerToActualMetric(customer) {
  return { label: 'customer', id: customer.id, ordersCount: customer.ordersCount, amountSpent: customer.amountSpent, unit: customer.currency };
}

// A live pull's own record count is real, verifiable evidence - built automatically
// so a successful pull isn't misreported as "no evidence was supplied" the way a
// caller who forgot to attach one manually would be. Never used when the caller
// supplied their own `evidence`.
function buildLivePullEvidence(kind, recordCount) {
  return [
    {
      topic: 'Shopify data pull',
      finding: `${recordCount} ${kind} record(s) retrieved live from the connected Shopify store.`,
      source: ['Shopify Admin API (read-only)'],
    },
  ];
}

async function retrieveSales(params) {
  const limit = params.limit || 50;
  const orders = await shopifyClient.getOrders({ limit, businessId: params.businessId });
  const actualMetrics = orders.map(orderToActualMetric);
  const calculatedMetrics = calculateSalesMetrics(orders);
  const estimatedMetrics = params.periodDays
    ? estimateProjectedMonthlyRevenue(orders, params.periodDays)
    : [];

  const result = analyzeSales({
    reportingPeriod: params.reportingPeriod || '',
    summary: params.summary || `${orders.length} order(s) retrieved from the connected Shopify store.`,
    actualMetrics,
    calculatedMetrics,
    estimatedMetrics,
    evidence: params.evidence || buildLivePullEvidence('order', orders.length),
    topic: params.topic,
    market: params.market,
    confidence: params.confidence,
    verificationStatus: params.verificationStatus,
    recommendations: params.recommendations,
  });
  result.limitations = [
    ...result.limitations,
    `Pulled ${orders.length} order(s) from Shopify (limit ${limit}, most recent first) - a capped read, not necessarily every order in the reporting period.`,
  ];
  return { result, recordCount: orders.length, degraded: false };
}

async function retrieveProducts(params) {
  const limit = params.limit || 50;
  const products = await shopifyClient.getProducts({ limit, businessId: params.businessId });
  const actualMetrics = products.map(productToActualMetric);
  const calculatedMetrics = calculateProductMetrics(products);

  const result = analyzeProducts({
    reportingPeriod: params.reportingPeriod || '',
    summary: params.summary || `${products.length} product(s) retrieved from the connected Shopify store.`,
    actualMetrics,
    calculatedMetrics,
    evidence: params.evidence || buildLivePullEvidence('product', products.length),
    topic: params.topic,
    market: params.market,
    confidence: params.confidence,
    verificationStatus: params.verificationStatus,
    recommendations: params.recommendations,
  });
  result.limitations = [
    ...result.limitations,
    `Pulled ${products.length} product(s) from Shopify (limit ${limit}) - a capped read, not necessarily the full catalog.`,
  ];
  return { result, recordCount: products.length, degraded: false };
}

// Deliberately DOES NOT throw on a Shopify error (e.g. missing read_locations/
// read_markets_home scope) - catches it and reports the category as
// degraded/unavailable instead, so one unauthorized source never fails an otherwise-
// successful multi-source analytics call. Same reasoning and shape as
// retrieveCustomers() above (see this file's header).
async function retrieveInventory(params) {
  const limit = params.limit || 50;
  let inventoryItems = [];
  let inventoryError = null;
  try {
    inventoryItems = await shopifyClient.getInventoryLevels({ limit, businessId: params.businessId });
  } catch (err) {
    inventoryError = err.message;
  }

  const actualMetrics = inventoryItems.map(inventoryItemToActualMetric);
  const calculatedMetrics = inventoryError ? [] : calculateInventoryMetrics(inventoryItems);
  const estimatedMetrics = !inventoryError && params.averageDailyUnitsSold
    ? estimateDaysOfInventoryRemaining(inventoryItems, params.averageDailyUnitsSold)
    : [];

  const result = analyzeInventory({
    reportingPeriod: params.reportingPeriod || '',
    summary: params.summary || (inventoryError
      ? 'Inventory data is unavailable for this store connection.'
      : `${inventoryItems.length} inventory item(s) retrieved from the connected Shopify store.`),
    actualMetrics,
    calculatedMetrics,
    estimatedMetrics,
    evidence: params.evidence || (inventoryError ? [] : buildLivePullEvidence('inventory item', inventoryItems.length)),
    topic: params.topic,
    market: params.market,
    confidence: params.confidence,
    verificationStatus: params.verificationStatus,
    recommendations: params.recommendations,
  });
  const limitations = inventoryError
    ? [`Inventory data could not be retrieved (not permitted or unavailable): ${inventoryError}`]
    : [`Pulled ${inventoryItems.length} inventory item(s) from Shopify (limit ${limit}) - a capped read, not necessarily the full catalog.`];
  result.limitations = [...result.limitations, ...limitations];
  return { result, recordCount: inventoryItems.length, degraded: Boolean(inventoryError) };
}

// Deliberately DOES NOT throw on a Shopify error (e.g. missing read_customers scope) -
// catches it and reports the category as degraded/unavailable instead, so one
// unauthorized source never fails an otherwise-successful multi-source analytics call.
// Only requests non-PII fields in the first place (see
// integrations/adapters/shopifyClient.js's getCustomers()).
async function retrieveCustomers(params) {
  const limit = params.limit || 50;
  let customers = [];
  let customersError = null;
  try {
    customers = await shopifyClient.getCustomers({ limit, businessId: params.businessId });
  } catch (err) {
    customersError = err.message;
  }

  const actualMetrics = customers.map(customerToActualMetric);
  const limitations = customersError
    ? [`Customer data could not be retrieved (not permitted or unavailable): ${customersError}`]
    : [`Pulled ${customers.length} customer(s) from Shopify (limit ${limit}), non-PII fields only (no name/email/phone/address) - a capped read, not necessarily every customer.`];

  const result = analyzeCustomers({
    reportingPeriod: params.reportingPeriod || '',
    summary: params.summary || (customersError
      ? 'Customer data is unavailable for this store connection.'
      : `${customers.length} customer(s) retrieved from the connected Shopify store.`),
    actualMetrics,
    evidence: params.evidence || (customersError ? [] : buildLivePullEvidence('customer', customers.length)),
    topic: params.topic,
    market: params.market,
    confidence: params.confidence,
    verificationStatus: params.verificationStatus,
    recommendations: params.recommendations,
  });
  result.limitations = [...result.limitations, ...limitations];
  return { result, recordCount: customers.length, degraded: Boolean(customersError) };
}

const CAPABILITY_RETRIEVERS = {
  sales: retrieveSales,
  products: retrieveProducts,
  customers: retrieveCustomers,
  inventory: retrieveInventory,
};

async function runAnalyticsDataTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - analytics_data_retrieval requires structured parameters (e.g. analyticsCapability, limit) that a free-text objective cannot provide.',
    };
  }

  const { analyticsCapability = 'sales', ...params } = researchParams;
  const retriever = CAPABILITY_RETRIEVERS[analyticsCapability];
  if (!retriever) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown or unsupported analyticsCapability for live data retrieval: ${analyticsCapability}. Must be one of: ${Object.keys(CAPABILITY_RETRIEVERS).join(', ')} (for other capabilities, use tools/analyticsTool.js with caller-supplied evidence).`,
    };
  }

  const businessId = researchParams.businessId || null;
  if (!shopifyClient.isConfigured({ businessId })) {
    return {
      status: 'failed',
      result: null,
      error:
        'SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_API_ACCESS_TOKEN are not set - the Analytics Agent cannot connect to a live data source until the store is configured (see .env.example).',
    };
  }

  try {
    const { result, recordCount, degraded } = await retriever(params);
    let status = 'success';
    if (degraded) status = 'partial';
    else if (recordCount === 0) status = 'empty';
    return { status, result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runAnalyticsDataTool };

if (require.main === module) {
  shopifyClient.loadEnvOnce();
  console.log('Smart E-Commerce Growth AI Agent - analytics_data_retrieval tool (read-only, live Shopify data):\n');

  if (!shopifyClient.isConfigured()) {
    console.log('Store credentials are not set - showing the honest not-configured outcome only.');
    console.log('Copy .env.example to .env and fill in:');
    console.log('  SHOPIFY_STORE_DOMAIN=your-store.myshopify.com');
    console.log('  SHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_...');
    runAnalyticsDataTool({ analyticsCapability: 'sales' }).then((outcome) => {
      console.log(`\n--- sales (not configured) -> status: ${outcome.status} ---`);
      console.log(`  error: ${outcome.error}`);
    });
  } else {
    (async () => {
      const cases = {
        'sales (live)': { analyticsCapability: 'sales', limit: 5, periodDays: 7 },
        'products (live)': { analyticsCapability: 'products', limit: 5 },
        'customers (live)': { analyticsCapability: 'customers', limit: 5 },
        'inventory (live)': { analyticsCapability: 'inventory', limit: 5, averageDailyUnitsSold: 2 },
      };
      for (const [label, researchParams] of Object.entries(cases)) {
        const outcome = await runAnalyticsDataTool(researchParams);
        console.log(`--- ${label} -> status: ${outcome.status} ---`);
        if (outcome.error) console.log(`  error: ${outcome.error}`);
        if (outcome.result) console.log(JSON.stringify(outcome.result, null, 2));
        console.log('');
      }
      console.log('Every actual_metrics entry above is real, live store data - calculated_metrics is mechanical arithmetic over it, and estimated_metrics states its own assumption explicitly.');
    })();
  }
}
