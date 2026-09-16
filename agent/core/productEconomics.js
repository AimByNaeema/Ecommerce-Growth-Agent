'use strict';

// PRODUCT UNIT ECONOMICS - deterministic arithmetic over real inputs, with UNKNOWN kept UNKNOWN.
//
// WHY THIS EXISTS: the product specialist could read a selling price but nothing computed what a sale is worth.
// agent/core/offerRecommendationEngine.js computes one margin inline for a discount ceiling from caller-supplied
// constraints; this module is the general calculation the Product specialist attaches to real store data.
//
// THE RULES (never relaxed):
//   - a selling price is not profit;
//   - a missing cost is not a zero cost, a missing fee is not a zero fee, a missing shipping cost is not free
//     shipping - each makes every figure that depends on it UNKNOWN (value null), with the missing input named;
//   - a missing currency is not an assumed currency, and two different currencies are never combined unless the
//     caller supplies an explicit exchange rate for that exact pair;
//   - nothing here reads a network, a model or a default price list. It computes; it never estimates.
//
// Money is { amount, currency }. Amounts may be numbers or decimal strings as Shopify returns them ("89.00").

const KNOWN = 'KNOWN';
const UNKNOWN = 'UNKNOWN';

// Words that ask about what a sale is worth - used by the Chief's product read to decide whether unit costs are read.
const ECONOMICS_INTENT = /\b(?:profit(?:s|able|ability)?|margins?|unit\s+costs?|costs?\s+of\s+goods|cogs|landed\s+costs?|roi|return\s+on\s+investment|contribution|unit\s+economics|break[\s-]?even)\b/i;

function hasEconomicsIntent(text) {
  return ECONOMICS_INTENT.test(String(text || ''));
}

