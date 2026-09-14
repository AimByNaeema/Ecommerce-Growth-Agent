'use strict';

// The dashboard's approval signing step.
//
// THE DEFECT. public/dashboard.js showed the signing challenge in window.prompt(). A browser
// dialog's text cannot be selected or copied, so the owner could not copy payload_base64 (or the
// signing command that carries it) to the machine holding the private key.
//
// THE FIX IS DISPLAY ONLY. The challenge is shown in the signing drawer (public/index.html
// #signingDrawer) as readonly, selectable text with copy buttons, and the pasted signature is
// returned exactly as before. The server's challenge, payload bytes and verification are untouched.
//
// WHAT IS TESTED. The REAL signing block, read from public/dashboard.js and run in an isolated vm
// context against a DOM built from the drawer's own ids in public/index.html. The challenge is a
// real one from approvals/approvalArchitecture.js, and the returned signature is verified by the
// server's own verifier - so this proves the shipped code carries the issued bytes end to end.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  APPROVAL_PUBLIC_KEY_ENV,
  issueApprovalChallenge,
  verifyApprovalAuthorization,
} = require('../../approvals/approvalArchitecture');

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

const DASHBOARD_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const START_MARKER = '// SIGNED HUMAN APPROVAL';
const END_MARKER = '  function attachApprovalPanel';

// `source`: the dashboard.js text to run - the file on disk, or the bytes the real app serves.
function extractSigningBlock(source = DASHBOARD_SOURCE) {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER, start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'the signing block is present in dashboard.js');
  return source.slice(start, end);
}

function drawerMarkup() {
  const start = INDEX_HTML.indexOf('<div class="workflow-drawer" id="signingDrawer"');
  assert.ok(start !== -1, 'the signing drawer is present in public/index.html');
  const end = INDEX_HTML.indexOf('</aside>', start);
  return INDEX_HTML.slice(start, end);
}

