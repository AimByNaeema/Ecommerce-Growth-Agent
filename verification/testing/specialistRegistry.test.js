'use strict';

const assert = require('node:assert');
const {
  SPECIALIST_STATUSES,
  SPECIALIST_REGISTRY,
  getSpecialistById,
  getSpecialistsByStatus,
} = require('../../agent/core/specialistRegistry');

const EXPECTED_ORDER = [
  'research',
  'product',
  'seo',
  'listing',
  'marketing',
  'social_advertising',
  'analytics_optimization',
];

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

test('the registry has exactly the 7 approved specialists, in the requested order', () => {
  assert.deepStrictEqual(
    SPECIALIST_REGISTRY.map((specialist) => specialist.id),
    EXPECTED_ORDER
  );
});

test('every entry has a non-empty title and description', () => {
  for (const specialist of SPECIALIST_REGISTRY) {
    assert.ok(specialist.title && specialist.title.trim() !== '', `${specialist.id} is missing a title`);
    assert.ok(specialist.description && specialist.description.trim() !== '', `${specialist.id} is missing a description`);
  }
});

test('specialist ids are unique', () => {
  const ids = SPECIALIST_REGISTRY.map((specialist) => specialist.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('every entry has a valid status', () => {
  for (const specialist of SPECIALIST_REGISTRY) {
    assert.ok(SPECIALIST_STATUSES.includes(specialist.status), `${specialist.id} has an invalid status: ${specialist.status}`);
  }
});

test('every entry is not_implemented - no specialist has real logic yet', () => {
  for (const specialist of SPECIALIST_REGISTRY) {
    assert.strictEqual(specialist.status, 'not_implemented', `${specialist.id} should not be implemented yet`);
  }
});

test('getSpecialistById() finds a known specialist and returns undefined for an unknown one', () => {
  assert.strictEqual(getSpecialistById('seo').title, 'SEO');
  assert.strictEqual(getSpecialistById('does_not_exist'), undefined);
});

test('getSpecialistsByStatus() returns all specialists when all are not_implemented', () => {
  assert.strictEqual(getSpecialistsByStatus('not_implemented').length, SPECIALIST_REGISTRY.length);
  assert.strictEqual(getSpecialistsByStatus('implemented').length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
