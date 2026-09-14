'use strict';

// LOCAL SIGNING HELPER - runs on the APPROVER'S OWN COMPUTER, never on the server.
//
// WHAT IT REPLACES. Approving from the Dashboard meant copying payload_base64 out of the browser and
// running a signing command by hand. This helper signs the same challenge locally, so Approval Center ->
// Approve -> Sign needs no copying and no commands.
//
// WHAT IT DOES NOT CHANGE. The server still issues the challenge (approvals/approvalArchitecture.js), the
// Dashboard still submits { nonce, signature } to the same approve endpoints, and the server still verifies
// the Ed25519 signature, the nonce, the fingerprint and the expiry exactly as before. The helper only
// produces the signature a person used to produce by hand, with the same private key, over the same bytes.
//
// THE PRIVATE KEY STAYS HERE. It is read from a local file (--key / APPROVAL_PRIVATE_KEY_PATH) for each
// signature, used by crypto.sign, and never written, logged, sent, or included in any response or error. A
// response carries only a base64 signature, a public-key fingerprint, or an error code.
//
// WHY A SIGNATURE NEEDS A LOCAL "YES". The Dashboard's code is served by the server. If this helper signed
// whatever the page asked for, anything able to change that page - or any other site able to reach
// 127.0.0.1 - could obtain approvals without the owner, and the human signature would mean nothing. So:
//   - it listens on 127.0.0.1 only, answers only exact allow-listed Dashboard origins, and checks the Host
//     header (a DNS-rebinding page names its own host, not 127.0.0.1);
//   - it signs only an ecom-approval-v1 challenge: exactly seven lines, a fresh issued_at, and the approval
//     id, decision, approver and nonce the page shows must be the ones inside the signed bytes;
//   - every signature waits for the owner to choose Yes in a Windows confirmation window that shows what is
//     being signed - outside the browser, where page code cannot click it. No window, no signature: a
//     timeout, an error, or No all sign nothing;
//   - one signature at a time, so windows cannot be stacked to be clicked through.
//
// The payload reaches the confirmation window only through an environment variable, never inside the
// PowerShell command text, so nothing in a payload can become a command.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { APPROVAL_PAYLOAD_VERSION, getChallengeTtlMs } = require('../approvalArchitecture');

const LISTEN_HOST = '127.0.0.1';
const DEFAULT_PORT = 47321;
const KEY_PATH_ENV = 'APPROVAL_PRIVATE_KEY_PATH';
const ALLOWED_ORIGINS_ENV = 'APPROVAL_SIGNER_ALLOWED_ORIGINS';
const PORT_ENV = 'APPROVAL_SIGNER_PORT';
const CONFIRM_TEXT_ENV = 'APPROVAL_SIGNING_CONFIRM_TEXT';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024;
const PAYLOAD_LINE_COUNT = 7;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CONFIRMATION_TIMEOUT_MS = 2 * 60 * 1000;

