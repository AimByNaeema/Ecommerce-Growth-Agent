'use strict';

// The local signing helper (approvals/localSigningHelper/localSigningHelper.js).
//
// WHAT IS PROVEN. The helper signs ONLY an approval challenge the server issued, ONLY for the allow-listed
// Dashboard origin on 127.0.0.1, and ONLY after the owner's local "Yes" - and the signature it returns is
// accepted by the server's own, unchanged verifier. Every Windows failure (key file missing, locked or
// protected, invalid key, PowerShell missing, window unanswered, port in use, not Windows) signs nothing and
// is reported with a stable code. No response and no log line ever carries private key material.
//
// NOTHING EXTERNAL. The helper listens on 127.0.0.1 on a random port; the key is a throwaway Ed25519 key in a
// temporary folder, removed at the end; the Windows confirmation window is replaced by an injected answer or a
// fake PowerShell process, so no window appears.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  APPROVAL_PUBLIC_KEY_ENV,
  issueApprovalChallenge,
  verifyApprovalAuthorization,
  getChallengeTtlMs,
} = require('../../approvals/approvalArchitecture');
const {
  LISTEN_HOST,
  DEFAULT_PORT,
  CONFIRM_TEXT_ENV,
  CONFIRMATION_COMMAND,
  CONFIRMATION_ARGS,
  SIGNING_HELPER_ERRORS,
  SigningHelperError,
  normalizeAllowedOrigins,
  parseApprovalPayload,
  bindRequestToPayload,
  loadApprovalPrivateKey,
  publicKeyFingerprint,
  describeForConfirmation,
  windowsConfirmation,
  createSigningHelper,
  main,
} = require('../../approvals/localSigningHelper/localSigningHelper');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const keys = crypto.generateKeyPairSync('ed25519');
process.env[APPROVAL_PUBLIC_KEY_ENV] = keys.publicKey.export({ type: 'spki', format: 'pem' });
const PRIVATE_PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PRIVATE_PEM_BODY = PRIVATE_PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const DASHBOARD_ORIGIN = 'https://dashboard.example.test';
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'local-signing-helper-test-'));
const KEY_PATH = path.join(TEMP_DIR, 'approval-private.pem');
fs.writeFileSync(KEY_PATH, PRIVATE_PEM);

// Everything any helper said, for the final key-material scan.
const SEEN = [];

function realChallenge(id = 'apr-helper-1', decision = 'approved') {
  const request = { id, status: 'pending', execution_request: { objective: 'Apply the stored SEO proposal', tool_id: 'shopify_product_seo_update' } };
  return { request, challenge: issueApprovalChallenge({ request, decision, decidedBy: 'naeema' }) };
}

function signBody(challenge, overrides = {}) {
  return {
    payload_base64: challenge.payload_base64,
    request_id: challenge.request_id,
    decision: challenge.decision,
    decided_by: challenge.decided_by,
    nonce: challenge.nonce,
    ...overrides,
  };
}

const encode = (text) => Buffer.from(text, 'utf8').toString('base64');

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err instanceof SigningHelperError ? err.code : `unexpected: ${err.message}`;
  }
  return null;
}

async function asyncCodeOf(promise) {
  try {
    await promise;
  } catch (err) {
    return err instanceof SigningHelperError ? err.code : `unexpected: ${err.message}`;
  }
  return null;
}

