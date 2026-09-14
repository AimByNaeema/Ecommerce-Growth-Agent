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

function extractSigningBlock() {
  const start = DASHBOARD_SOURCE.indexOf(START_MARKER);
  const end = DASHBOARD_SOURCE.indexOf(END_MARKER, start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'the signing block is present in public/dashboard.js');
  return DASHBOARD_SOURCE.slice(start, end);
}

function drawerMarkup() {
  const start = INDEX_HTML.indexOf('<div class="workflow-drawer" id="signingDrawer"');
  assert.ok(start !== -1, 'the signing drawer is present in public/index.html');
  const end = INDEX_HTML.indexOf('</aside>', start);
  return INDEX_HTML.slice(start, end);
}

// A minimal browser boundary: only what the signing block touches.
function makeBrowser({ challengeResponse, clipboard = true } = {}) {
  const ids = [...drawerMarkup().matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const elements = new Map();
  const state = { focused: null, clipboardWrites: [], execCommands: [], apiCalls: [] };
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
      select: () => { element.selected = true; },
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
      execCommand: (command) => { state.execCommands.push(command); return true; },
    },
    navigator: clipboard
      ? { clipboard: { writeText: (text) => { state.clipboardWrites.push(text); return Promise.resolve(); } } }
      : {},
    apiFetch: async (url) => {
      state.apiCalls.push(url);
      const { status, body } = challengeResponse;
      return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) };
    },
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(`${extractSigningBlock()}\nthis.collectSignedApproval = collectSignedApproval;`, context);
  const pressKey = (key) => (documentListeners.keydown || []).slice().forEach((handler) => handler({ key }));
  const keydownListeners = () => (documentListeners.keydown || []).length;
  return { context, elements, state, pressKey, keydownListeners };
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

  await testAsync('COPY: the copy buttons copy the exact field text; without the clipboard API the field is selected and copied', async () => {
    const { request, challenge } = realChallenge('apr-drawer-2');
    const browser = makeBrowser({ challengeResponse: { status: 200, body: challenge } });
    const pending = browser.context.collectSignedApproval({ approvalId: request.id, decision: 'approved', decidedBy: DECIDED_BY });
    await opened(browser);
    browser.elements.get('signingCopyPayloadBase64').click();
    browser.elements.get('signingCopyCommand').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(browser.state.clipboardWrites, [challenge.payload_base64, browser.elements.get('signingCommand').value]);
    assert.strictEqual(browser.elements.get('signingStatus').textContent, 'Signing command copied.');
    browser.elements.get('signingCancel').click();
    await pending;

    const noClipboard = makeBrowser({ challengeResponse: { status: 200, body: realChallenge('apr-drawer-3').challenge }, clipboard: false });
    const again = noClipboard.context.collectSignedApproval({ approvalId: 'apr-drawer-3', decision: 'approved', decidedBy: DECIDED_BY });
    await opened(noClipboard);
    const field = noClipboard.elements.get('signingPayloadBase64');
    field.selected = false;
    noClipboard.elements.get('signingCopyPayloadBase64').click();
    assert.strictEqual(field.selected, true);
    assert.deepStrictEqual(noClipboard.state.execCommands, ['copy']);
    assert.strictEqual(noClipboard.elements.get('signingStatus').textContent, 'payload_base64 copied.');
    noClipboard.pressKey('Escape');
    await again;
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
  if (failed > 0) process.exit(1);
})();