// Every refusal the helper can give: a stable code for the Dashboard, an HTTP status, and a message that
// never contains key material or the contents of any file.
const SIGNING_HELPER_ERRORS = {
  origin_not_allowed: { status: 403, message: 'This page is not allowed to use the local signing helper.' },
  host_not_allowed: { status: 403, message: 'Requests must be addressed to the local signing helper on 127.0.0.1.' },
  not_found: { status: 404, message: 'Not found.' },
  method_not_allowed: { status: 405, message: 'Method not allowed.' },
  unsupported_media_type: { status: 415, message: 'The signing request must be sent as JSON.' },
  body_too_large: { status: 413, message: 'The signing request is too large.' },
  request_invalid: { status: 400, message: 'The signing request is not valid JSON with the expected fields.' },
  payload_invalid: { status: 400, message: 'The payload is not an approval challenge this helper signs. Nothing was signed.' },
  payload_mismatch: { status: 400, message: 'The approval shown does not match the payload to be signed. Nothing was signed.' },
  challenge_expired: { status: 410, message: 'This approval challenge is too old to sign. Request a new one. Nothing was signed.' },
  busy: { status: 409, message: 'Another approval is already waiting for your confirmation in the signing helper window.' },
  declined_by_owner: { status: 403, message: 'You declined to sign this approval in the signing helper window. Nothing was signed.' },
  confirmation_timeout: { status: 408, message: 'The signing helper window was not answered in time. Nothing was signed.' },
  confirmation_unavailable: { status: 503, message: 'The signing helper could not show its confirmation window on this computer, so nothing was signed.' },
  key_not_found: { status: 500, message: 'The approval private key file was not found at the path the signing helper was started with.' },
  key_access_denied: { status: 500, message: 'The signing helper could not read the approval private key file (access denied or locked).' },
  key_invalid: { status: 500, message: 'The approval private key file does not contain a readable private key.' },
  key_not_ed25519: { status: 500, message: 'The approval private key is not an Ed25519 key.' },
  signing_failed: { status: 500, message: 'The signing helper could not sign this approval. Nothing was signed.' },
};

class SigningHelperError extends Error {
  constructor(code) {
    const known = SIGNING_HELPER_ERRORS[code] || SIGNING_HELPER_ERRORS.signing_failed;
    super(known.message);
    this.name = 'SigningHelperError';
    this.code = SIGNING_HELPER_ERRORS[code] ? code : 'signing_failed';
    this.status = known.status;
  }
}

// --- Configuration ----------------------------------------------------------------------------------

// Exact origins only (scheme + host + port). https, or plain http on localhost / 127.0.0.1 for a local
// Dashboard. No wildcards and no paths: an allow-list that matched loosely would let other sites sign.
function normalizeAllowedOrigins(value) {
  const entries = (Array.isArray(value) ? value : String(value || '').split(','))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`No Dashboard origin is allowed. Start the helper with --allow-origin https://your-dashboard or set ${ALLOWED_ORIGINS_ENV}.`);
  }
  const origins = new Set();
  for (const entry of entries) {
    let url;
    try {
      url = new URL(entry);
    } catch (err) {
      throw new Error(`"${entry}" is not a valid Dashboard origin.`);
    }
    const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if ((url.protocol !== 'https:' && !localHttp) || url.origin !== entry.replace(/\/$/, '') || entry.includes('*')) {
      throw new Error(`"${entry}" is not an exact https Dashboard origin (for example https://dashboard.example.com).`);
    }
    origins.add(url.origin);
  }
  return origins;
}

// --- The payload ------------------------------------------------------------------------------------

// Parses payload_base64 into the exact bytes to sign, refusing anything that is not a fresh
// ecom-approval-v1 challenge (approvals/approvalArchitecture.js buildApprovalPayload's seven fields).
function parseApprovalPayload(payloadBase64, { now = Date.now(), maxAgeMs = getChallengeTtlMs() } = {}) {
  if (typeof payloadBase64 !== 'string' || payloadBase64.length === 0 || payloadBase64.length > Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 4) {
    throw new SigningHelperError('payload_invalid');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payloadBase64)) throw new SigningHelperError('payload_invalid');
  const bytes = Buffer.from(payloadBase64, 'base64');
  // Canonical base64 only, so exactly one byte string corresponds to what the page sent.
  if (bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES || bytes.toString('base64') !== payloadBase64) {
    throw new SigningHelperError('payload_invalid');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || /[\r\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    throw new SigningHelperError('payload_invalid');
  }
  const lines = text.split('\n');
  if (lines.length !== PAYLOAD_LINE_COUNT) throw new SigningHelperError('payload_invalid');
  const [version, requestId, decision, decidedBy, fingerprint, nonce, issuedAt] = lines;
  const printable = (value) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
  const issuedMs = Date.parse(issuedAt);
  if (
    version !== APPROVAL_PAYLOAD_VERSION ||
    !printable(requestId) ||
    (decision !== 'approved' && decision !== 'rejected') ||
    !printable(decidedBy) ||
    !/^[0-9a-f]{64}$/.test(fingerprint) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !Number.isFinite(issuedMs) ||
    new Date(issuedMs).toISOString() !== issuedAt
  ) {
    throw new SigningHelperError('payload_invalid');
  }
  if (issuedMs - now > MAX_CLOCK_SKEW_MS) throw new SigningHelperError('payload_invalid');
  if (now - issuedMs > maxAgeMs) throw new SigningHelperError('challenge_expired');
  return {
    bytes,
    fields: { request_id: requestId, decision, decided_by: decidedBy, execution_fingerprint: fingerprint, nonce, issued_at: issuedAt },
  };
}

