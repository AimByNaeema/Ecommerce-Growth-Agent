'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getDefaultMemoryRootDir,
  getBusinessMemoryDir,
  saveMemoryRecord,
  getMemoryRecordById,
  listMemoryRecords,
  deleteMemoryRecord,
} = require('../../agent/core/memoryStore');
const { createMemoryRecord } = require('../../agent/core/memoryRecordModel');

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

// Every test gets its own throwaway root directory - never the real
// memory/state/business/ this project's own dashboard/agents would write to, so
// running the test suite can never leave behind or depend on real saved memory.
function withTempRoot(fn) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-test-'));
  try {
    fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function verifiedRecord(overrides = {}) {
  return createMemoryRecord({
    id: 'mem-1',
    businessId: 'business-a',
    priorityId: 'reusable_findings',
    summary: 'A real, already-verified finding.',
    verificationStatus: 'passed',
    ...overrides,
  });
}

test('getDefaultMemoryRootDir points at memory/state/business/ by default', () => {
  const before = process.env.MEMORY_STORE_DIR;
  delete process.env.MEMORY_STORE_DIR;
  try {
    assert.ok(getDefaultMemoryRootDir().endsWith(path.join('memory', 'state', 'business')));
  } finally {
    if (before === undefined) delete process.env.MEMORY_STORE_DIR;
    else process.env.MEMORY_STORE_DIR = before;
  }
});

test('getDefaultMemoryRootDir honors MEMORY_STORE_DIR when set, read at call time', () => {
  const before = process.env.MEMORY_STORE_DIR;
  try {
    process.env.MEMORY_STORE_DIR = '/tmp/some-memory-override';
    assert.strictEqual(getDefaultMemoryRootDir(), path.resolve('/tmp/some-memory-override'));
  } finally {
    if (before === undefined) delete process.env.MEMORY_STORE_DIR;
    else process.env.MEMORY_STORE_DIR = before;
  }
});

test('getBusinessMemoryDir throws for an invalid businessId - never builds a path from it', () => {
  withTempRoot((rootDir) => {
    assert.throws(() => getBusinessMemoryDir('', { rootDir }), /Invalid businessId/);
    assert.throws(() => getBusinessMemoryDir('../escape', { rootDir }), /Invalid businessId/);
    assert.throws(() => getBusinessMemoryDir(null, { rootDir }), /Invalid businessId/);
  });
});

test('getBusinessMemoryDir returns a records/ subdirectory scoped under rootDir/businessId', () => {
  withTempRoot((rootDir) => {
    const dir = getBusinessMemoryDir('business-a', { rootDir });
    assert.strictEqual(dir, path.join(rootDir, 'business-a', 'records'));
  });
});

test('saveMemoryRecord then getMemoryRecordById round-trips the exact record, unaltered', () => {
  withTempRoot((rootDir) => {
    const record = verifiedRecord();
    saveMemoryRecord(record, { rootDir });
    assert.deepStrictEqual(getMemoryRecordById('business-a', 'mem-1', { rootDir }), record);
  });
});

test('saveMemoryRecord creates the business/records directory itself when it does not exist yet', () => {
  withTempRoot((rootDir) => {
    const dir = getBusinessMemoryDir('business-a', { rootDir });
    assert.strictEqual(fs.existsSync(dir), false);
    saveMemoryRecord(verifiedRecord(), { rootDir });
    assert.strictEqual(fs.existsSync(dir), true);
  });
});

test('saveMemoryRecord REFUSES an unverified, unapproved record - the store itself enforces the gate, not only the caller', () => {
  withTempRoot((rootDir) => {
    const unverified = createMemoryRecord({
      id: 'mem-bad',
      businessId: 'business-a',
      priorityId: 'reusable_findings',
      summary: 'An unverified guess.',
    });
    assert.throws(() => saveMemoryRecord(unverified, { rootDir }), /verified.*approved/i);
    assert.strictEqual(getMemoryRecordById('business-a', 'mem-bad', { rootDir }), null, 'a refused record must never be written');
  });
});

test('saveMemoryRecord REFUSES a record with an invalid business_id, even if everything else is valid', () => {
  withTempRoot((rootDir) => {
    const record = verifiedRecord({ businessId: '../escape' });
    assert.throws(() => saveMemoryRecord(record, { rootDir }), /business_id/);
  });
});

test('saveMemoryRecord with the same id overwrites the prior record - one record per id, never two copies', () => {
  withTempRoot((rootDir) => {
    saveMemoryRecord(verifiedRecord({ summary: 'First version.' }), { rootDir });
    saveMemoryRecord(verifiedRecord({ summary: 'Corrected, final version.' }), { rootDir });
    const record = getMemoryRecordById('business-a', 'mem-1', { rootDir });
    assert.strictEqual(record.summary, 'Corrected, final version.');
    assert.strictEqual(listMemoryRecords('business-a', { rootDir }).length, 1);
  });
});

test('BUSINESS ISOLATION: two businesses can use the identical record id without ever colliding or leaking', () => {
  withTempRoot((rootDir) => {
    saveMemoryRecord(verifiedRecord({ businessId: 'business-a', summary: "Business A's finding." }), { rootDir });
    saveMemoryRecord(verifiedRecord({ businessId: 'business-b', summary: "Business B's completely different finding." }), {
      rootDir,
    });

    const a = getMemoryRecordById('business-a', 'mem-1', { rootDir });
    const b = getMemoryRecordById('business-b', 'mem-1', { rootDir });
    assert.strictEqual(a.summary, "Business A's finding.");
    assert.strictEqual(b.summary, "Business B's completely different finding.");

    assert.strictEqual(listMemoryRecords('business-a', { rootDir }).length, 1);
    assert.strictEqual(listMemoryRecords('business-b', { rootDir }).length, 1);
  });
});

test('BUSINESS ISOLATION: listMemoryRecords for one business never returns another business\'s records, even by id guess', () => {
  withTempRoot((rootDir) => {
    saveMemoryRecord(verifiedRecord({ businessId: 'business-a' }), { rootDir });
    assert.strictEqual(getMemoryRecordById('business-b', 'mem-1', { rootDir }), null);
  });
});

test('getMemoryRecordById returns null (never throws) for a record that was never saved', () => {
  withTempRoot((rootDir) => {
    assert.strictEqual(getMemoryRecordById('business-a', 'never-saved', { rootDir }), null);
  });
});

test('getMemoryRecordById returns null (never throws) for an invalid businessId or an unknown business', () => {
  withTempRoot((rootDir) => {
    assert.strictEqual(getMemoryRecordById('../escape', 'mem-1', { rootDir }), null);
    assert.strictEqual(getMemoryRecordById('never-configured-business', 'mem-1', { rootDir }), null);
  });
});

test('getMemoryRecordById returns null (never throws) for a corrupt/unparsable saved file', () => {
  withTempRoot((rootDir) => {
    saveMemoryRecord(verifiedRecord(), { rootDir });
    const dir = getBusinessMemoryDir('business-a', { rootDir });
    fs.writeFileSync(path.join(dir, 'mem-corrupt.json'), '{ not valid json', 'utf8');
    assert.strictEqual(getMemoryRecordById('business-a', 'mem-corrupt', { rootDir }), null);
  });
});

test('listMemoryRecords returns [] for a business that has never saved anything (or an invalid businessId) - never an error', () => {
  withTempRoot((rootDir) => {
    assert.deepStrictEqual(listMemoryRecords('never-used-business', { rootDir }), []);
    assert.deepStrictEqual(listMemoryRecords('../escape', { rootDir }), []);
  });
});

test('listMemoryRecords skips one corrupt file without losing the business\'s other valid records', () => {
  withTempRoot((rootDir) => {
    saveMemoryRecord(verifiedRecord({ id: 'mem-good' }), { rootDir });
    const dir = getBusinessMemoryDir('business-a', { rootDir });
    fs.writeFileSync(path.join(dir, 'mem-bad.json'), 'not json at all', 'utf8');
    const records = listMemoryRecords('business-a', { rootDir });
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].id, 'mem-good');
  });
});

