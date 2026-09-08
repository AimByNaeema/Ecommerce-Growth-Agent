'use strict';

const assert = require('node:assert');
const {
  calculateSalesMetrics,
  calculateSalesTrend,
  calculateTopProductsBySales,
  calculateProductMetrics,
  calculateInventoryMetrics,
  estimateProjectedMonthlyRevenue,
  estimateDaysOfInventoryRemaining,
} = require('../../agent/core/analyticsMetricsCalculator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

function findMetric(metrics, label) {
  return metrics.find((m) => m.label === label);
}

// --- calculateSalesMetrics -----------------------------------------------------------

test('calculateSalesMetrics computes orders_count, total_revenue, and average_order_value from actual orders', () => {
  const metrics = calculateSalesMetrics([
    { totalPrice: '89.00', currency: 'USD' },
    { totalPrice: '64.00', currency: 'USD' },
  ]);
  assert.strictEqual(findMetric(metrics, 'orders_count').value, 2);
  assert.strictEqual(findMetric(metrics, 'total_revenue').value, 153);
  assert.strictEqual(findMetric(metrics, 'total_revenue').unit, 'USD');
  assert.strictEqual(findMetric(metrics, 'average_order_value').value, 76.5);
});

test('calculateSalesMetrics returns an empty array for no orders, never a fabricated zero', () => {
  assert.deepStrictEqual(calculateSalesMetrics([]), []);
  assert.deepStrictEqual(calculateSalesMetrics(), []);
});

test('calculateSalesMetrics skips an order with a non-numeric totalPrice rather than fabricating a total', () => {
  const metrics = calculateSalesMetrics([
    { totalPrice: '89.00', currency: 'USD' },
    { totalPrice: 'not-a-number', currency: 'USD' },
  ]);
  assert.strictEqual(findMetric(metrics, 'orders_count').value, 2);
  assert.strictEqual(findMetric(metrics, 'total_revenue').value, 89);
});

test('calculateSalesMetrics reports each currency total separately for a mixed-currency batch, and omits average_order_value (ambiguous across currencies)', () => {
  const metrics = calculateSalesMetrics([
    { totalPrice: '89.00', currency: 'USD' },
    { totalPrice: '75.00', currency: 'EUR' },
  ]);
  const revenueMetrics = metrics.filter((m) => m.label === 'total_revenue');
  assert.strictEqual(revenueMetrics.length, 2);
  assert.ok(revenueMetrics.some((m) => m.unit === 'USD' && m.value === 89));
  assert.ok(revenueMetrics.some((m) => m.unit === 'EUR' && m.value === 75));
  assert.strictEqual(findMetric(metrics, 'average_order_value'), undefined);
});

// --- calculateProductMetrics ----------------------------------------------------------

test('calculateProductMetrics computes products_count, active_products_count, variants_count, out_of_stock_variants_count', () => {
  const metrics = calculateProductMetrics([
    { status: 'ACTIVE', variants: [{ inventoryQuantity: 0 }, { inventoryQuantity: 5 }] },
    { status: 'ARCHIVED', variants: [{ inventoryQuantity: 2 }] },
  ]);
  assert.strictEqual(findMetric(metrics, 'products_count').value, 2);
  assert.strictEqual(findMetric(metrics, 'active_products_count').value, 1);
  assert.strictEqual(findMetric(metrics, 'variants_count').value, 3);
  assert.strictEqual(findMetric(metrics, 'out_of_stock_variants_count').value, 1);
});

test('calculateProductMetrics returns an empty array for no products', () => {
  assert.deepStrictEqual(calculateProductMetrics([]), []);
});

// --- calculateInventoryMetrics ---------------------------------------------------------

test('calculateInventoryMetrics computes tracked_items_count, total_available_units, out_of_stock_items_count', () => {
  const metrics = calculateInventoryMetrics([
    { tracked: true, levels: [{ available: 5 }, { available: 0 }] },
    { tracked: true, levels: [{ available: 0 }] },
    { tracked: false, levels: [{ available: 3 }] },
  ]);
  assert.strictEqual(findMetric(metrics, 'tracked_items_count').value, 2);
  assert.strictEqual(findMetric(metrics, 'total_available_units').value, 8);
  assert.strictEqual(findMetric(metrics, 'out_of_stock_items_count').value, 1);
});

test('calculateInventoryMetrics omits total_available_units/out_of_stock_items_count when no level has a known available quantity', () => {
  const metrics = calculateInventoryMetrics([{ tracked: true, levels: [{ available: undefined }] }]);
  assert.strictEqual(findMetric(metrics, 'tracked_items_count').value, 1);
  assert.strictEqual(findMetric(metrics, 'total_available_units'), undefined);
  assert.strictEqual(findMetric(metrics, 'out_of_stock_items_count'), undefined);
});

test('calculateInventoryMetrics returns an empty array for no inventory items', () => {
  assert.deepStrictEqual(calculateInventoryMetrics([]), []);
});

// --- estimateProjectedMonthlyRevenue ---------------------------------------------------

test('estimateProjectedMonthlyRevenue projects revenue to 30 days and states its assumption', () => {
  const estimates = estimateProjectedMonthlyRevenue(
    [{ totalPrice: '70.00', currency: 'USD' }],
    7
  );
  assert.strictEqual(estimates.length, 1);
  assert.strictEqual(estimates[0].label, 'projected_monthly_revenue');
  assert.strictEqual(estimates[0].value, 300);
  assert.strictEqual(estimates[0].unit, 'USD');
  assert.ok(typeof estimates[0].assumption === 'string' && estimates[0].assumption.length > 0);
});

test('estimateProjectedMonthlyRevenue is omitted entirely when periodDays is not supplied - never guessed', () => {
  assert.deepStrictEqual(estimateProjectedMonthlyRevenue([{ totalPrice: '70.00', currency: 'USD' }]), []);
  assert.deepStrictEqual(estimateProjectedMonthlyRevenue([{ totalPrice: '70.00', currency: 'USD' }], 0), []);
  assert.deepStrictEqual(estimateProjectedMonthlyRevenue([{ totalPrice: '70.00', currency: 'USD' }], -3), []);
});

// --- estimateDaysOfInventoryRemaining ---------------------------------------------------

test('estimateDaysOfInventoryRemaining divides total available units by the caller-supplied assumed daily rate, and states its assumption', () => {
  const estimates = estimateDaysOfInventoryRemaining(
    [{ tracked: true, levels: [{ available: 20 }] }],
    5
  );
  assert.strictEqual(estimates.length, 1);
  assert.strictEqual(estimates[0].label, 'estimated_days_of_inventory_remaining');
  assert.strictEqual(estimates[0].value, 4);
  assert.ok(typeof estimates[0].assumption === 'string' && estimates[0].assumption.length > 0);
});

test('estimateDaysOfInventoryRemaining is omitted entirely when averageDailyUnitsSold is not a positive number - never guessed', () => {
  const inventoryItems = [{ tracked: true, levels: [{ available: 20 }] }];
  assert.deepStrictEqual(estimateDaysOfInventoryRemaining(inventoryItems), []);
  assert.deepStrictEqual(estimateDaysOfInventoryRemaining(inventoryItems, 0), []);
  assert.deepStrictEqual(estimateDaysOfInventoryRemaining(inventoryItems, -1), []);
});

test('estimateDaysOfInventoryRemaining is omitted when total_available_units itself cannot be calculated', () => {
  assert.deepStrictEqual(estimateDaysOfInventoryRemaining([], 5), []);
});


// --- calculateSalesTrend -------------------------------------------------------------
// The pure time-bucketing behind the dashboard's Performance charts (see server.js's
// buildTrends and public/dashboard.js's renderPerformance). Every assertion below exists
// to pin the one property that matters most for those charts: a point is only ever drawn
// from an order that genuinely exists in the supplied array.

test('calculateSalesTrend returns null - never an empty chart - when nothing usable was supplied', () => {
  assert.strictEqual(calculateSalesTrend([]), null);
  assert.strictEqual(calculateSalesTrend(null), null);
  assert.strictEqual(calculateSalesTrend(undefined), null);
  // Unparseable date and non-numeric price are both skipped, leaving nothing to plot.
  assert.strictEqual(calculateSalesTrend([{ totalPrice: 'abc', currency: 'USD', createdAt: 'not-a-date' }]), null);
  assert.strictEqual(calculateSalesTrend([{ totalPrice: '5.00', currency: 'USD', createdAt: 'not-a-date' }]), null);
  assert.strictEqual(calculateSalesTrend([{ totalPrice: 'abc', currency: 'USD', createdAt: '2026-01-01T00:00:00Z' }]), null);
});

test('calculateSalesTrend buckets real orders by day and sums only what they contain', () => {
  const trend = calculateSalesTrend([
    { totalPrice: '2.00', currency: 'USD', createdAt: '2026-03-01T09:00:00Z' },
    { totalPrice: '3.00', currency: 'USD', createdAt: '2026-03-01T18:30:00Z' },
    { totalPrice: '4.00', currency: 'USD', createdAt: '2026-03-03T10:00:00Z' },
  ]);
  assert.strictEqual(trend.granularity, 'day');
  assert.strictEqual(trend.currency, 'USD');
  assert.strictEqual(trend.order_count, 3);
  assert.strictEqual(trend.points.length, 3);
  assert.deepStrictEqual(
    trend.points.map((p) => [p.bucket_start.slice(0, 10), p.revenue, p.orders]),
    [
      ['2026-03-01', 5, 2],
      // A day with no order inside the real range is a genuine zero, not a gap the chart
      // silently closes - and it is never confused with "we have no data for this day".
      ['2026-03-02', 0, 0],
      ['2026-03-03', 4, 1],
    ]
  );
  // Bucket revenue must reconcile exactly with the flat total the metric tiles show.
  const summed = trend.points.reduce((total, p) => total + p.revenue, 0);
  assert.strictEqual(summed, 9);
});

test('calculateSalesTrend reports the range the ORDERS actually cover, never an assumed period', () => {
  const trend = calculateSalesTrend([
    { totalPrice: '1.00', currency: 'USD', createdAt: '2026-03-05T23:59:00Z' },
    { totalPrice: '1.00', currency: 'USD', createdAt: '2026-03-01T00:00:01Z' },
  ]);
  assert.strictEqual(trend.range.from, '2026-03-01T00:00:01.000Z');
  assert.strictEqual(trend.range.to, '2026-03-05T23:59:00.000Z');
});

test('calculateSalesTrend derives granularity from the real span, and honors an explicit one', () => {
  const spanning = (fromIso, toIso) => [
    { totalPrice: '1.00', currency: 'USD', createdAt: fromIso },
    { totalPrice: '1.00', currency: 'USD', createdAt: toIso },
  ];
  assert.strictEqual(calculateSalesTrend(spanning('2026-03-01T00:00:00Z', '2026-03-20T00:00:00Z')).granularity, 'day');
  assert.strictEqual(calculateSalesTrend(spanning('2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z')).granularity, 'week');
  assert.strictEqual(calculateSalesTrend(spanning('2025-01-01T00:00:00Z', '2026-06-01T00:00:00Z')).granularity, 'month');
  // An explicit granularity wins over the derived one.
  assert.strictEqual(
    calculateSalesTrend(spanning('2026-03-01T00:00:00Z', '2026-03-05T00:00:00Z'), { granularity: 'month' }).granularity,
    'month'
  );
});

test('calculateSalesTrend never sums incompatible currencies into one line', () => {
  const trend = calculateSalesTrend([
    { totalPrice: '10.00', currency: 'USD', createdAt: '2026-03-01T00:00:00Z' },
    { totalPrice: '20.00', currency: 'USD', createdAt: '2026-03-02T00:00:00Z' },
    { totalPrice: '999.00', currency: 'GBP', createdAt: '2026-03-01T00:00:00Z' },
  ]);
  // The most-represented currency carries the line; the other is named, not folded in.
  assert.strictEqual(trend.currency, 'USD');
  assert.deepStrictEqual(trend.ignored_currencies, ['GBP']);
  assert.strictEqual(trend.order_count, 2);
  assert.strictEqual(
    trend.points.reduce((total, p) => total + p.revenue, 0),
    30,
    'the GBP order must not appear in the USD trend total'
  );
});

test('calculateSalesTrend treats a genuine zero-revenue order as an order, not as missing data', () => {
  // Real case for this store: free-product orders are 0.00 but are still real orders.
  const trend = calculateSalesTrend([
    { totalPrice: '0.00', currency: 'USD', createdAt: '2026-03-01T09:00:00Z' },
    { totalPrice: '0.00', currency: 'USD', createdAt: '2026-03-01T10:00:00Z' },
  ]);
  assert.strictEqual(trend.points.length, 1);
  assert.strictEqual(trend.points[0].revenue, 0);
  assert.strictEqual(trend.points[0].orders, 2);
  assert.strictEqual(trend.order_count, 2);
});

test('calculateSalesTrend skips an unusable order without discarding the usable ones', () => {
  const trend = calculateSalesTrend([
    { totalPrice: '5.00', currency: 'USD', createdAt: '2026-03-01T00:00:00Z' },
    { totalPrice: null, currency: 'USD', createdAt: '2026-03-01T01:00:00Z' },
    { totalPrice: '7.00', currency: 'USD', createdAt: 'garbage' },
    null,
  ]);
  assert.strictEqual(trend.order_count, 1);
  assert.strictEqual(trend.points[0].revenue, 5);
  assert.strictEqual(trend.points[0].orders, 1);
});


// --- calculateTopProductsBySales ------------------------------------------------------
// Backs the dashboard's Top Products table (see server.js's buildTopProducts). Counts
// only - no ranking model, no score, and nothing derived that the line items do not
// literally contain.

test('calculateTopProductsBySales returns [] - never a placeholder row - when nothing is usable', () => {
  assert.deepStrictEqual(calculateTopProductsBySales([]), []);
  assert.deepStrictEqual(calculateTopProductsBySales(null), []);
  assert.deepStrictEqual(calculateTopProductsBySales([{ lineItems: [] }]), []);
  assert.deepStrictEqual(calculateTopProductsBySales([{ lineItems: [{ title: '', quantity: 3 }] }]), []);
  assert.deepStrictEqual(calculateTopProductsBySales([{ lineItems: [{ title: 'X', quantity: 'not-a-number' }] }]), []);
});

test('calculateTopProductsBySales counts units and orders exactly as the line items state them', () => {
  const ranked = calculateTopProductsBySales([
    { lineItems: [{ title: 'Halloween SVG', quantity: 2, sku: 'H1' }, { title: 'Ghost PNG', quantity: 1, sku: 'G1' }] },
    { lineItems: [{ title: 'Halloween SVG', quantity: 3, sku: 'H1' }] },
  ]);
  assert.deepStrictEqual(ranked, [
    { title: 'Halloween SVG', sku: 'H1', units: 5, orders: 2 },
    { title: 'Ghost PNG', sku: 'G1', units: 1, orders: 1 },
  ]);
});

test('calculateTopProductsBySales excludes Shopify test orders, which are not real sales', () => {
  const ranked = calculateTopProductsBySales([
    { test: true, lineItems: [{ title: 'Gateway Test Bundle', quantity: 99, sku: 'T' }] },
    { test: false, lineItems: [{ title: 'Real Bundle', quantity: 1, sku: 'R' }] },
  ]);
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].title, 'Real Bundle');
});

test('calculateTopProductsBySales never reports a revenue field - line items carry no price', () => {
  const ranked = calculateTopProductsBySales([{ lineItems: [{ title: 'A', quantity: 1 }] }]);
  assert.ok(!('revenue' in ranked[0]), 'per-product revenue must be absent, not apportioned from the order total');
  assert.deepStrictEqual(Object.keys(ranked[0]).sort(), ['orders', 'sku', 'title', 'units']);
});

test('calculateTopProductsBySales honors the limit and orders results deterministically', () => {
  const orders = [
    { lineItems: [{ title: 'B', quantity: 5 }, { title: 'A', quantity: 5 }, { title: 'C', quantity: 9 }] },
  ];
  const ranked = calculateTopProductsBySales(orders, { limit: 2 });
  assert.strictEqual(ranked.length, 2);
  assert.strictEqual(ranked[0].title, 'C');
  // A and B tie on units and orders, so the tie breaks on title - a stable list, never a
  // shuffling one between reloads.
  assert.strictEqual(ranked[1].title, 'A');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