// A minimal browser boundary: only what the signing block touches.
// `copyEvent`: whether execCommand('copy') raises a copy event (real browsers do, inside a click).
// `clipboard`: 'ok' | 'reject' | 'absent' - the async clipboard API's behaviour.
// `copyEventWrites`: whether a raised copy event actually reaches the system clipboard (a browser can
// raise it and still leave the clipboard untouched). `initialClipboard`: what the clipboard held before.
// `source`: which dashboard.js to run. `assetVersions`: the ETag the server reports for dashboard.js on
// each successive HEAD request (the first is the version the page loaded); null = unknown.
function makeBrowser({
  challengeResponse,
  clipboard = 'ok',
  copyEvent = true,
  copyEventWrites = true,
  initialClipboard = null,
  source = DASHBOARD_SOURCE,
  assetVersions = ['W/"dashboard-v1"'],
} = {}) {
  const ids = [...drawerMarkup().matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const elements = new Map();
  const state = { focused: null, clipboardText: initialClipboard, clipboardWrites: [], execCommands: [], apiCalls: [], assetRequests: [] };
  const versions = assetVersions.slice();
  const makeElement = (id) => {
    const listeners = {};
    const element = {
      id,
      value: '',
      textContent: '',
      hidden: true,
      selected: false,
      listeners,
      addEventListener: (type, handler) => { (listeners[type] = listeners[type] || []).push(handler); },
      removeEventListener: (type, handler) => { listeners[type] = (listeners[type] || []).filter((entry) => entry !== handler); },
      focus: () => { state.focused = id; },
      select: () => { element.selected = true; element.selection = [0, element.value.length]; },
      setSelectionRange: (start, end) => { element.selection = [start, end]; },
      dispatch: (type, event) => { (listeners[type] || []).slice().forEach((handler) => handler(event)); },
      click: () => { (listeners.click || []).slice().forEach((handler) => handler({})); },
    };
    return element;
  };
  for (const id of ids) elements.set(id, makeElement(id));
  const documentListeners = {};
  const context = {
    document: {
      getElementById: (id) => elements.get(id) || null,
      addEventListener: (type, handler) => { (documentListeners[type] = documentListeners[type] || []).push(handler); },
      removeEventListener: (type, handler) => { documentListeners[type] = (documentListeners[type] || []).filter((entry) => entry !== handler); },
      // A real copy event: listeners decide what reaches the clipboard through clipboardData.
      execCommand: (command) => {
        state.execCommands.push(command);
        if (command !== 'copy' || !copyEvent) return false;
        const data = {};
        const event = { clipboardData: { setData: (type, value) => { data[type] = value; } }, preventDefault: () => { event.defaultPrevented = true; } };
        (documentListeners.copy || []).slice().forEach((handler) => handler(event));
        if (copyEventWrites && event.defaultPrevented && Object.prototype.hasOwnProperty.call(data, 'text/plain')) state.clipboardText = data['text/plain'];
        return true;
      },
    },
    navigator:
      clipboard === 'absent'
        ? {}
        : {
            clipboard: {
              writeText: (text) => {
                state.clipboardWrites.push(text);
                if (clipboard === 'reject') return Promise.reject(new Error('NotAllowedError'));
                state.clipboardText = text;
                return Promise.resolve();
              },
            },
          },
    apiFetch: async (url) => {
      state.apiCalls.push(url);
      const { status, body } = challengeResponse;
      return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) };
    },
    // Plain fetch is used only for the public dashboard.js version check.
    fetch: async (url, options = {}) => {
      state.assetRequests.push({ url, method: options.method || 'GET', headers: options.headers || null });
      const version = versions.length > 1 ? versions.shift() : versions[0];
      if (version === 'unreachable') throw new Error('network error');
      return { ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === 'etag' ? version : null) } };
    },
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(`${extractSigningBlock(source)}\nthis.collectSignedApproval = collectSignedApproval;`, context);
  const pressKey = (key) => (documentListeners.keydown || []).slice().forEach((handler) => handler({ key }));
  const keydownListeners = () => (documentListeners.keydown || []).length;
  const copyListeners = () => (documentListeners.copy || []).length;
  return { context, elements, state, pressKey, keydownListeners, copyListeners };
}

// Waits until the drawer has been opened by the pending collectSignedApproval call.
async function opened(browser) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!browser.elements.get('signingDrawer').hidden) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the signing drawer was never opened');
}

const keys = crypto.generateKeyPairSync('ed25519');
process.env[APPROVAL_PUBLIC_KEY_ENV] = keys.publicKey.export({ type: 'spki', format: 'pem' });
const DECIDED_BY = 'naeema';

function realChallenge(id) {
  const request = { id, status: 'pending', execution_request: { objective: 'Apply the stored SEO proposal', tool_id: 'shopify_product_seo_update' } };
  return { request, challenge: issueApprovalChallenge({ request, decision: 'approved', decidedBy: DECIDED_BY }) };
}

