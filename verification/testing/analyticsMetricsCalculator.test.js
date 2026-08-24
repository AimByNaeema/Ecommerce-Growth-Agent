'use strict';

const assert = require('node:assert');
const {
  calculateSalesMetrics,
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
