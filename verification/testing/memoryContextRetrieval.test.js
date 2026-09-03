'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every test gets its own throwaway MEMORY_STORE_DIR - never the real
// memory/state/business/ this project's own dashboard/agents would write to, so
// running the test suite can never leave behind or depend on real saved memory (the
// same discipline verification/testing/memoryStore.test.js's own withTempRoot already
// established, applied here via the env var this module actually reads).
function withTempMemoryStoreDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-context-retrieval-test-'));
  const before = process.env.MEMORY_STORE_DIR;
  process.env.MEMORY_STORE_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (before === undefined) delete process.env.MEMORY_STORE_DIR;
    else process.env.MEMORY_STORE_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Re-requiring inside each withTempMemoryStoreDir call would hit Node's module cache
// (require('./memoryContextRetrieval') is only ever loaded once) - but every function
// under test reads process.env.MEMORY_STORE_DIR at call time (see
// agent/core/memoryStore.js's own getDefaultMemoryRootDir), never at require time, so
// requiring once up top is safe and matches every other test file's convention.
const { MAX_RELEVANT_MEMORY_RECORDS, getRelevantMemoryContext, persistVerifiedFinding } = require('../../agent/core/memoryContextRetrieval');
const { saveMemoryRecord, getMemoryRecordById } = require('../../agent/core/memoryStore');
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

// ---------------------------------------------------------------------------------
// getRelevantMemoryContext
// ---------------------------------------------------------------------------------

test('getRelevantMemoryContext returns {} (never throws) for a null/invalid businessId - no directory to read at all', () => {
  withTempMemoryStoreDir(() => {
    assert.deepStrictEqual(getRelevantMemoryContext(null), {});
    assert.deepStrictEqual(getRelevantMemoryContext(undefined), {});
    assert.deepStrictEqual(getRelevantMemoryContext('../escape'), {});
    assert.deepStrictEqual(getRelevantMemoryContext(''), {});
  });
});

test('getRelevantMemoryContext returns {} for a valid businessId that has never saved anything', () => {
  withTempMemoryStoreDir(() => {
    assert.deepStrictEqual(getRelevantMemoryContext('never-used-business'), {});
  });
});

test('getRelevantMemoryContext returns a compact relevant_memory array (priority_id, summary, created_at only) for a business with saved records', () => {
  withTempMemoryStoreDir(() => {
    saveMemoryRecord(
      createMemoryRecord({
        id: 'mem-1',
        businessId: 'biz-a',
        priorityId: 'reusable_findings',
        summary: 'A real, verified finding.',
        source: { run_id: 'run-1', tool_id: 'market_research' },
        verificationStatus: 'passed',
      })
    );
    const context = getRelevantMemoryContext('biz-a');
    assert.ok(Array.isArray(context.relevant_memory));
    assert.strictEqual(context.relevant_memory.length, 1);
    assert.deepStrictEqual(Object.keys(context.relevant_memory[0]).sort(), ['created_at', 'priority_id', 'summary']);
    assert.strictEqual(context.relevant_memory[0].summary, 'A real, verified finding.');
    assert.strictEqual(context.relevant_memory[0].priority_id, 'reusable_findings');
  });
});

test('getRelevantMemoryContext never leaks another business\'s records (business isolation)', () => {
  withTempMemoryStoreDir(() => {
    saveMemoryRecord(
      createMemoryRecord({
        id: 'mem-1',
        businessId: 'biz-a',
        priorityId: 'reusable_findings',
        summary: "Business A's own finding.",
        verificationStatus: 'passed',
      })
    );
    saveMemoryRecord(
      createMemoryRecord({
        id: 'mem-1',
        businessId: 'biz-b',
        priorityId: 'reusable_findings',
        summary: "Business B's own, unrelated finding.",
        verificationStatus: 'passed',
      })
    );
    const contextA = getRelevantMemoryContext('biz-a');
    const contextB = getRelevantMemoryContext('biz-b');
    assert.strictEqual(contextA.relevant_memory.length, 1);
    assert.strictEqual(contextA.relevant_memory[0].summary, "Business A's own finding.");
    assert.strictEqual(contextB.relevant_memory.length, 1);
    assert.strictEqual(contextB.relevant_memory[0].summary, "Business B's own, unrelated finding.");
  });
});

test('getRelevantMemoryContext defensively drops a record that no longer validates (e.g. hand-edited to be unverified) even though it was found on disk', () => {
  withTempMemoryStoreDir((dir) => {
    saveMemoryRecord(
      createMemoryRecord({
        id: 'mem-1',
        businessId: 'biz-a',
        priorityId: 'reusable_findings',
        summary: 'Verified at save time.',
        verificationStatus: 'passed',
      })
    );
    // Simulate a record hand-edited on disk after being saved (bypassing
    // saveMemoryRecord's own write-time gate entirely) - the read-side re-validation
    // in getRelevantMemoryContext must still catch it.
    const filePath = path.join(dir, 'biz-a', 'records', 'mem-1.json');
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    onDisk.verification_status = 'unverified';
    onDisk.approval = null;
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), 'utf8');

    assert.deepStrictEqual(getRelevantMemoryContext('biz-a'), {});
  });
});

