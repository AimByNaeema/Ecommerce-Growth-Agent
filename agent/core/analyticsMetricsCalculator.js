'use strict';

// Pure calculation logic for agent/core/analyticsModel.js's `calculated_metrics` and
// `estimated_metrics` category fields. Deterministic only - no fetch, no live data
// pull (that lives in integrations/adapters/shopifyClient.js, reached through
// tools/analyticsDataTool.js). This module only ever does arithmetic over an
// already-retrieved (or caller-supplied) array of plain order/product/inventory
// objects - it is Shopify-agnostic, matching agent/core/ 's standing rule that it
// never depends on integrations/ or tools/ (see tools/productDataRetrievalTool.js's
// header for this project's precedent).
//
// Two distinct kinds of output, never blurred together (see
// agent/core/analyticsModel.js's own header for the full taxonomy):
//   - calculate*() functions: mechanical arithmetic over the actual data supplied -
//     e.g. total_revenue = sum of every order's totalPrice. Only as complete as the
//     actual array passed in; a capped/paginated pull may undercount, so
//     tools/analyticsDataTool.js always attaches a limitation noting the record count
//     pulled - this module itself makes no claim about completeness.
//   - estimate*() functions: additionally require an assumption or extrapolation
//     beyond the literal calculated data (e.g. projecting a partial period's revenue
//     out to a month, or dividing current stock by an assumed daily sell-through
//     rate). The assumption itself (periodDays, averageDailyUnitsSold) is always a
//     caller-supplied argument - never invented internally - and the returned object
//     always carries an `assumption` string explaining it, so an estimate is never
//     silently mistaken for a calculated fact.
//
// Never fabricates a result: a function only returns a field when every input it
// needs is present as a finite, non-negative number (with a strictly-positive
// denominator where division is involved) - otherwise that field is simply omitted,
// never defaulted to 0/null/NaN, the same discipline
// agent/core/advertisingPerformanceCalculator.js already established.

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveDenominator(value) {
  return isFiniteNonNegativeNumber(value) && value > 0;
}

function toNumber(value) {
  const num = typeof value === 'string' ? Number(value) : value;
  return typeof num === 'number' && Number.isFinite(num) ? num : undefined;
}

// Rounds to a fixed precision to avoid floating-point noise - a formatting convention
// only, never a business rounding rule.
const RESULT_PRECISION = 2;
function round(value) {
  return Math.round(value * 10 ** RESULT_PRECISION) / 10 ** RESULT_PRECISION;
}

// Sums every order's totalPrice into a single currency bucket. Orders whose totalPrice
// isn't a finite non-negative number are skipped (never fabricated), and a mixed-
// currency batch reports each currency's own total separately rather than silently
// summing incompatible currencies together.
function sumRevenueByCurrency(orders) {
  const totals = {};
  for (const order of orders) {
    const amount = toNumber(order.totalPrice);
    const currency = order.currency || '(unknown currency)';
    if (!isFiniteNonNegativeNumber(amount)) continue;
    totals[currency] = (totals[currency] || 0) + amount;
  }
  return totals;
}

// calculated_metrics for the `sales` category, from an array of orders shaped like
// integrations/adapters/shopifyClient.js's getOrders() output (or any caller-supplied
// object with the same fields). Only computes what the supplied orders allow.
function calculateSalesMetrics(orders = []) {
  const metrics = [];
  if (!Array.isArray(orders) || orders.length === 0) return metrics;

  metrics.push({ label: 'orders_count', value: orders.length });

  const revenueByCurrency = sumRevenueByCurrency(orders);
  for (const [currency, total] of Object.entries(revenueByCurrency)) {
    metrics.push({ label: 'total_revenue', value: round(total), unit: currency });
  }

  const currencies = Object.keys(revenueByCurrency);
  if (currencies.length === 1) {
    const totalRevenue = revenueByCurrency[currencies[0]];
    if (isPositiveDenominator(orders.length)) {
      metrics.push({ label: 'average_order_value', value: round(totalRevenue / orders.length), unit: currencies[0] });
    }
  }

  return metrics;
}

// calculated_metrics for the `product_performance` category, from an array of
// products shaped like integrations/adapters/shopifyClient.js's getProducts() output.
function calculateProductMetrics(products = []) {
  const metrics = [];
  if (!Array.isArray(products) || products.length === 0) return metrics;

  metrics.push({ label: 'products_count', value: products.length });

  const activeCount = products.filter((product) => product.status === 'ACTIVE').length;
  metrics.push({ label: 'active_products_count', value: activeCount });

  const allVariants = products.flatMap((product) => (Array.isArray(product.variants) ? product.variants : []));
  const outOfStockVariantCount = allVariants.filter(
    (variant) => isFiniteNonNegativeNumber(toNumber(variant.inventoryQuantity)) && toNumber(variant.inventoryQuantity) === 0
  ).length;
  if (allVariants.length > 0) {
    metrics.push({ label: 'variants_count', value: allVariants.length });
    metrics.push({ label: 'out_of_stock_variants_count', value: outOfStockVariantCount });
  }

  return metrics;
}

