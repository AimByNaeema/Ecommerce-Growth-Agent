'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getDefaultStoreDir,
  saveRunRecord,
  getRunRecordById,
  listRunRecordSummaries,
} = require('../../agent/core/runHistoryStore');

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

// Every test gets its own throwaway directory - never the real
// memory/state/runs/ this project's own dashboard writes to, so running the test
// suite can never leave behind or depend on real saved runs.
function withTempStoreDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-store-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('getDefaultStoreDir points at memory/state/runs/ by default, matching memory/state/README.md\'s reserved location', () => {
  const before = process.env.RUN_HISTORY_STORE_DIR;
  delete process.env.RUN_HISTORY_STORE_DIR;
  try {
    const dir = getDefaultStoreDir();
    assert.ok(dir.endsWith(path.join('memory', 'state', 'runs')), dir);
  } finally {
    if (before === undefined) delete process.env.RUN_HISTORY_STORE_DIR;
    else process.env.RUN_HISTORY_STORE_DIR = before;
  }
});

test('getDefaultStoreDir honors RUN_HISTORY_STORE_DIR when set, read at call time (not memoized)', () => {
  const before = process.env.RUN_HISTORY_STORE_DIR;
  try {
    process.env.RUN_HISTORY_STORE_DIR = '/tmp/some-override-dir';
    assert.strictEqual(getDefaultStoreDir(), path.resolve('/tmp/some-override-dir'));
  } finally {
    if (before === undefined) delete process.env.RUN_HISTORY_STORE_DIR;
    else process.env.RUN_HISTORY_STORE_DIR = before;
  }
});

test('saveRunRecord then getRunRecordById round-trips the exact record given, unaltered', () => {
  withTempStoreDir((storeDir) => {
    const record = {
      run_id: 'run-abc123',
      kind: 'run',
      objective: 'Pull our real product catalog from Shopify.',
      specialist_id: 'product',
      specialist_name: 'Product',
      status: 'success',
      summary: 'Found 12 real products.',
      created_at: '2026-01-01T00:00:00.000Z',
      result: { outputs: { status: 'success', result: { productCount: 12 } } },
    };
    saveRunRecord(record, { storeDir });
    assert.deepStrictEqual(getRunRecordById('run-abc123', { storeDir }), record);
  });
});