function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function parseCurrency(value) {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

// A usable money value, or null with the reason it is not usable.
function readMoney(money, label) {
  if (!money || typeof money !== 'object') return { money: null, missing: `${label} (not available)` };
  const amount = parseAmount(money.amount);
  if (amount === null) return { money: null, missing: `${label} amount (not available or not a valid amount)` };
  const currency = parseCurrency(money.currency);
  if (!currency) return { money: null, missing: `${label} currency (not available - never assumed)` };
  return { money: { amount, currency }, missing: null };
}

// Converts only with a caller-supplied rate for this exact pair ("EUR->USD": 1.08). No rate, no conversion.
function toCurrency(money, currency, exchangeRates, label) {
  if (money.currency === currency) return { amount: money.amount, missing: null, converted: null };
  const rate = exchangeRates && typeof exchangeRates === 'object' ? parseAmount(exchangeRates[`${money.currency}->${currency}`]) : null;
  if (rate === null || rate === 0) {
    return { amount: null, missing: `${label} is in ${money.currency} but the price is in ${currency}, and no ${money.currency}->${currency} exchange rate was supplied`, converted: null };
  }
  return { amount: money.amount * rate, missing: null, converted: { from: money.currency, to: currency, rate } };
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function metric(value, missing, rule) {
  const gaps = missing.filter(Boolean);
  if (gaps.length > 0 || value === null || !Number.isFinite(value)) {
    return { value: null, status: UNKNOWN, missing_inputs: [...new Set(gaps)], rule };
  }
  return { value: round(value), status: KNOWN, missing_inputs: [], rule };
}

// fees: null/undefined = UNKNOWN (never zero). An array lists every fee on one sale:
//   { name, type: 'percent', value: 2.9 } (of the selling price) or { name, type: 'fixed', amount, currency }.
// An empty array is accepted only with feesConfirmedNone: true - "no fees" is a fact someone must state.
function resolveFees({ fees, feesConfirmedNone, price, exchangeRates }) {
  if (fees === null || fees === undefined) return { total: null, missing: ['selling fees (payment, platform or marketplace fees were not supplied)'], items: [], converted: [] };
  if (!Array.isArray(fees)) return { total: null, missing: ['selling fees (not a list)'], items: [], converted: [] };
  if (fees.length === 0 && feesConfirmedNone !== true) {
    return { total: null, missing: ['selling fees (an empty fee list is not treated as zero fees unless confirmed)'], items: [], converted: [] };
  }
  let total = 0;
  const missing = [];
  const items = [];
  const converted = [];
  for (const fee of fees) {
    const name = fee && typeof fee.name === 'string' && fee.name.trim() ? fee.name.trim() : 'unnamed fee';
    if (fee && fee.type === 'percent') {
      const percent = parseAmount(fee.value);
      if (percent === null) { missing.push(`${name} percentage`); continue; }
      const amount = price.amount * (percent / 100);
      total += amount;
      items.push({ name, type: 'percent', percent, amount: round(amount), currency: price.currency });
    } else if (fee && fee.type === 'fixed') {
      const read = readMoney({ amount: fee.amount, currency: fee.currency }, name);
      if (!read.money) { missing.push(read.missing); continue; }
      const inPrice = toCurrency(read.money, price.currency, exchangeRates, name);
      if (inPrice.amount === null) { missing.push(inPrice.missing); continue; }
      if (inPrice.converted) converted.push({ input: name, ...inPrice.converted });
      total += inPrice.amount;
      items.push({ name, type: 'fixed', amount: round(inPrice.amount), currency: price.currency });
    } else {
      missing.push(`${name} (fee type must be 'percent' or 'fixed')`);
    }
  }
  return { total: missing.length > 0 ? null : total, missing, items, converted };
}

// One unit sold at `price`. Every figure is KNOWN with a value, or UNKNOWN with value null and the inputs it lacks.
//   gross_profit              = price - unit cost
//   gross_margin_percent      = gross profit / price
//   landed_cost               = unit cost + inbound shipping (+ duties, when supplied)
//   total_fees                = sum of supplied fees
//   contribution              = price - landed cost - fees - outbound shipping (when supplied)
//   contribution_margin_percent = contribution / price
//   roi_percent               = contribution / (landed cost + fees + outbound shipping)
function computeUnitEconomics({
  price,
  unitCost,
  inboundShipping,
  duties,
  outboundShipping,
  fees,
  feesConfirmedNone = false,
  inboundShippingConfirmedNone = false,
  outboundShippingConfirmedNone = false,
  exchangeRates = null,
} = {}) {
  const priceRead = readMoney(price, 'selling price');
  const currency = priceRead.money ? priceRead.money.currency : null;
  const conversions = [];

  function costIn(money, label, confirmedNone) {
    if ((money === null || money === undefined) && confirmedNone === true) return { amount: 0, missing: null };
    const read = readMoney(money, label);
    if (!read.money) return { amount: null, missing: read.missing };
    if (!priceRead.money) return { amount: null, missing: 'selling price (needed to compare currencies)' };
    const inPrice = toCurrency(read.money, currency, exchangeRates, label);
    if (inPrice.converted) conversions.push({ input: label, ...inPrice.converted });
    return { amount: inPrice.amount, missing: inPrice.missing };
  }

  const cost = costIn(unitCost, 'unit cost');
  const inbound = costIn(inboundShipping, 'inbound shipping cost', inboundShippingConfirmedNone);
  // Duties are optional: only included when supplied, since many products have none.
  const duty = duties === null || duties === undefined ? { amount: 0, missing: null } : costIn(duties, 'duties');
  const outbound = costIn(outboundShipping, 'outbound shipping cost', outboundShippingConfirmedNone);
  const feeResult = priceRead.money
    ? resolveFees({ fees, feesConfirmedNone, price: priceRead.money, exchangeRates })
    : { total: null, missing: ['selling price (needed for fees)'], items: [], converted: [] };
  conversions.push(...feeResult.converted);

  const p = priceRead.money ? priceRead.money.amount : null;
  const priceMissing = priceRead.missing;
  const known = (...values) => values.every((value) => value !== null);

  const grossProfit = known(p, cost.amount) ? p - cost.amount : null;
  const landed = known(cost.amount, inbound.amount, duty.amount) ? cost.amount + inbound.amount + duty.amount : null;
  const landedMissing = [cost.missing, inbound.missing, duty.missing];
  const contributionMissing = [priceMissing, ...landedMissing, ...feeResult.missing, outbound.missing];
  const contribution = known(p, landed, feeResult.total, outbound.amount) ? p - landed - feeResult.total - outbound.amount : null;
  const invested = known(landed, feeResult.total, outbound.amount) ? landed + feeResult.total + outbound.amount : null;

  return {
    currency,
    selling_price: metric(p, [priceMissing], 'the variant selling price as read'),
    unit_cost: metric(cost.amount, [cost.missing], 'the recorded unit cost, in the price currency'),
    gross_profit: metric(grossProfit, [priceMissing, cost.missing], 'price - unit cost'),
    gross_margin_percent: metric(grossProfit !== null && p > 0 ? (grossProfit / p) * 100 : null, [priceMissing, cost.missing, p === 0 ? 'a non-zero selling price' : null], '(price - unit cost) / price x 100'),
    landed_cost: metric(landed, landedMissing, 'unit cost + inbound shipping + duties (when supplied)'),
    total_fees: metric(feeResult.total, feeResult.missing, 'sum of supplied per-sale fees'),
    contribution: metric(contribution, contributionMissing, 'price - landed cost - fees - outbound shipping'),
    contribution_margin_percent: metric(contribution !== null && p > 0 ? (contribution / p) * 100 : null, [...contributionMissing, p === 0 ? 'a non-zero selling price' : null], 'contribution / price x 100'),
    roi_percent: metric(contribution !== null && invested > 0 ? (contribution / invested) * 100 : null, [...contributionMissing, invested === 0 ? 'a non-zero total cost' : null], 'contribution / (landed cost + fees + outbound shipping) x 100'),
    fees: feeResult.items,
    currency_conversions: conversions,
  };
}

module.exports = {
  KNOWN,
  UNKNOWN,
  ECONOMICS_INTENT,
  hasEconomicsIntent,
  parseAmount,
  parseCurrency,
  computeUnitEconomics,
};