(async () => {
  // ---- The page: a selectable drawer, never a browser dialog ------------------------------------
  test('the signing drawer is ordinary page text: readonly payload_base64 and command, editable signature, hidden until needed', () => {
    const markup = drawerMarkup();
    assert.ok(/<div class="workflow-drawer" id="signingDrawer" hidden>/.test(markup), 'hidden until a signature is needed');
    assert.ok(/<textarea[^>]*id="signingPayloadBase64"[^>]*readonly/.test(markup), 'payload_base64 is a readonly, selectable field');
    assert.ok(/<textarea[^>]*id="signingCommand"[^>]*readonly/.test(markup), 'the signing command is a readonly, selectable field');
    assert.ok(/<textarea(?![^>]*readonly)[^>]*id="signingSignature"/.test(markup), 'the signature field is editable');
    for (const id of ['signingCopyPayloadBase64', 'signingCopyCommand', 'signingSubmit', 'signingCancel', 'signingDrawerClose', 'signingPayload', 'signingInstructions', 'signingStatus']) {
      assert.ok(markup.includes(`id="${id}"`), `${id} is present`);
    }
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.css'), 'utf8');
    assert.ok(/\.signing-field\s*\{[^}]*user-select:\s*text/.test(css), 'the fields are selectable');
  });

  test('the signing block uses no browser dialog and never touches a private key, and every element it uses exists', () => {
    const block = extractSigningBlock();
    assert.ok(!/window\.prompt|window\.alert|\bprompt\(|\balert\(/.test(block.replace(/\/\/.*$/gm, '')), 'no prompt() or alert() in the signing step');
    assert.ok(!/BEGIN PRIVATE KEY|privateKey|createPrivateKey/.test(block), 'the page never handles a private key');
    const markup = drawerMarkup();
    for (const [, id] of block.matchAll(/el\('([^']+)'\)/g)) {
      assert.ok(markup.includes(`id="${id}"`), `the drawer has #${id}`);
    }
  });

  // ---- The real challenge, carried unchanged ----------------------------------------------------
  await testAsync('A REAL CHALLENGE: the drawer shows the server\'s exact payload_base64 and command, and the pasted signature verifies', async () => {
    const { request, challenge } = realChallenge('apr-drawer-1');
    const browser = makeBrowser({ challengeResponse: { status: 200, body: challenge } });
    const pending = browser.context.collectSignedApproval({ approvalId: request.id, decision: 'approved', decidedBy: DECIDED_BY });
    await opened(browser);

    const base64Field = browser.elements.get('signingPayloadBase64');
    assert.strictEqual(base64Field.value, challenge.payload_base64, 'exactly the server\'s payload_base64');
    assert.ok(Buffer.from(base64Field.value, 'base64').equals(Buffer.from(challenge.payload, 'utf8')), 'it decodes to exactly the issued payload bytes');
    assert.strictEqual(browser.state.focused, 'signingPayloadBase64');
    assert.strictEqual(base64Field.selected, true, 'payload_base64 is selected, ready to copy');
    const command = browser.elements.get('signingCommand').value;
    assert.ok(command.startsWith('node -e "') && command.endsWith(` ${challenge.payload_base64}`), command);
    assert.strictEqual(browser.elements.get('signingPayload').textContent, challenge.payload);
    assert.strictEqual(browser.elements.get('signingInstructions').textContent, challenge.signing_instructions.join('\n\n'));
    assert.ok(browser.elements.get('signingDrawerKind').textContent.includes(request.id));

    // What the owner's machine returns: a signature over the decoded payload_base64 bytes.
    const signature = crypto.sign(null, Buffer.from(base64Field.value, 'base64'), keys.privateKey).toString('base64');
    browser.elements.get('signingSignature').value = `  ${signature}\n`;
    browser.elements.get('signingSubmit').click();
    const signed = await pending;

    assert.deepStrictEqual({ ...signed }, { ok: true, nonce: challenge.nonce, signature }, 'the same result shape as before, signature trimmed');
    assert.strictEqual(browser.elements.get('signingDrawer').hidden, true, 'the drawer closes');
    assert.strictEqual(browser.keydownListeners(), 0, 'no listener is left behind');
    assert.deepStrictEqual(browser.state.apiCalls, [`/approval-challenge?approvalId=${request.id}&decision=approved&decidedBy=${DECIDED_BY}`]);
    const verified = verifyApprovalAuthorization({ request, decision: 'approved', decidedBy: DECIDED_BY, authorization: { nonce: signed.nonce, signature: signed.signature } });
    assert.strictEqual(verified.verified, true, verified.reason);
  });

  // ---- COPY (production: Get-Clipboard held 24 characters, not payload_base64) ---------------------
  // Opens a drawer for a real challenge and returns what the copy tests need.
  async function openForCopy(id, options = {}) {
    const { request, challenge } = realChallenge(id);
    const browser = makeBrowser({ challengeResponse: { status: 200, body: challenge }, ...options });
    const pending = browser.context.collectSignedApproval({ approvalId: request.id, decision: 'approved', decidedBy: DECIDED_BY });
    await opened(browser);
    const done = async () => { browser.elements.get('signingCancel').click(); await pending; };
    return { browser, challenge, done };
  }

  await testAsync('COPY (regression): the complete, exact payload_base64 and signing command reach the clipboard inside the click', async () => {
    const { browser, challenge, done } = await openForCopy('apr-drawer-copy-1');
    const status = browser.elements.get('signingStatus');

    browser.elements.get('signingCopyPayloadBase64').click();
    // Synchronously, inside the click - no promise, no lost user activation.
    assert.strictEqual(browser.state.clipboardText, challenge.payload_base64, 'the clipboard holds exactly payload_base64');
    assert.strictEqual(browser.state.clipboardText.length, challenge.payload_base64.length);
    assert.ok(challenge.payload_base64.length > 24, 'a real payload_base64 is far longer than the 24 characters seen in production');
    assert.ok(Buffer.from(browser.state.clipboardText, 'base64').equals(Buffer.from(challenge.payload, 'utf8')), 'the copied value decodes to the exact payload bytes');
    assert.strictEqual(status.textContent, `payload_base64 copied (${challenge.payload_base64.length} characters).`);
    assert.deepStrictEqual(browser.state.clipboardWrites, [challenge.payload_base64], 'the same exact value is also written through the clipboard API in the same click');
    assert.strictEqual(browser.copyListeners(), 0, 'the one-shot copy listener is removed');

    browser.elements.get('signingCopyCommand').click();
    const command = challenge.signing_instructions.find((line) => /node -e ".*'base64'/.test(line)).trim();
    assert.strictEqual(browser.state.clipboardText, command, 'the clipboard holds exactly the signing command');
    assert.ok(browser.state.clipboardText.endsWith(` ${challenge.payload_base64}`));
    assert.strictEqual(status.textContent, `Signing command copied (${command.length} characters).`);
    assert.strictEqual(browser.copyListeners(), 0);
    await done();
  });

  await testAsync('COPY without a copy event: navigator.clipboard.writeText is called in the same click with the exact value', async () => {
    const { browser, challenge, done } = await openForCopy('apr-drawer-copy-2', { copyEvent: false });
    browser.elements.get('signingCopyPayloadBase64').click();
    assert.deepStrictEqual(browser.state.clipboardWrites, [challenge.payload_base64], 'called synchronously during the click, not after a rejection');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(browser.state.clipboardText, challenge.payload_base64);
    assert.strictEqual(browser.elements.get('signingStatus').textContent, `payload_base64 copied (${challenge.payload_base64.length} characters).`);
    await done();
  });

  await testAsync('COPY with no clipboard access: nothing is claimed as copied - the whole value is selected for Ctrl+C', async () => {
    for (const clipboard of ['reject', 'absent']) {
      const { browser, challenge, done } = await openForCopy(`apr-drawer-copy-${clipboard}`, { copyEvent: false, clipboard });
      const field = browser.elements.get('signingPayloadBase64');
      field.selection = null;
      browser.elements.get('signingCopyPayloadBase64').click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(browser.state.clipboardText, null, `${clipboard}: nothing reached the clipboard`);
      assert.deepStrictEqual(field.selection, [0, challenge.payload_base64.length], `${clipboard}: the complete value is selected`);
      assert.strictEqual(browser.state.focused, 'signingPayloadBase64');
      assert.strictEqual(
        browser.elements.get('signingStatus').textContent,
        'payload_base64 could not be copied automatically - it is selected, press Ctrl+C to copy it.',
        clipboard
      );
      assert.ok(!/copied \(/.test(browser.elements.get('signingStatus').textContent), `${clipboard}: never reported as copied`);
      await done();
    }
  });

  // The owner's clipboard kept an earlier 24-character value after clicking Copy.
  const EARLIER_24_CHARACTERS = '2026-09-14T10:48:03.928Z';

  await testAsync('COPY (regression): a copy event that never reaches the system clipboard is backed by the clipboard API in the same click', async () => {
    const { browser, challenge, done } = await openForCopy('apr-drawer-copy-event-no-write', { copyEventWrites: false, initialClipboard: EARLIER_24_CHARACTERS });
    assert.strictEqual(EARLIER_24_CHARACTERS.length, 24);
    browser.elements.get('signingCopyPayloadBase64').click();
    assert.deepStrictEqual(browser.state.clipboardWrites, [challenge.payload_base64], 'written through the clipboard API during the click');
    await new Promise((resolve) => setImmediate(resolve));
    assert.notStrictEqual(browser.state.clipboardText, EARLIER_24_CHARACTERS, 'the earlier 24-character value is replaced');
    assert.strictEqual(browser.state.clipboardText, challenge.payload_base64, 'the clipboard holds the complete, exact payload_base64');
    assert.strictEqual(browser.state.clipboardText.length, challenge.payload_base64.length);
    assert.strictEqual(browser.elements.get('signingStatus').textContent, `payload_base64 copied (${challenge.payload_base64.length} characters).`);

    browser.elements.get('signingCopyCommand').click();
    await new Promise((resolve) => setImmediate(resolve));
    const command = challenge.signing_instructions.find((line) => /node -e ".*'base64'/.test(line)).trim();
    assert.strictEqual(browser.state.clipboardText, command, 'the signing command is copied complete and exact too');
    await done();
  });

  await testAsync('COPY: when the clipboard API refuses but the copy event wrote the value, it is still copied - exact', async () => {
    const { browser, challenge, done } = await openForCopy('apr-drawer-copy-api-refused', { clipboard: 'reject', initialClipboard: EARLIER_24_CHARACTERS });
    browser.elements.get('signingCopyPayloadBase64').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(browser.state.clipboardText, challenge.payload_base64);
    assert.strictEqual(browser.elements.get('signingStatus').textContent, `payload_base64 copied (${challenge.payload_base64.length} characters).`);
    await done();
  });

  await testAsync('MANUAL COPY: clicking, double-clicking or focusing a readonly field selects all of it, and Ctrl+C copies the complete value', async () => {
    const { browser, challenge, done } = await openForCopy('apr-drawer-manual-copy');
    const command = challenge.signing_instructions.find((line) => /node -e ".*'base64'/.test(line)).trim();
    for (const [id, value] of [['signingPayloadBase64', challenge.payload_base64], ['signingCommand', command]]) {
      const field = browser.elements.get(id);
      for (const type of ['click', 'dblclick', 'focus']) {
        // A double-click on base64 would select only the run between '+' or '/' characters.
        field.selection = [10, 34];
        field.dispatch(type, {});
        assert.deepStrictEqual(field.selection, [0, value.length], `${id} ${type}: the whole value is selected`);
      }
      // A copy from the field itself with only part of it selected still carries the complete value.
      field.selection = [10, 34];
      const data = {};
      const event = { clipboardData: { setData: (type, text) => { data[type] = text; } }, preventDefault: () => { event.defaultPrevented = true; } };
      field.dispatch('copy', event);
      assert.strictEqual(event.defaultPrevented, true, `${id}: the partial selection is not what is copied`);
      assert.strictEqual(data['text/plain'], value, `${id}: the complete, exact value is copied`);
    }
    await done();
    // The field listeners are removed with the drawer.
    for (const id of ['signingPayloadBase64', 'signingCommand']) {
      for (const type of ['click', 'dblclick', 'focus', 'copy']) {
        assert.strictEqual((browser.elements.get(id).listeners[type] || []).length, 0, `${id} ${type} listener removed`);
      }
    }
  });

  test('COPY: the copy code runs inside the click - never from a promise rejection handler', () => {
    const block = extractSigningBlock();
    const start = block.indexOf('function copySigningField');
    const body = block.slice(start, block.indexOf('\n  }\n', start));
    assert.ok(/addEventListener\('copy'/.test(body) && /setData\('text\/plain', text\)/.test(body), 'the copy event writes the field value itself');
    assert.ok(!/\.then\([^)]*execCommand/.test(body.replace(/\s+/g, ' ')), 'execCommand is never deferred into a promise callback');
    assert.ok(body.indexOf("execCommand('copy')") < body.indexOf('writeText'), 'the in-gesture copy is attempted first');
  });

  // ---- PRODUCTION-EQUIVALENT -------------------------------------------------------------------------
  // Production: the owner's Get-Clipboard held 22 characters after Copy. Measured on the production origin
  // (read-only): the served dashboard.js was byte-identical to its commit, the responses carried no CSP or
  // Permissions-Policy, and the browser reported clipboard-write as DENIED - navigator.clipboard.writeText
  // rejects there. These tests run the dashboard exactly as the real app serves it, in that runtime.
  const http = require('node:http');
  const { createApp } = require('../../server');
  const EARLIER_22_CHARACTERS = 'previous clipboard 22c';

  async function withServedDashboard(fn) {
    const savedKey = process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEY = 'test-agent-api-key-do-not-use-in-production';
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const fetchAsset = (assetPath, method = 'GET') =>
      new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: assetPath, method }, (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
        });
        req.on('error', reject);
        req.end();
      });
    try {
      await fn(fetchAsset);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (savedKey === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = savedKey;
    }
  }

  await testAsync('PRODUCTION-EQUIVALENT: the real app serves the dashboard byte-for-byte, publicly, with an ETag and no header restricting clipboard writes', async () => {
    await withServedDashboard(async (fetchAsset) => {
      const js = await fetchAsset('/dashboard.js');
      const html = await fetchAsset('/');
      assert.strictEqual(js.status, 200);
      assert.strictEqual(html.status, 200);
      assert.strictEqual(js.raw, DASHBOARD_SOURCE, 'the served dashboard.js is exactly the shipped file');
      assert.strictEqual(html.raw, INDEX_HTML, 'the served index.html is exactly the shipped file');
      for (const response of [js, html]) {
        assert.strictEqual(response.headers['content-security-policy'], undefined, 'no CSP is sent');
        assert.ok(!/clipboard/i.test(response.headers['permissions-policy'] || ''), 'no Permissions-Policy restricts the clipboard');
      }
      const head = await fetchAsset('/dashboard.js', 'HEAD');
      assert.strictEqual(head.status, 200, 'the version check needs no API key');
      assert.ok(head.headers.etag, 'the served asset carries an ETag to identify its version');
    });
  });

  await testAsync('PRODUCTION-EQUIVALENT: with clipboard-write denied, the SERVED copy code replaces the previous 22 characters with the complete, exact payload_base64 and command', async () => {
    await withServedDashboard(async (fetchAsset) => {
      const served = (await fetchAsset('/dashboard.js')).raw;
      const etag = (await fetchAsset('/dashboard.js', 'HEAD')).headers.etag;
      assert.strictEqual(EARLIER_22_CHARACTERS.length, 22);
      const { browser, challenge, done } = await openForCopy('apr-drawer-production-runtime', {
        source: served,
        clipboard: 'reject',
        initialClipboard: EARLIER_22_CHARACTERS,
        assetVersions: [etag],
      });
      browser.elements.get('signingCopyPayloadBase64').click();
      assert.strictEqual(browser.state.clipboardText, challenge.payload_base64, 'written inside the click, although writeText is denied');
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(browser.state.clipboardText, challenge.payload_base64, 'the complete, exact payload_base64 stays on the clipboard');
      assert.strictEqual(browser.state.clipboardText.length, challenge.payload_base64.length);
      assert.ok(Buffer.from(browser.state.clipboardText, 'base64').equals(Buffer.from(challenge.payload, 'utf8')), 'it decodes to the exact signing payload');
      assert.strictEqual(browser.elements.get('signingStatus').textContent, `payload_base64 copied (${challenge.payload_base64.length} characters).`);

      browser.elements.get('signingCopyCommand').click();
      await new Promise((resolve) => setImmediate(resolve));
      const command = challenge.signing_instructions.find((line) => /node -e ".*'base64'/.test(line)).trim();
      assert.strictEqual(browser.state.clipboardText, command, 'the signing command is copied complete and exact');
      assert.strictEqual(browser.elements.get('signingVersionNotice').hidden, true, 'the served version matches - no warning');
      await done();
    });
  });

  await testAsync('STALE TAB: a page still running an older dashboard.js than the server serves is told to reload before copying or signing - never a false alarm', async () => {
    const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
    const stale = await openForCopy('apr-drawer-stale', { assetVersions: ['W/"loaded-earlier"', 'W/"served-now"'] });
    await settle();
    const notice = stale.browser.elements.get('signingVersionNotice');
    assert.strictEqual(notice.hidden, false, 'the warning is shown');
    assert.strictEqual(notice.textContent, 'This page is running an older dashboard than the server now serves. Reload the page (Ctrl+F5) before copying or signing.');
    assert.deepStrictEqual(
      stale.browser.state.assetRequests.map((entry) => [entry.url, entry.method, entry.headers]),
      [['dashboard.js', 'HEAD', null], ['dashboard.js', 'HEAD', null]],
      'a public HEAD request for the asset, carrying no API key'
    );
    await stale.done();

    for (const assetVersions of [['W/"same"'], ['unreachable'], [null]]) {
      const current = await openForCopy(`apr-drawer-version-${String(assetVersions[0])}`, { assetVersions });
      await settle();
      assert.strictEqual(current.browser.elements.get('signingVersionNotice').hidden, true, `${assetVersions[0]}: no warning`);
      await current.done();
    }
  });

  await testAsync('CANCEL: an empty signature is not submitted; Cancel, the close button and Escape return the unchanged cancellation', async () => {
    for (const cancelWith of ['signingCancel', 'signingDrawerClose', 'signingDrawerScrim', 'Escape']) {
      const { request, challenge } = realChallenge(`apr-drawer-cancel-${cancelWith}`);
      const browser = makeBrowser({ challengeResponse: { status: 200, body: challenge } });
      const pending = browser.context.collectSignedApproval({ approvalId: request.id, decision: 'approved', decidedBy: DECIDED_BY });
      await opened(browser);
      browser.elements.get('signingSignature').value = '   ';
      browser.elements.get('signingSubmit').click();
      assert.strictEqual(browser.elements.get('signingDrawer').hidden, false, 'an empty signature keeps the drawer open');
      assert.strictEqual(browser.elements.get('signingStatus').textContent, 'Paste the base64 signature before submitting.');
      if (cancelWith === 'Escape') browser.pressKey('Escape');
      else browser.elements.get(cancelWith).click();
      const signed = await pending;
      assert.deepStrictEqual({ ...signed }, { ok: false, error: 'Approval cancelled - no signature was provided.' }, cancelWith);
      assert.strictEqual(browser.elements.get('signingDrawer').hidden, true);
      assert.strictEqual(browser.keydownListeners(), 0);
    }
  });

  await testAsync('A REFUSED CHALLENGE: the server\'s error is returned and the drawer never opens', async () => {
    const browser = makeBrowser({ challengeResponse: { status: 400, body: { error: 'No pending approval with that id.' } } });
    const signed = await browser.context.collectSignedApproval({ approvalId: 'apr-missing', decision: 'approved', decidedBy: DECIDED_BY });
    assert.deepStrictEqual({ ...signed }, { ok: false, error: 'No pending approval with that id.' });
    assert.strictEqual(browser.elements.get('signingDrawer').hidden, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  // Explicit: the real app started above may leave handles open that would otherwise keep the process alive.
  process.exit(failed > 0 ? 1 : 0);
})();