// Raw HTTP, so Origin and Host are exactly what a browser - or an attacking page - would send.
function call(port, { method = 'POST', path: requestPath = '/sign', origin = DASHBOARD_ORIGIN, host = null, contentType = 'application/json', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const sent = { ...headers };
    if (origin !== null) sent.Origin = origin;
    if (host) sent.Host = host;
    if (payload !== null) {
      sent['Content-Type'] = contentType;
      sent['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method, headers: sent }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        SEEN.push(raw, JSON.stringify(res.headers));
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (err) {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function withHelper(options, fn) {
  const logs = [];
  const helper = createSigningHelper({
    keyPath: KEY_PATH,
    allowedOrigins: [DASHBOARD_ORIGIN],
    confirm: async () => true,
    log: (event, fields) => {
      logs.push({ event, fields });
      SEEN.push(JSON.stringify({ event, fields }));
    },
    ...options,
  });
  const server = await helper.listen(0);
  const { port, address } = server.address();
  try {
    await fn({ port, address, logs });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A stand-in for powershell.exe: answers like the real confirmation window would, without showing one.
function fakeSpawn({ stdout = '', code = 0, error = null, hang = false, throwOnSpawn = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ command, args, options, child });
    if (throwOnSpawn) throw new Error('spawn failed');
    setImmediate(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (hang) return;
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

(async () => {
  // ---- Configuration -----------------------------------------------------------------------------
  test('ALLOWED ORIGINS: exact https Dashboard origins (and local http) only - no wildcard, path or remote http', () => {
    assert.deepStrictEqual([...normalizeAllowedOrigins(`${DASHBOARD_ORIGIN}, http://localhost:3000`)], [DASHBOARD_ORIGIN, 'http://localhost:3000']);
    assert.deepStrictEqual([...normalizeAllowedOrigins([`${DASHBOARD_ORIGIN}/`])], [DASHBOARD_ORIGIN]);
    for (const bad of ['*', 'https://*.example.test', `${DASHBOARD_ORIGIN}/dashboard`, 'http://dashboard.example.test', 'not a url', '']) {
      assert.throws(() => normalizeAllowedOrigins(bad), undefined, bad);
    }
    assert.throws(() => createSigningHelper({ keyPath: KEY_PATH, allowedOrigins: [] }), /No Dashboard origin is allowed/);
  });

  // ---- The payload -------------------------------------------------------------------------------
  test('PAYLOAD: a real challenge is parsed into its exact bytes; anything else is refused', () => {
    const { challenge } = realChallenge('apr-parse');
    const parsed = parseApprovalPayload(challenge.payload_base64);
    assert.ok(parsed.bytes.equals(Buffer.from(challenge.payload, 'utf8')));
    assert.deepStrictEqual(parsed.fields, {
      request_id: 'apr-parse',
      decision: 'approved',
      decided_by: 'naeema',
      execution_fingerprint: challenge.execution_fingerprint,
      nonce: challenge.nonce,
      issued_at: challenge.issued_at,
    });

    const lines = challenge.payload.split('\n');
    const withLine = (index, value) => encode(lines.map((line, i) => (i === index ? value : line)).join('\n'));
    const refusals = {
      'not base64': '%%%',
      'non-canonical base64': `${challenge.payload_base64.replace(/=+$/, '')}`,
      'CRLF line endings': encode(challenge.payload.replace(/\n/g, '\r\n')),
      'six lines': encode(lines.slice(0, 6).join('\n')),
      'eight lines': encode(`${challenge.payload}\nextra`),
      'another format': withLine(0, 'other-format-v1'),
      'unknown decision': withLine(2, 'maybe'),
      'bad fingerprint': withLine(4, 'xyz'),
      'bad nonce': withLine(5, 'short'),
      'bad timestamp': withLine(6, 'yesterday'),
      'arbitrary text': encode('sign me please'),
      'oversized': encode('x'.repeat(5000)),
      'not a string': 12345,
    };
    for (const [label, value] of Object.entries(refusals)) {
      const code = codeOf(() => parseApprovalPayload(value));
      // Non-canonical base64 of a real payload can still decode; whatever it is, it must not be accepted as-is.
      assert.ok(code === 'payload_invalid', `${label}: ${code}`);
    }
  });

  test('PAYLOAD: freshness uses the server\'s own challenge lifetime; a future timestamp is refused', () => {
    const { challenge } = realChallenge('apr-fresh');
    const issued = Date.parse(challenge.issued_at);
    assert.strictEqual(codeOf(() => parseApprovalPayload(challenge.payload_base64, { now: issued + getChallengeTtlMs() - 1000 })), null);
    assert.strictEqual(codeOf(() => parseApprovalPayload(challenge.payload_base64, { now: issued + getChallengeTtlMs() + 1000 })), 'challenge_expired');
    assert.strictEqual(codeOf(() => parseApprovalPayload(challenge.payload_base64, { now: issued - 60 * 60 * 1000 })), 'payload_invalid');
  });

  test('PAYLOAD BINDING: the approval the page shows must be the one inside the signed bytes', () => {
    const { challenge } = realChallenge('apr-bind');
    const { fields } = parseApprovalPayload(challenge.payload_base64);
    assert.strictEqual(codeOf(() => bindRequestToPayload(signBody(challenge), fields)), null);
    for (const [field, value] of [['request_id', 'apr-other'], ['decision', 'rejected'], ['decided_by', 'someone-else'], ['nonce', 'a'.repeat(43)]]) {
      assert.strictEqual(codeOf(() => bindRequestToPayload(signBody(challenge, { [field]: value }), fields)), 'payload_mismatch', field);
    }
    assert.strictEqual(codeOf(() => bindRequestToPayload({ payload_base64: challenge.payload_base64 }, fields)), 'payload_mismatch');
  });

  // ---- The key (Windows file-system failures) ------------------------------------------------------
  test('KEY: the Ed25519 key is loaded; missing, locked, protected, invalid, public or non-Ed25519 keys are refused with codes', () => {
    const key = loadApprovalPrivateKey(KEY_PATH);
    assert.strictEqual(key.asymmetricKeyType, 'ed25519');
    assert.strictEqual(publicKeyFingerprint(key), crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16));

    const failWith = (code) => () => {
      const err = new Error(`${code}: simulated`);
      err.code = code;
      throw err;
    };
    assert.strictEqual(codeOf(() => loadApprovalPrivateKey(path.join(TEMP_DIR, 'missing.pem'))), 'key_not_found');
    assert.strictEqual(codeOf(() => loadApprovalPrivateKey(TEMP_DIR)), 'key_not_found', 'a folder is not a key file');
    assert.strictEqual(codeOf(() => loadApprovalPrivateKey('')), 'key_not_found');
    for (const windowsCode of ['EACCES', 'EPERM', 'EBUSY']) {
      assert.strictEqual(codeOf(() => loadApprovalPrivateKey('C:\\approval-key\\approval-private.pem', { readFile: failWith(windowsCode) })), 'key_access_denied', windowsCode);
    }
    assert.strictEqual(codeOf(() => loadApprovalPrivateKey('k', { readFile: () => Buffer.from('not a key') })), 'key_invalid');
    const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
    assert.strictEqual(codeOf(() => loadApprovalPrivateKey('k', { readFile: () => Buffer.from(publicPem) })), 'key_invalid', 'a public key cannot sign');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.strictEqual(codeOf(() => loadApprovalPrivateKey('k', { readFile: () => Buffer.from(rsa) })), 'key_not_ed25519');

    // The file bytes are wiped after use.
    const material = Buffer.from(PRIVATE_PEM);
    loadApprovalPrivateKey('k', { readFile: () => material });
    assert.ok(material.every((byte) => byte === 0), 'the private key file contents are zeroed after the key is parsed');

    // Refusal messages carry no key material and no underlying error text.
    for (const entry of Object.values(SIGNING_HELPER_ERRORS)) {
      assert.ok(!/PRIVATE KEY|BEGIN|simulated/.test(entry.message));
    }
  });

  // ---- The owner's confirmation window (Windows) ---------------------------------------------------
  await testAsync('CONFIRMATION: Yes signs, No declines; the text reaches PowerShell only through the environment', async () => {
    const { challenge } = realChallenge('apr-confirm');
    const text = describeForConfirmation(parseApprovalPayload(challenge.payload_base64).fields);
    assert.ok(text.includes('apr-confirm') && text.includes('approved') && text.includes('naeema'), text);

    const yes = fakeSpawn({ stdout: 'Yes\r\n' });
    assert.strictEqual(await windowsConfirmation(text, { spawnImpl: yes.spawnImpl, platform: 'win32' }), true);
    const [invocation] = yes.calls;
    assert.strictEqual(invocation.command, CONFIRMATION_COMMAND);
    assert.deepStrictEqual(invocation.args, CONFIRMATION_ARGS, 'a fixed command line');
    assert.ok(!invocation.args.join(' ').includes('apr-confirm') && !invocation.args.join(' ').includes(challenge.nonce), 'no payload text in the command');
    assert.strictEqual(invocation.options.env[CONFIRM_TEXT_ENV], text, 'the text is passed through the environment');
    assert.ok(/MessageBoxDefaultButton\]::Button2/.test(CONFIRMATION_ARGS.join(' ')), 'the default button is No');

    const no = fakeSpawn({ stdout: 'No\r\n' });
    assert.strictEqual(await asyncCodeOf(windowsConfirmation(text, { spawnImpl: no.spawnImpl, platform: 'win32' })), 'declined_by_owner');
  });

  await testAsync('CONFIRMATION FAILURES: not Windows, PowerShell missing, a crash or odd output, or no answer - never a signature', async () => {
    const text = 'Sign?';
    assert.strictEqual(await asyncCodeOf(windowsConfirmation(text, { platform: 'linux' })), 'confirmation_unavailable');
    const missing = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' });
    assert.strictEqual(await asyncCodeOf(windowsConfirmation(text, { spawnImpl: fakeSpawn({ error: missing }).spawnImpl, platform: 'win32' })), 'confirmation_unavailable');
    assert.strictEqual(await asyncCodeOf(windowsConfirmation(text, { spawnImpl: fakeSpawn({ throwOnSpawn: true }).spawnImpl, platform: 'win32' })), 'confirmation_unavailable');
    assert.strictEqual(await asyncCodeOf(windowsConfirmation(text, { spawnImpl: fakeSpawn({ stdout: 'Yes', code: 1 }).spawnImpl, platform: 'win32' })), 'confirmation_unavailable');
    assert.strictEqual(await asyncCodeOf(windowsConfirmation(text, { spawnImpl: fakeSpawn({ stdout: 'Maybe' }).spawnImpl, platform: 'win32' })), 'confirmation_unavailable');
    const hanging = fakeSpawn({ hang: true });
    assert.strictEqual(await asyncCodeOf(windowsConfirmation(text, { spawnImpl: hanging.spawnImpl, platform: 'win32', timeoutMs: 20 })), 'confirmation_timeout');
    assert.strictEqual(hanging.calls[0].child.killed, true, 'an unanswered window is closed');
  });

  // ---- The helper over HTTP ------------------------------------------------------------------------
  await testAsync('SIGN: a real challenge, signed after the local Yes, is accepted by the server\'s unchanged verifier - once', async () => {
    const { request, challenge } = realChallenge('apr-http-sign');
    const asked = [];
    await withHelper({ confirm: async (text, fields) => { asked.push({ text, fields }); return true; } }, async ({ port, address, logs }) => {
      assert.strictEqual(address, LISTEN_HOST, 'listens on loopback only');
      const res = await call(port, { body: signBody(challenge) });
      assert.strictEqual(res.status, 200, res.raw);
      assert.deepStrictEqual(Object.keys(res.json), ['signature'], 'only the signature is returned');
      assert.strictEqual(res.headers['access-control-allow-origin'], DASHBOARD_ORIGIN);
      assert.ok(crypto.verify(null, Buffer.from(challenge.payload, 'utf8'), keys.publicKey, Buffer.from(res.json.signature, 'base64')), 'a signature over the exact payload bytes');
      assert.strictEqual(asked.length, 1, 'the owner was asked exactly once');
      assert.ok(asked[0].text.includes('apr-http-sign'));

      const verified = verifyApprovalAuthorization({ request, decision: 'approved', decidedBy: 'naeema', authorization: { nonce: challenge.nonce, signature: res.json.signature } });
      assert.strictEqual(verified.verified, true, verified.reason);
      const replay = verifyApprovalAuthorization({ request, decision: 'approved', decidedBy: 'naeema', authorization: { nonce: challenge.nonce, signature: res.json.signature } });
      assert.strictEqual(replay.failed_check, 'challenge_not_already_used', 'the nonce still authorizes one decision only');
      assert.deepStrictEqual(logs.map((entry) => entry.event), ['sign_requested', 'signed']);
    });
  });

  await testAsync('DECLINED: when the owner says No, nothing is signed', async () => {
    const { challenge } = realChallenge('apr-http-declined');
    await withHelper({ confirm: async () => false }, async ({ port }) => {
      const res = await call(port, { body: signBody(challenge) });
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(res.json, { error: SIGNING_HELPER_ERRORS.declined_by_owner.message, code: 'declined_by_owner' });
      assert.ok(!('signature' in res.json));
    });
  });

  await testAsync('ORIGIN AND HOST: another site, no Origin, or a DNS-rebinding Host get nothing - not even CORS headers', async () => {
    const { challenge } = realChallenge('apr-http-origin');
    let asked = 0;
    await withHelper({ confirm: async () => { asked += 1; return true; } }, async ({ port }) => {
      for (const origin of ['https://evil.example', 'null', null, `${DASHBOARD_ORIGIN}.evil.example`]) {
        const res = await call(port, { origin, body: signBody(challenge) });
        assert.strictEqual(res.status, 403, String(origin));
        assert.strictEqual(res.json.code, 'origin_not_allowed');
        assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
      }
      const rebinding = await call(port, { host: `evil.example:${port}`, body: signBody(challenge) });
      assert.strictEqual(rebinding.status, 403);
      assert.strictEqual(rebinding.json.code, 'host_not_allowed');
      const preflightFromEvil = await call(port, { method: 'OPTIONS', origin: 'https://evil.example', headers: { 'Access-Control-Request-Private-Network': 'true' } });
      assert.strictEqual(preflightFromEvil.status, 403);
      assert.strictEqual(preflightFromEvil.headers['access-control-allow-private-network'], undefined);
    });
    assert.strictEqual(asked, 0, 'the owner is never asked for a refused request');
  });

  await testAsync('PREFLIGHT: the Dashboard origin gets a CORS and Private Network Access preflight answer', async () => {
    await withHelper({}, async ({ port }) => {
      const res = await call(port, {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type', 'Access-Control-Request-Private-Network': 'true' },
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers['access-control-allow-origin'], DASHBOARD_ORIGIN);
      assert.strictEqual(res.headers['access-control-allow-private-network'], 'true');
      assert.ok(/POST/.test(res.headers['access-control-allow-methods']));
      assert.ok(/content-type/i.test(res.headers['access-control-allow-headers']));
    });
  });

  await testAsync('MALFORMED REQUESTS: wrong content type, oversized, bad JSON, a foreign payload or a mismatch - refused before any prompt', async () => {
    const { challenge } = realChallenge('apr-http-malformed');
    let asked = 0;
    await withHelper({ confirm: async () => { asked += 1; return true; } }, async ({ port }) => {
      assert.strictEqual((await call(port, { contentType: 'text/plain', body: JSON.stringify(signBody(challenge)) })).json.code, 'unsupported_media_type');
      assert.strictEqual((await call(port, { body: JSON.stringify({ ...signBody(challenge), padding: 'x'.repeat(9000) }) })).status, 413);
      assert.strictEqual((await call(port, { body: '{not json' })).json.code, 'request_invalid');
      assert.strictEqual((await call(port, { body: '[]' })).json.code, 'request_invalid');
      assert.strictEqual((await call(port, { body: signBody(challenge, { payload_base64: encode('please sign this') }) })).json.code, 'payload_invalid');
      assert.strictEqual((await call(port, { body: signBody(challenge, { request_id: 'apr-someone-else' }) })).json.code, 'payload_mismatch');
      assert.strictEqual((await call(port, { method: 'GET' })).json.code, 'method_not_allowed');
      assert.strictEqual((await call(port, { method: 'GET', path: '/private-key' })).status, 404);
    });
    assert.strictEqual(asked, 0);
  });

  await testAsync('ONE AT A TIME: while a confirmation window is open, another request is refused as busy', async () => {
    const first = realChallenge('apr-http-busy-1').challenge;
    const second = realChallenge('apr-http-busy-2').challenge;
    let release;
    const opened = new Promise((resolve) => {
      release = resolve;
    });
    let answer;
    let confirmations = 0;
    // The first confirmation window stays open until the test answers it; any later one is answered Yes at once.
    const confirm = () => {
      confirmations += 1;
      if (confirmations > 1) return Promise.resolve(true);
      release();
      return new Promise((resolve) => { answer = resolve; });
    };
    await withHelper({ confirm }, async ({ port }) => {
      const pending = call(port, { body: signBody(first) });
      await opened;
      const busy = await call(port, { body: signBody(second) });
      assert.strictEqual(busy.status, 409);
      assert.strictEqual(busy.json.code, 'busy');
      answer(true);
      assert.strictEqual((await pending).status, 200);
      assert.strictEqual((await call(port, { body: signBody(second) })).status, 200, 'free again once answered');
    });
  });

  await testAsync('KEY PROBLEMS OVER HTTP: a missing or locked key is reported without ever asking the owner', async () => {
    const { challenge } = realChallenge('apr-http-key');
    for (const [readFile, code] of [
      [(p) => { throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); }, 'key_not_found'],
      [() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, 'key_access_denied'],
    ]) {
      let asked = 0;
      await withHelper({ readFile, confirm: async () => { asked += 1; return true; } }, async ({ port }) => {
        const res = await call(port, { body: signBody(challenge) });
        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.json.code, code);
        const status = await call(port, { method: 'GET', path: '/status' });
        assert.deepStrictEqual(status.json, { status: 'key_unavailable', code, error: SIGNING_HELPER_ERRORS[code].message });
      });
      assert.strictEqual(asked, 0, `${code}: no pointless confirmation`);
    }
  });

  await testAsync('STATUS: ready, with the PUBLIC key fingerprint only', async () => {
    await withHelper({}, async ({ port }) => {
      const res = await call(port, { method: 'GET', path: '/status' });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.json, { status: 'ready', public_key_fingerprint: publicKeyFingerprint(loadApprovalPrivateKey(KEY_PATH)) });
    });
  });

  await testAsync('PORT IN USE: a second helper on the same port is refused with a clear code', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, LISTEN_HOST, resolve));
    const { port } = blocker.address();
    try {
      const helper = createSigningHelper({ keyPath: KEY_PATH, allowedOrigins: [DASHBOARD_ORIGIN], confirm: async () => true });
      let error = null;
      try {
        const server = await helper.listen(port);
        server.close();
      } catch (err) {
        error = err;
      }
      assert.ok(error, 'listening on a busy port fails');
      assert.strictEqual(error.code, 'port_in_use');
      assert.ok(error.message.includes(String(port)));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  // ---- Start-up (CLI) ------------------------------------------------------------------------------
  await testAsync('START-UP: refuses on non-Windows, without an origin, with a broken key, or on a busy port; ready shows only the fingerprint', async () => {
    const capture = () => {
      const lines = [];
      return { lines, output: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) } };
    };
    const run = async (options) => {
      const { lines, output } = capture();
      const code = await main({ env: {}, output, ...options });
      SEEN.push(...lines);
      return { code, text: lines.join('\n') };
    };
    const args = ['--key', KEY_PATH, '--allow-origin', DASHBOARD_ORIGIN];

    assert.strictEqual((await run({ argv: args, platform: 'linux' })).code, 1);
    const noOrigin = await run({ argv: ['--key', KEY_PATH], platform: 'win32' });
    assert.strictEqual(noOrigin.code, 1);
    assert.ok(/No Dashboard origin is allowed/.test(noOrigin.text));
    const brokenKey = await run({ argv: ['--key', path.join(TEMP_DIR, 'missing.pem'), '--allow-origin', DASHBOARD_ORIGIN], platform: 'win32' });
    assert.strictEqual(brokenKey.code, 1);
    assert.ok(brokenKey.text.includes('key_not_found'));
    assert.strictEqual((await run({ argv: ['--bogus'], platform: 'win32' })).code, 1);

    const busyHelper = () => ({ allowedOrigins: new Set([DASHBOARD_ORIGIN]), listen: async () => { throw Object.assign(new Error('Port 47321 on 127.0.0.1 is already in use - the signing helper may already be running.'), { code: 'port_in_use' }); } });
    const busy = await run({ argv: args, platform: 'win32', createHelper: busyHelper });
    assert.strictEqual(busy.code, 2);
    assert.ok(/already in use/.test(busy.text));

    let listenedOn = null;
    const readyHelper = () => ({ allowedOrigins: new Set([DASHBOARD_ORIGIN]), listen: async (port) => { listenedOn = port; } });
    const ready = await run({ argv: args, platform: 'win32', createHelper: readyHelper });
    assert.strictEqual(ready.code, 0);
    assert.strictEqual(listenedOn, DEFAULT_PORT, 'the Dashboard\'s port by default');
    assert.ok(ready.text.includes(publicKeyFingerprint(loadApprovalPrivateKey(KEY_PATH))));
    assert.ok(!ready.text.includes('PRIVATE KEY') && !ready.text.includes(PRIVATE_PEM_BODY.slice(0, 20)));
  });

  // ---- Boundaries ----------------------------------------------------------------------------------
  test('BOUNDARY: no server, agent or Dashboard code loads the helper, and the launcher embeds no URL or key', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'verification', 'localSigningHelper', 'Claude outputs', 'ai-agent-studio-fix', 'memory'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|html)$/.test(entry.name) && /localSigningHelper/.test(fs.readFileSync(full, 'utf8').replace(/start-local-signing-helper\.cmd|approvals\/localSigningHelper\//g, ''))) {
          offenders.push(path.relative(PROJECT_ROOT, full));
        }
      }
    };
    walk(PROJECT_ROOT);
    assert.deepStrictEqual(offenders, [], 'only the helper itself and its tests refer to it');

    const launcher = fs.readFileSync(path.join(PROJECT_ROOT, 'approvals', 'localSigningHelper', 'start-local-signing-helper.cmd'), 'utf8');
    assert.ok(!/https?:\/\//.test(launcher) && !/PRIVATE KEY/.test(launcher), 'the launcher carries neither a Dashboard URL nor key material');
    assert.ok(fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('*.pem'), 'private key files are never committed');
  });

  test('NO KEY MATERIAL: nothing any helper returned or logged in this suite contains the private key', () => {
    const everything = SEEN.join('\n');
    assert.ok(everything.length > 0);
    assert.ok(!everything.includes('PRIVATE KEY'));
    assert.ok(!everything.includes(PRIVATE_PEM_BODY));
    assert.ok(!everything.includes(PRIVATE_PEM_BODY.slice(16, 48)));
  });

  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
