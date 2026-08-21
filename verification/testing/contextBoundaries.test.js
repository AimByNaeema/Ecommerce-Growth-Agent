'use strict';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { CONTEXT_BOUNDARIES } = require('../../agent/core/contextBoundaries');

const EXPECTED_ORDER = [
  'task_context',
  'business_context',
  'product_context',
  'research_context',
  'memory_context',
  'tool_context',
];

const REPO_ROOT = path.join(__dirname, '..', '..');

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

test('exactly the 6 required context boundaries exist, in the requested order', () => {
  assert.deepStrictEqual(
    CONTEXT_BOUNDARIES.map((boundary) => boundary.id),
    EXPECTED_ORDER
  );
});

test('every boundary has a non-empty title, at least one location, and a description', () => {
  for (const boundary of CONTEXT_BOUNDARIES) {
    assert.ok(boundary.title && boundary.title.trim() !== '', `${boundary.id} is missing a title`);
    assert.ok(
      Array.isArray(boundary.locations) && boundary.locations.length > 0,
      `${boundary.id} is missing at least one location`
    );
    assert.ok(
      boundary.description && boundary.description.trim() !== '',
      `${boundary.id} is missing a description`
    );
  }
});

test('every declared location actually exists on disk', () => {
  for (const boundary of CONTEXT_BOUNDARIES) {
    for (const location of boundary.locations) {
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, location)),
        `${boundary.id}'s location "${location}" does not exist`
      );
    }
  }
});

test('no two boundaries claim the exact same location', () => {
  const allLocations = CONTEXT_BOUNDARIES.flatMap((boundary) => boundary.locations);
  assert.strictEqual(new Set(allLocations).size, allLocations.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