test('getRelevantMemoryContext respects MAX_RELEVANT_MEMORY_RECORDS as its default cap', () => {
  withTempMemoryStoreDir(() => {
    for (let i = 0; i < MAX_RELEVANT_MEMORY_RECORDS + 5; i += 1) {
      saveMemoryRecord(
        createMemoryRecord({
          id: `mem-${i}`,
          businessId: 'biz-a',
          priorityId: 'reusable_findings',
          summary: `Finding number ${i}.`,
          verificationStatus: 'passed',
          createdAt: new Date(2026, 0, i + 1).toISOString(),
        })
      );
    }
    const context = getRelevantMemoryContext('biz-a');
    assert.strictEqual(context.relevant_memory.length, MAX_RELEVANT_MEMORY_RECORDS);
  });
});

test('getRelevantMemoryContext accepts an explicit limit override', () => {
  withTempMemoryStoreDir(() => {
    for (let i = 0; i < 5; i += 1) {
      saveMemoryRecord(
        createMemoryRecord({
          id: `mem-${i}`,
          businessId: 'biz-a',
          priorityId: 'reusable_findings',
          summary: `Finding number ${i}.`,
          verificationStatus: 'passed',
        })
      );
    }
    assert.strictEqual(getRelevantMemoryContext('biz-a', { limit: 2 }).relevant_memory.length, 2);
  });
});

// ---------------------------------------------------------------------------------
// persistVerifiedFinding
// ---------------------------------------------------------------------------------

test('persistVerifiedFinding returns null (never throws) for a null/invalid businessId - nothing is saved', () => {
  withTempMemoryStoreDir(() => {
    const result = persistVerifiedFinding({
      businessId: null,
      id: 'mem-1',
      priorityId: 'reusable_findings',
      summary: 'A finding with nowhere business-isolated to live.',
      verificationStatus: 'passed',
    });
    assert.strictEqual(result, null);
  });
});

test('persistVerifiedFinding returns null for a missing/empty summary', () => {
  withTempMemoryStoreDir(() => {
    assert.strictEqual(
      persistVerifiedFinding({ businessId: 'biz-a', id: 'mem-1', priorityId: 'reusable_findings', summary: '', verificationStatus: 'passed' }),
      null
    );
    assert.strictEqual(
      persistVerifiedFinding({ businessId: 'biz-a', id: 'mem-1', priorityId: 'reusable_findings', verificationStatus: 'passed' }),
      null
    );
  });
});

test('THE GATE: persistVerifiedFinding refuses an unverified, unapproved finding - it is never written to disk', () => {
  withTempMemoryStoreDir(() => {
    const result = persistVerifiedFinding({
      businessId: 'biz-a',
      id: 'mem-1',
      priorityId: 'reusable_findings',
      summary: 'An unverified guess.',
      verificationStatus: 'unverified',
    });
    assert.strictEqual(result, null);
    assert.strictEqual(getMemoryRecordById('biz-a', 'mem-1'), null);
  });
});

test('persistVerifiedFinding saves a real verified finding and returns the saved record', () => {
  withTempMemoryStoreDir(() => {
    const result = persistVerifiedFinding({
      businessId: 'biz-a',
      id: 'mem-1',
      priorityId: 'reusable_findings',
      summary: 'A real, verified finding worth remembering.',
      source: { run_id: 'run-1', tool_id: 'market_research', capability_id: 'market_research' },
      verificationStatus: 'passed',
    });
    assert.ok(result);
    assert.strictEqual(result.summary, 'A real, verified finding worth remembering.');
    assert.strictEqual(result.verification_status, 'passed');
    const onDisk = getMemoryRecordById('biz-a', 'mem-1');
    assert.deepStrictEqual(onDisk, result);
  });
});

test('persistVerifiedFinding also accepts an approved (not necessarily verification-passed) finding', () => {
  withTempMemoryStoreDir(() => {
    const result = persistVerifiedFinding({
      businessId: 'biz-a',
      id: 'mem-1',
      priorityId: 'important_decisions',
      summary: 'A decision approved by a human reviewer.',
      verificationStatus: 'unverified',
      approval: { approval_request_id: 'apr-1', status: 'approved', decided_by: 'owner' },
    });
    assert.ok(result);
    assert.strictEqual(result.priority_id, 'important_decisions');
  });
});

test('persistVerifiedFinding with the same id overwrites the prior record - never a duplicate', () => {
  withTempMemoryStoreDir(() => {
    persistVerifiedFinding({ businessId: 'biz-a', id: 'mem-1', priorityId: 'reusable_findings', summary: 'First version.', verificationStatus: 'passed' });
    persistVerifiedFinding({ businessId: 'biz-a', id: 'mem-1', priorityId: 'reusable_findings', summary: 'Corrected version.', verificationStatus: 'passed' });
    assert.strictEqual(getMemoryRecordById('biz-a', 'mem-1').summary, 'Corrected version.');
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