// calculated_metrics for the `inventory` category, from an array of inventory items
// shaped like integrations/adapters/shopifyClient.js's getInventoryLevels() output.
function calculateInventoryMetrics(inventoryItems = []) {
  const metrics = [];
  if (!Array.isArray(inventoryItems) || inventoryItems.length === 0) return metrics;

  metrics.push({ label: 'tracked_items_count', value: inventoryItems.filter((item) => item.tracked).length });

  let totalAvailable = 0;
  let anyAvailableFound = false;
  let outOfStockItemCount = 0;
  for (const item of inventoryItems) {
    const levels = Array.isArray(item.levels) ? item.levels : [];
    const itemAvailable = levels.reduce((sum, level) => {
      const available = toNumber(level.available);
      return isFiniteNonNegativeNumber(available) ? sum + available : sum;
    }, 0);
    const hasKnownAvailability = levels.some((level) => isFiniteNonNegativeNumber(toNumber(level.available)));
    if (hasKnownAvailability) {
      anyAvailableFound = true;
      totalAvailable += itemAvailable;
      if (itemAvailable === 0) outOfStockItemCount += 1;
    }
  }
  if (anyAvailableFound) {
    metrics.push({ label: 'total_available_units', value: totalAvailable });
    metrics.push({ label: 'out_of_stock_items_count', value: outOfStockItemCount });
  }

  return metrics;
}

// estimated_metrics for the `sales` category: projects the actual revenue observed
// over `periodDays` out to a 30-day month, assuming a steady sales rate. `periodDays`
// is always caller-supplied (the number of days the retrieved `orders` batch actually
// spans) - never invented here. Omitted entirely when periodDays isn't a positive
// number or no revenue could be calculated.
function estimateProjectedMonthlyRevenue(orders = [], periodDays) {
  const metrics = [];
  const days = toNumber(periodDays);
  if (!isPositiveDenominator(days)) return metrics;

  const revenueByCurrency = sumRevenueByCurrency(Array.isArray(orders) ? orders : []);
  for (const [currency, total] of Object.entries(revenueByCurrency)) {
    metrics.push({
      label: 'projected_monthly_revenue',
      value: round((total / days) * 30),
      unit: currency,
      assumption: `Projected from ${round(total)} ${currency} of actual revenue observed over ${days} day(s), assuming the sales rate holds steady across a 30-day month.`,
    });
  }
  return metrics;
}

// estimated_metrics for the `inventory` category: divides total available units by an
// assumed average daily units sold to estimate how many days of stock remain.
// `averageDailyUnitsSold` is always caller-supplied - never invented here (a caller may
// derive it from calculateSalesMetrics()/getOrders() line items over a known period,
// but that derivation is the caller's own responsibility, not this function's).
// Omitted entirely when averageDailyUnitsSold isn't a positive number or total
// available units can't be calculated.
function estimateDaysOfInventoryRemaining(inventoryItems = [], averageDailyUnitsSold) {
  const rate = toNumber(averageDailyUnitsSold);
  if (!isPositiveDenominator(rate)) return [];

  const calculated = calculateInventoryMetrics(inventoryItems);
  const totalAvailableMetric = calculated.find((metric) => metric.label === 'total_available_units');
  if (!totalAvailableMetric) return [];

  return [
    {
      label: 'estimated_days_of_inventory_remaining',
      value: round(totalAvailableMetric.value / rate),
      assumption: `Estimated from ${totalAvailableMetric.value} available unit(s) divided by an assumed average of ${rate} unit(s) sold per day - actual depletion will vary with demand.`,
    },
  ];
}

module.exports = {
  calculateSalesMetrics,
  calculateProductMetrics,
  calculateInventoryMetrics,
  estimateProjectedMonthlyRevenue,
  estimateDaysOfInventoryRemaining,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - analytics metrics calculator (deterministic, mechanical formulas only):\n');

  const sampleOrders = [
    { totalPrice: '89.00', currency: 'USD' },
    { totalPrice: '64.00', currency: 'USD' },
    { totalPrice: 'not-a-number', currency: 'USD' },
  ];
  console.log('--- calculateSalesMetrics ---');
  console.log(JSON.stringify(calculateSalesMetrics(sampleOrders), null, 2));

  console.log('\n--- estimateProjectedMonthlyRevenue (7-day period) ---');
  console.log(JSON.stringify(estimateProjectedMonthlyRevenue(sampleOrders, 7), null, 2));

  const sampleProducts = [
    { status: 'ACTIVE', variants: [{ inventoryQuantity: 0 }, { inventoryQuantity: 5 }] },
    { status: 'ARCHIVED', variants: [{ inventoryQuantity: 2 }] },
  ];
  console.log('\n--- calculateProductMetrics ---');
  console.log(JSON.stringify(calculateProductMetrics(sampleProducts), null, 2));

  const sampleInventoryItems = [
    { tracked: true, levels: [{ available: 5 }, { available: 0 }] },
    { tracked: true, levels: [{ available: 0 }] },
  ];
  console.log('\n--- calculateInventoryMetrics ---');
  console.log(JSON.stringify(calculateInventoryMetrics(sampleInventoryItems), null, 2));

  console.log('\n--- estimateDaysOfInventoryRemaining (assumed 2 units/day) ---');
  console.log(JSON.stringify(estimateDaysOfInventoryRemaining(sampleInventoryItems, 2), null, 2));

  console.log('\nNo value above is fabricated - every calculated value is mechanical arithmetic over the supplied data, and every estimated value states its own assumption explicitly.');
}