test('listMemoryRecords filters by priorityId to one agent/core/memoryRules.js category', () => {
  withTempRoot((rootDir) => {
    saveMemoryRecord(verifiedRecord({ id: 'mem-finding', priorityId: 'reusable_findings' }), { rootDir });
    saveMemoryRecord(verifiedRecord({ id: 'mem-decision', priorityId: 'important_decisions' }), { rootDir });

    const findings = listMemoryRecords('business-a', { rootDir, priorityId: 'reusable_findings' });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].id, 'mem-finding');

    assert.strictEqual(listMemoryRecords('business-a', { rootDir }).length, 2, 'no filter returns everything');
  });
});

test('listMemoryRecords returns newest first and respects limit', () => {
  withTempRoot((rootDir) => {
    for (let i = 0; i < 5; i += 1) {
      saveMemoryRecord(
        verifiedRecord({ id: `mem-${i}`, createdAt: new Date(2026, 0, i + 1).toISOString() }),
        { rootDir }
      );
    }
    const all = listMemoryRecords('business-a', { rootDir });
    assert.strictEqual(all.length, 5);
    assert.strictEqual(all[0].id, 'mem-4', 'newest first');
    assert.strictEqual(listMemoryRecords('business-a', { rootDir, limit: 2 }).length, 2);
  });
});

test('deleteMemoryRecord removes a saved record and reports true; deleting again reports false', () => {
  withTempRoot((rootDir) => {
    saveMemoryRecord(verifiedRecord(), { rootDir });
    assert.strictEqual(deleteMemoryRecord('business-a', 'mem-1', { rootDir }), true);
    assert.strictEqual(getMemoryRecordById('business-a', 'mem-1', { rootDir }), null);
    assert.strictEqual(deleteMemoryRecord('business-a', 'mem-1', { rootDir }), false);
  });
});

test('deleteMemoryRecord never touches another business\'s record with the same id', () => {
  withTempRoot((rootDir) => {
    saveMemoryRecord(verifiedRecord({ businessId: 'business-a' }), { rootDir });
    saveMemoryRecord(verifiedRecord({ businessId: 'business-b' }), { rootDir });
    deleteMemoryRecord('business-a', 'mem-1', { rootDir });
    assert.strictEqual(getMemoryRecordById('business-a', 'mem-1', { rootDir }), null);
    assert.notStrictEqual(getMemoryRecordById('business-b', 'mem-1', { rootDir }), null);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