// What the page says it is asking to sign must be what the bytes say.
function bindRequestToPayload(body, fields) {
  for (const field of ['request_id', 'decision', 'decided_by', 'nonce']) {
    if (typeof body[field] !== 'string' || body[field] !== fields[field]) throw new SigningHelperError('payload_mismatch');
  }
}

// --- The key ----------------------------------------------------------------------------------------

// Reads the private key for one signature. File-system errors are mapped to codes (Windows reports a
// locked or protected file as EPERM/EACCES/EBUSY); nothing from the file or the underlying error is kept.
function loadApprovalPrivateKey(keyPath, { readFile = fs.readFileSync } = {}) {
  if (typeof keyPath !== 'string' || keyPath.trim() === '') throw new SigningHelperError('key_not_found');
  let material;
  try {
    material = readFile(keyPath);
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') throw new SigningHelperError('key_not_found');
    throw new SigningHelperError('key_access_denied');
  }
  let key;
  try {
    key = crypto.createPrivateKey(material);
  } catch (err) {
    throw new SigningHelperError('key_invalid');
  } finally {
    if (Buffer.isBuffer(material)) material.fill(0);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new SigningHelperError('key_not_ed25519');
  return key;
}

// A short, public identifier for the key in use - the SHA-256 of its PUBLIC half. Safe to show.
function publicKeyFingerprint(privateKey) {
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spki).digest('hex').slice(0, 16);
}

// --- The owner's confirmation -----------------------------------------------------------------------

function describeForConfirmation(fields) {
  return [
    'Sign this approval with your approval private key?',
    '',
    `Approval: ${fields.request_id}`,
    `Decision: ${fields.decision}`,
    `Approver: ${fields.decided_by}`,
    `Action fingerprint: ${fields.execution_fingerprint.slice(0, 16)}`,
    `Challenge issued: ${fields.issued_at}`,
    '',
    'Choose Yes only if you just pressed Sign for this approval in your Dashboard.',
  ].join('\n');
}

// Fixed script: it reads the text from the environment, so no payload content is ever part of a command.
// The default button is No, and DefaultDesktopOnly keeps the window above the browser.
const CONFIRMATION_SCRIPT =
  "$ErrorActionPreference = 'Stop'; " +
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  `$answer = [System.Windows.Forms.MessageBox]::Show($env:${CONFIRM_TEXT_ENV}, 'Sign approval - local signing helper', ` +
  '[System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, ' +
  '[System.Windows.Forms.MessageBoxDefaultButton]::Button2, [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly); ' +
  'Write-Output $answer';
const CONFIRMATION_COMMAND = 'powershell.exe';
const CONFIRMATION_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CONFIRMATION_SCRIPT];