test('saveRunRecord creates the store directory itself when it does not exist yet', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-store-test-'));
  const storeDir = path.join(parent, 'nested', 'runs');
  try {
    assert.strictEqual(fs.existsSync(storeDir), false);
    saveRunRecord({ run_id: 'run-1', status: 'success' }, { storeDir });
    assert.strictEqual(fs.existsSync(storeDir), true);
    assert.notStrictEqual(getRunRecordById('run-1', { storeDir }), null);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('saveRunRecord with the same run_id overwrites the prior record (e.g. after an approval is resolved), never keeping two copies', () => {
  withTempStoreDir((storeDir) => {
    saveRunRecord({ run_id: 'run-1', status: 'partial', summary: 'Awaiting approval.' }, { storeDir });
    saveRunRecord({ run_id: 'run-1', status: 'success', summary: 'Approved and completed.' }, { storeDir });
    const record = getRunRecordById('run-1', { storeDir });
    assert.strictEqual(record.status, 'success');
    assert.strictEqual(record.summary, 'Approved and completed.');
    assert.strictEqual(listRunRecordSummaries({ storeDir }).length, 1);
  });
});

test('saveRunRecord throws for a missing/empty run_id - never silently drops a record', () => {
  withTempStoreDir((storeDir) => {
    assert.throws(() => saveRunRecord({ status: 'success' }, { storeDir }), /run_id/);
    assert.throws(() => saveRunRecord({ run_id: '', status: 'success' }, { storeDir }), /run_id/);
    assert.throws(() => saveRunRecord(null, { storeDir }), /record/);
  });
});

test('saveRunRecord sanitizes run_id to safe filename characters - never a path traversal outside storeDir', () => {
  withTempStoreDir((storeDir) => {
    saveRunRecord({ run_id: '../../etc/passwd', status: 'success' }, { storeDir });
    const filesInStoreDir = fs.readdirSync(storeDir);
    assert.strictEqual(filesInStoreDir.length, 1);
    assert.ok(filesInStoreDir[0].endsWith('.json'));
    assert.ok(!filesInStoreDir[0].includes('/'));
  });
});

test('getRunRecordById returns null (never throws) for a run id that was never saved', () => {
  withTempStoreDir((storeDir) => {
    assert.strictEqual(getRunRecordById('never-saved', { storeDir }), null);
  });
});

test('getRunRecordById returns null (never throws) for an invalid/empty id, or when the store directory does not exist at all', () => {
  const nonexistentDir = path.join(os.tmpdir(), 'run-history-store-test-does-not-exist-' + Date.now());
  assert.strictEqual(getRunRecordById('', { storeDir: nonexistentDir }), null);
  assert.strictEqual(getRunRecordById(null, { storeDir: nonexistentDir }), null);
  assert.strictEqual(getRunRecordById('anything', { storeDir: nonexistentDir }), null);
});

test('getRunRecordById returns null (never throws) for a corrupt/unparsable saved file - one bad record never crashes a read', () => {
  withTempStoreDir((storeDir) => {
    fs.writeFileSync(path.join(storeDir, 'run-corrupt.json'), '{ this is not valid json', 'utf8');
    assert.strictEqual(getRunRecordById('run-corrupt', { storeDir }), null);
  });
});

test('listRunRecordSummaries returns [] when nothing has ever been saved (store directory does not exist)', () => {
  const nonexistentDir = path.join(os.tmpdir(), 'run-history-store-test-does-not-exist-' + Date.now());
  assert.deepStrictEqual(listRunRecordSummaries({ storeDir: nonexistentDir }), []);
});

test('listRunRecordSummaries returns only summary fields, newest first, never the full record', () => {
  withTempStoreDir((storeDir) => {
    saveRunRecord(
      {
        run_id: 'run-old',
        kind: 'run',
        objective: 'Old objective',
        status: 'success',
        created_at: '2026-01-01T00:00:00.000Z',
        result: { huge: 'this must not appear in the summary' },
      },
      { storeDir }
    );
    saveRunRecord(
      {
        run_id: 'run-new',
        kind: 'orchestrate',
        objective: 'New objective',
        status: 'partial',
        created_at: '2026-01-02T00:00:00.000Z',
        result: { huge: 'this must not appear in the summary either' },
      },
      { storeDir }
    );

    const summaries = listRunRecordSummaries({ storeDir });
    assert.strictEqual(summaries.length, 2);
    assert.strictEqual(summaries[0].run_id, 'run-new', 'newest first');
    assert.strictEqual(summaries[1].run_id, 'run-old');
    assert.ok(!('result' in summaries[0]), 'summary must never include the full result payload');
  });
});

test('listRunRecordSummaries skips one corrupt file without losing the other valid records', () => {
  withTempStoreDir((storeDir) => {
    saveRunRecord({ run_id: 'run-good', status: 'success', created_at: '2026-01-01T00:00:00.000Z' }, { storeDir });
    fs.writeFileSync(path.join(storeDir, 'run-bad.json'), 'not json at all', 'utf8');

    const summaries = listRunRecordSummaries({ storeDir });
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].run_id, 'run-good');
  });
});

test('listRunRecordSummaries respects the limit option', () => {
  withTempStoreDir((storeDir) => {
    for (let i = 0; i < 5; i += 1) {
      saveRunRecord(
        { run_id: `run-${i}`, status: 'success', created_at: new Date(2026, 0, i + 1).toISOString() },
        { storeDir }
      );
    }
    assert.strictEqual(listRunRecordSummaries({ storeDir, limit: 2 }).length, 2);
    assert.strictEqual(listRunRecordSummaries({ storeDir }).length, 5);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
