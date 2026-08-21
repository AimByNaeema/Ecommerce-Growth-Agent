'use strict';

// The ONE agent's connection to the Claude API (Anthropic Messages API). This is a
// CONNECTION LAYER ONLY: it can send a message to Claude and return Claude's reply.
// It does not decide when to call Claude, does not call/dispatch tools
// (tools/toolRegistry.js), does not loop autonomously, and is not wired into
// agent/core/agentContract.js's stages yet - that orchestration is later, explicitly
// scoped work. No response is ever invented here: a missing API key, a network
// failure, or a non-success API response all throw a clear error instead of
// returning a fabricated answer (same convention as every research/analysis module
// already in this project).
//
// No SDK dependency is added for this: Node's built-in fetch (stable since Node 18)
// is enough for the one HTTP call the Messages API needs.

const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Default model, overridable per call or via ANTHROPIC_MODEL in .env - no code
// change needed to switch models. Sonnet is the balanced (cost/speed) default for
// e-commerce analysis/writing tasks; claude-opus-5 is the heavier option for harder
// reasoning.
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 1024;

let envLoadAttempted = false;

// Loads .env (git-ignored - see .env.example) into process.env exactly once, using
// Node's built-in process.loadEnvFile - no dotenv dependency needed. Safe to call
// before .env exists: real credentials are never guessed or defaulted, just left
// unset until the owner adds them.
function loadEnvOnce() {
  if (envLoadAttempted) return;
  envLoadAttempted = true;
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.error(`Warning: failed to load .env (${envPath}): ${err.message}`);
  }
}

// True once a non-empty ANTHROPIC_API_KEY is present in the environment. Lets a
// caller check readiness and fail fast with a clear message instead of attempting
// a network call that can only fail.
function isConfigured() {
  loadEnvOnce();
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

// Extracts plain reply text from a Messages API response body's `content` blocks.
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

// Sends one message to Claude and returns its reply.
//
// options:
//   messages  - required, non-empty array of { role: 'user'|'assistant', content: string }
//   system    - optional system prompt string
//   model     - optional model id (defaults to ANTHROPIC_MODEL env var, then DEFAULT_MODEL)
//   maxTokens - optional max output tokens (defaults to ANTHROPIC_MAX_TOKENS env var, then DEFAULT_MAX_TOKENS)
//
// Returns: { text, model, stopReason, usage, raw }
// Throws: if messages is invalid, the API key is missing, the request fails, or the
// API responds with a non-success status. Never returns a fabricated reply.
async function sendMessage({ messages, system, model, maxTokens } = {}) {
  loadEnvOnce();

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('sendMessage requires a non-empty `messages` array.');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add a real key from ' +
      'https://platform.claude.com/settings/keys before calling sendMessage().'
    );
  }

  const resolvedModel = model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const resolvedMaxTokens =
    maxTokens || Number(process.env.ANTHROPIC_MAX_TOKENS) || DEFAULT_MAX_TOKENS;

  const body = { model: resolvedModel, max_tokens: resolvedMaxTokens, messages };
  if (system) body.system = system;

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Could not reach the Claude API: ${err.message}`);
  }

  const raw = await response.json().catch(() => null);

  if (!response.ok) {
    const apiMessage = raw && raw.error && raw.error.message ? raw.error.message : response.statusText;
    throw new Error(`Claude API request failed (${response.status}): ${apiMessage}`);
  }

  return {
    text: extractText(raw.content),
    model: raw.model,
    stopReason: raw.stop_reason,
    usage: raw.usage,
    raw,
  };
}

module.exports = {
  sendMessage,
  isConfigured,
  loadEnvOnce,
  extractText,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
};

if (require.main === module) {
  loadEnvOnce();
  if (!isConfigured()) {
    console.log('Claude API connection layer loaded, but ANTHROPIC_API_KEY is not set.');
    console.log('Copy .env.example to .env and add a real key to actually call Claude:');
    console.log('  https://platform.claude.com/settings/keys');
    process.exit(0);
  }
  sendMessage({ messages: [{ role: 'user', content: 'Reply with exactly: connection ok' }] })
    .then((result) => {
      console.log('Claude API connection succeeded.');
      console.log(`Model: ${result.model}`);
      console.log(`Reply: ${result.text}`);
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