// Resolves true only for an explicit Yes. No -> declined_by_owner; anything else -> no signature.
function windowsConfirmation(text, { spawnImpl = spawn, platform = process.platform, timeoutMs = CONFIRMATION_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (platform !== 'win32') {
      reject(new SigningHelperError('confirmation_unavailable'));
      return;
    }
    let child;
    try {
      child = spawnImpl(CONFIRMATION_COMMAND, CONFIRMATION_ARGS, {
        env: { ...process.env, [CONFIRM_TEXT_ENV]: text },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      reject(new SigningHelperError('confirmation_unavailable'));
      return;
    }
    let settled = false;
    let output = '';
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (err) {
        // Already gone.
      }
      settle(reject, new SigningHelperError('confirmation_timeout'));
    }, timeoutMs);
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output += chunk; });
    }
    child.on('error', () => settle(reject, new SigningHelperError('confirmation_unavailable')));
    child.on('close', (code) => {
      const answer = output.trim();
      if (code === 0 && answer === 'Yes') settle(resolve, true);
      else if (code === 0 && answer === 'No') settle(reject, new SigningHelperError('declined_by_owner'));
      else settle(reject, new SigningHelperError('confirmation_unavailable'));
    });
  });
}

// --- HTTP -------------------------------------------------------------------------------------------

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res, error, headers) {
  const known = error instanceof SigningHelperError ? error : new SigningHelperError('signing_failed');
  sendJson(res, known.status, { error: known.message, code: known.code }, headers);
}

// Reads at most MAX_BODY_BYTES. Anything beyond is read and discarded (never kept), so an oversized request
// still receives a clear 413 instead of a dropped connection.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new SigningHelperError('body_too_large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => reject(new SigningHelperError('request_invalid')));
  });
}

// `confirm(text, fields)` resolves true to sign; it defaults to the Windows confirmation window. `log` receives
// event names and non-secret fields only.
function createSigningHelper({
  keyPath,
  allowedOrigins,
  confirm = (text) => windowsConfirmation(text),
  now = () => Date.now(),
  maxAgeMs = getChallengeTtlMs(),
  readFile = fs.readFileSync,
  log = () => {},
} = {}) {
  const origins = normalizeAllowedOrigins(allowedOrigins);
  let busy = false;

  async function handler(req, res) {
    const port = req.socket && req.socket.localPort;
    const host = String(req.headers.host || '');
    if (host !== `${LISTEN_HOST}:${port}` && host !== `localhost:${port}`) {
      sendError(res, new SigningHelperError('host_not_allowed'));
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !origins.has(origin)) {
      log('refused', { code: 'origin_not_allowed' });
      sendError(res, new SigningHelperError('origin_not_allowed'));
      return;
    }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    const path = String(req.url || '').split('?')[0];

    if (req.method === 'OPTIONS') {
      if (path !== '/sign' && path !== '/status') {
        sendError(res, new SigningHelperError('not_found'), cors);
        return;
      }
      const preflight = { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '60' };
      // Chrome's Private Network Access preflight: a public https page reaching 127.0.0.1.
      if (req.headers['access-control-request-private-network'] === 'true') preflight['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(204, { 'Cache-Control': 'no-store', ...preflight });
      res.end();
      return;
    }

    if (path === '/status') {
      if (req.method !== 'GET') {
        sendError(res, new SigningHelperError('method_not_allowed'), cors);
        return;
      }
      try {
        const key = loadApprovalPrivateKey(keyPath, { readFile });
        sendJson(res, 200, { status: 'ready', public_key_fingerprint: publicKeyFingerprint(key) }, cors);
      } catch (err) {
        const known = err instanceof SigningHelperError ? err : new SigningHelperError('key_invalid');
        sendJson(res, 200, { status: 'key_unavailable', code: known.code, error: known.message }, cors);
      }
      return;
    }

    if (path !== '/sign') {
      sendError(res, new SigningHelperError('not_found'), cors);
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, new SigningHelperError('method_not_allowed'), cors);
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      sendError(res, new SigningHelperError('unsupported_media_type'), cors);
      return;
    }
    if (busy) {
      sendError(res, new SigningHelperError('busy'), cors);
      return;
    }

    busy = true;
    try {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        throw err instanceof SigningHelperError ? err : new SigningHelperError('request_invalid');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SigningHelperError('request_invalid');
      const { bytes, fields } = parseApprovalPayload(body.payload_base64, { now: now(), maxAgeMs });
      bindRequestToPayload(body, fields);
      log('sign_requested', { request_id: fields.request_id, decision: fields.decision });

      // The key is checked BEFORE the owner is asked, so a broken key never prompts for a pointless Yes.
      const key = loadApprovalPrivateKey(keyPath, { readFile });
      const approved = await confirm(describeForConfirmation(fields), fields);
      if (approved !== true) throw new SigningHelperError('declined_by_owner');

      let signature;
      try {
        signature = crypto.sign(null, bytes, key).toString('base64');
      } catch (err) {
        throw new SigningHelperError('signing_failed');
      }
      log('signed', { request_id: fields.request_id, decision: fields.decision });
      sendJson(res, 200, { signature }, cors);
    } catch (err) {
      const known = err instanceof SigningHelperError ? err : new SigningHelperError('signing_failed');
      log('refused', { code: known.code });
      sendError(res, known, cors);
    } finally {
      busy = false;
    }
  }

  function listen(port = DEFAULT_PORT) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handler(req, res).catch(() => sendError(res, new SigningHelperError('signing_failed')));
      });
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          const inUse = new Error(`Port ${port} on ${LISTEN_HOST} is already in use - the signing helper may already be running.`);
          inUse.code = 'port_in_use';
          reject(inUse);
          return;
        }
        reject(err);
      });
      // Loopback only - never reachable from another machine.
      server.listen(port, LISTEN_HOST, () => resolve(server));
    });
  }

  return { handler, listen, allowedOrigins: origins };
}

