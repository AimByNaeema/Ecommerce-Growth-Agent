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

const IMPLEMENTED_IDS = ['research', 'seo'];

test('every entry except research and seo is not_implemented - do not implement other specialists yet', () => {
  for (const specialist of SPECIALIST_REGISTRY) {
    if (IMPLEMENTED_IDS.includes(specialist.id)) continue;
    assert.strictEqual(specialist.status, 'not_implemented', `${specialist.id} should not be implemented yet`);
  }
});

test('research and seo are implemented', () => {
  for (const id of IMPLEMENTED_IDS) {
    assert.strictEqual(getSpecialistById(id).status, 'implemented', `${id} should be implemented`);
  }
});

test('getSpecialistById() finds a known specialist and returns undefined for an unknown one', () => {
  assert.strictEqual(getSpecialistById('seo').title, 'SEO');
  assert.strictEqual(getSpecialistById('does_not_exist'), undefined);
});

test('getSpecialistsByStatus() returns the correct counts for each status', () => {
  assert.strictEqual(getSpecialistsByStatus('not_implemented').length, SPECIALIST_REGISTRY.length - IMPLEMENTED_IDS.length);
  assert.strictEqual(getSpecialistsByStatus('implemented').length, IMPLEMENTED_IDS.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
