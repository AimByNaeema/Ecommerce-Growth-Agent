'use strict';

// Durable, business-isolated storage for monitoring/snapshotModel.js snapshots.
//
// Reuses this project's established persistence conventions rather than inventing any:
// one JSON file per record (agent/core/runHistoryStore.js), a per-business subdirectory
// gated by isValidBusinessId (agent/core/memoryStore.js), an atomic temp-file-then-rename
// write and a credential-key refusal (approvals/approvalStore.js). No database, no new
// dependency, no new file format.
//
//   memory/state/snapshots/<businessKey>/<platform>/<snapshotId>.json
//
// BUSINESS ISOLATION IS STRUCTURAL, NOT A FILTER. One business's snapshots live in their
// own directory, and every read is scoped to exactly one business's directory - there is no
// code path that lists across businesses and then filters, so there is nothing to get
// wrong. A business id that is not valid never becomes a path segment at all.
//
// PATH TRAVERSAL IS IMPOSSIBLE BY CONSTRUCTION. Both path segments are sanitized before
// they are joined: the business key must satisfy the registry's own id pattern (or be the
// reserved default key), and the platform must be a recognized channel. A snapshot id is
// stripped to a safe character set. '../escape' cannot address anything outside the store.
//
// A CORRUPT SNAPSHOT FAILS CLOSED AND IS CONTAINED. Unreadable JSON, a failed schema check,
// or a fingerprint that no longer matches its own state all read as "this snapshot does not
// exist" - never as an empty or partial one, because a partially-trusted previous snapshot
// would produce a diff full of changes that never happened. One corrupt file affects only
// itself: every other snapshot in the same directory still loads, and getLatestSnapshot()
// simply falls back to the newest one that IS valid.
//
// NO CREDENTIAL IS EVER WRITTEN. A snapshot carries no token by construction (the model
// records identity and counts, never configuration), and this store still refuses to write
// one if a credential-shaped key ever appears - the same belt-and-braces refusal
// approvals/approvalStore.js makes, and for the same reason: refusing surfaces the problem
// where it can be fixed.
//
// OBSERVATION ONLY. Nothing here executes, approves, publishes or writes to any platform.

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const { isValidBusinessId } = require('../configuration/businessRegistry');
const { isValidChannel } = require('../agent/core/channelModel');
const { businessKey, validateSnapshotShape } = require('./snapshotModel');

// The directory name standing in for the default single-business deployment (businessId
// null). Deliberately starts with an underscore, which configuration/businessRegistry.js's
// BUSINESS_ID_PATTERN can never produce, so it cannot collide with a real business id.
const DEFAULT_BUSINESS_KEY = '_default';

// Mirrors approvals/approvalStore.js's pattern, which mirrors audit/auditTrail.js's.
const CREDENTIAL_KEY_PATTERN =
  /password|token|secret|api[_-]?key|access[_-]?key|credential|authoriz(a|e)tion|private[_-]?key|ssn|client[_-]?secret/i;

// Read at call time, never memoized, so a test can point it at a temp directory before its
// first write - the same convention agent/core/runHistoryStore.js and
// approvals/approvalStore.js both use.
function getDefaultSnapshotStoreDir() {
  return process.env.SNAPSHOT_STORE_DIR
    ? path.resolve(process.env.SNAPSHOT_STORE_DIR)
    : path.join(__dirname, '..', 'memory', 'state', 'snapshots');
}

function safeSnapshotId(id) {
  return typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_-]/g, '') : '';
}

// Resolves <root>/<businessKey>/<platform>, or throws. Never returns a path built from an
// unvalidated segment, so an invalid id or platform cannot reach the filesystem at all.
function snapshotDir(businessId, platform, rootDir) {
  const key = businessKey(businessId);
  if (key !== DEFAULT_BUSINESS_KEY && !isValidBusinessId(key)) {
    throw new Error(
      `snapshotStore refuses an invalid businessId ${JSON.stringify(businessId)} - it never becomes a directory name.`
    );
  }
  if (!isValidChannel(platform)) {
    throw new Error(
      `snapshotStore refuses platform ${JSON.stringify(platform)} - only platforms this project recognizes can be stored.`
    );
  }
  return path.join(rootDir, key, platform);
}