// --- CLI ----------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { allowOrigins: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (arg === '--key') options.keyPath = next();
    else if (arg === '--port') options.port = next();
    else if (arg === '--allow-origin') options.allowOrigins.push(next());
    else throw new Error(`Unknown option "${arg}". Use --key <path> --allow-origin <https-origin> [--port <port>].`);
  }
  return options;
}

async function main({ argv = process.argv.slice(2), env = process.env, platform = process.platform, output = console, createHelper = createSigningHelper } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    output.error(err.message);
    return 1;
  }
  const keyPath = options.keyPath || env[KEY_PATH_ENV];
  const origins = options.allowOrigins.length > 0 ? options.allowOrigins : env[ALLOWED_ORIGINS_ENV];
  const port = Number(options.port || env[PORT_ENV] || DEFAULT_PORT);

  if (platform !== 'win32') {
    output.error('The local signing helper needs the Windows confirmation window, so it only runs on Windows. Nothing was started.');
    return 1;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    output.error('The port must be a whole number between 1024 and 65535.');
    return 1;
  }
  let helper;
  try {
    helper = createHelper({ keyPath, allowedOrigins: origins });
  } catch (err) {
    output.error(err.message);
    return 1;
  }
  let fingerprint;
  try {
    fingerprint = publicKeyFingerprint(loadApprovalPrivateKey(keyPath));
  } catch (err) {
    output.error(`${err.message} (${err.code || 'key_invalid'})`);
    return 1;
  }
  try {
    await helper.listen(port);
  } catch (err) {
    output.error(err.code === 'port_in_use' ? err.message : 'The local signing helper could not start.');
    return err.code === 'port_in_use' ? 2 : 1;
  }
  output.log(`Local signing helper ready on http://${LISTEN_HOST}:${port} for ${[...helper.allowedOrigins].join(', ')}.`);
  output.log(`Approval key fingerprint (public): ${fingerprint}. Keep this window open while approving; close it to stop signing.`);
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}

module.exports = {
  LISTEN_HOST,
  DEFAULT_PORT,
  KEY_PATH_ENV,
  ALLOWED_ORIGINS_ENV,
  PORT_ENV,
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
  parseArgs,
  main,
};