function findCredentialKeyPath(value, trail = []) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findCredentialKeyPath(value[index], trail.concat(`[${index}]`));
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const here = trail.concat(key);
    if (CREDENTIAL_KEY_PATTERN.test(key)) return here.join('.');
    const found = findCredentialKeyPath(value[key], here);
    if (found) return found;
  }
  return null;
}

// Same atomic write as approvals/approvalStore.js: same-directory temp file, then rename
// over the target. Rename is atomic within one filesystem, so a concurrent or post-crash
// reader sees a complete file - the old one or the new one - and never a truncated one. A
// failed write removes its temp file rather than leaving debris that a directory listing
// would later trip over.
function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupErr) {
      // The temp file never existed or is already gone - the real error below is the one
      // that matters.
    }
    throw err;
  }
}

// Persists one snapshot. Throws for a snapshot that is not valid rather than storing
// something no reader would accept - a store of unreadable records is worse than an empty
// one, because a later diff would silently skip it.
function saveSnapshot(snapshot, { rootDir = getDefaultSnapshotStoreDir() } = {}) {
  const validation = validateSnapshotShape(snapshot);
  if (!validation.valid) {
    throw new Error(`Refusing to persist an invalid snapshot: ${validation.errors.join('; ')}`);
  }

  const offending = findCredentialKeyPath(snapshot);
  if (offending) {
    throw new Error(
      `Refusing to persist a snapshot: it carries credential-shaped material at '${offending}'. ` +
        'Monitoring state never contains credentials, tokens or keys.'
    );
  }

  const directory = snapshotDir(snapshot.business_id, snapshot.platform, rootDir);
  const id = safeSnapshotId(snapshot.snapshot_id);
  if (!id) throw new Error('Refusing to persist a snapshot with no filename-safe snapshot_id.');

  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${id}.json`);
  writeJsonAtomically(filePath, snapshot);
  return filePath;
}

// Reads and re-validates one file. Every failure mode - missing, unreadable, unparseable,
// schema-invalid, fingerprint mismatch - returns null, so a corrupt snapshot is
// indistinguishable from an absent one and can never be partially trusted.
function readSnapshotFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
  return validateSnapshotShape(parsed).valid ? parsed : null;
}

// Loads one snapshot by id, scoped to one business and platform.
//
// `expectedBusinessId` is checked against the loaded record as well as being used to build
// the path: the path already isolates, and this second check means a file moved or written
// into the wrong directory is still refused rather than served to the wrong business.
function loadSnapshot(snapshotId, { businessId = null, platform, rootDir = getDefaultSnapshotStoreDir() } = {}) {
  const id = safeSnapshotId(snapshotId);
  if (!id) return null;
  let directory;
  try {
    directory = snapshotDir(businessId, platform, rootDir);
  } catch (err) {
    return null;
  }
  const snapshot = readSnapshotFile(path.join(directory, `${id}.json`));
  if (!snapshot) return null;
  const expected = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
  if (snapshot.business_id !== expected || snapshot.platform !== platform) return null;
  return snapshot;
}

// Every valid snapshot for one business and platform, newest first.
//
// Sorted by captured_at, with snapshot_id as the tie-break so two captures in the same
// millisecond still order deterministically. Invalid files are skipped individually - one
// corrupt snapshot never prevents the rest from loading.
function listSnapshots({ businessId = null, platform, limit = 50, rootDir = getDefaultSnapshotStoreDir() } = {}) {
  let directory;
  try {
    directory = snapshotDir(businessId, platform, rootDir);
  } catch (err) {
    return [];
  }

  let fileNames;
  try {
    fileNames = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }

  const expected = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
  const snapshots = [];
  for (const fileName of fileNames) {
    const snapshot = readSnapshotFile(path.join(directory, fileName));
    if (!snapshot) continue;
    // Belt and braces: a record whose own fields disagree with the directory it was found
    // in is not served, whatever put it there.
    if (snapshot.business_id !== expected || snapshot.platform !== platform) continue;
    snapshots.push(snapshot);
  }

  snapshots.sort((a, b) => {
    const aTime = new Date(a.captured_at).getTime();
    const bTime = new Date(b.captured_at).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return a.snapshot_id < b.snapshot_id ? 1 : a.snapshot_id > b.snapshot_id ? -1 : 0;
  });

  return snapshots.slice(0, Math.max(0, limit));
}

// The most recent VALID snapshot, or null when there is none.
//
// "Valid" is load-bearing: this is what monitoring/platformMonitor.js diffs against, so a
// corrupt newest file must not become the baseline. It is skipped and the newest intact
// snapshot is used instead - and if none is intact, the answer is null, which the diff
// treats as a first observation and therefore reports no changes at all. Fail-closed here
// means reporting nothing, never reporting something invented.
function getLatestSnapshot({ businessId = null, platform, rootDir = getDefaultSnapshotStoreDir() } = {}) {
  const [latest] = listSnapshots({ businessId, platform, limit: 1, rootDir });
  return latest || null;
}

module.exports = {
  DEFAULT_BUSINESS_KEY,
  getDefaultSnapshotStoreDir,
  safeSnapshotId,
  findCredentialKeyPath,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  getLatestSnapshot,
};

if (require.main === module) {
  const os = require('os');
  const { createSnapshot } = require('./snapshotModel');
  console.log('Smart E-Commerce Growth AI Agent - monitoring snapshot store:\n');

  const demoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-store-demo-'));
  const build = (business, at, productCount) =>
    createSnapshot({
      businessId: business,
      platform: 'shopify',
      capturedAt: new Date(at),
      source: { adapter: 'demo' },
      observations: {
        getShopInfo: { status: 'observed', result: { name: `${business} store`, domain: `${business}.example` } },
        getProducts: {
          status: 'observed',
          result: new Array(productCount).fill(null).map((unused, index) => ({ id: `p${index}`, title: `Item ${index}`, status: 'active', tags: [], variants: [] })),
        },
        getCollections: { status: 'observed', result: [] },
        getInventoryLevels: { status: 'observed', result: [] },
        getOrders: { status: 'observed', result: [] },
        getCustomers: { status: 'observed', result: [] },
      },
    });

  saveSnapshot(build('alpha-co', '2026-03-04T09:00:00.000Z', 2), { rootDir: demoRoot });
  saveSnapshot(build('alpha-co', '2026-03-05T09:00:00.000Z', 3), { rootDir: demoRoot });
  saveSnapshot(build('beta-co', '2026-03-05T09:00:00.000Z', 99), { rootDir: demoRoot });

  console.log('alpha-co sees only its own:', listSnapshots({ businessId: 'alpha-co', platform: 'shopify', rootDir: demoRoot }).map((s) => s.captured_at));
  console.log('beta-co sees only its own: ', listSnapshots({ businessId: 'beta-co', platform: 'shopify', rootDir: demoRoot }).map((s) => s.captured_at));

  // Corrupt the newest alpha-co snapshot and show containment.
  const alphaDir = path.join(demoRoot, 'alpha-co', 'shopify');
  const newest = fs.readdirSync(alphaDir).sort().pop();
  fs.writeFileSync(path.join(alphaDir, newest), '{ not json');
  const latest = getLatestSnapshot({ businessId: 'alpha-co', platform: 'shopify', rootDir: demoRoot });
  console.log('\nAfter corrupting one file, the newest INTACT snapshot is still readable:', latest && latest.captured_at);
  console.log('The corrupt one reads as absent, never as empty - so no false "everything was removed".');

  console.log('\nAn invalid business id never becomes a path:');
  try {
    saveSnapshot({ ...build('alpha-co', '2026-03-06T09:00:00.000Z', 1), business_id: '../escape' }, { rootDir: demoRoot });
  } catch (err) {
    console.log(`  refused: ${err.message.split(' - ')[0]}`);
  }

  fs.rmSync(demoRoot, { recursive: true, force: true });
}
