'use strict';

// The ONE agent's connection to the Gemini API (Google Generative Language API). This is
// a CONNECTION LAYER ONLY: it can send a message to Gemini and return Gemini's reply. It
// does not decide when to call Gemini, does not call/dispatch tools
// (tools/toolRegistry.js), does not loop autonomously, and is not wired into
// agent/core/agentContract.js's stages yet - that orchestration is later, explicitly
// scoped work. No response is ever invented here: a missing API key, a network failure,
// or a non-success API response all throw a clear error instead of returning a
// fabricated answer (same convention as agent/core/claudeClient.js and every
// research/analysis module already in this project).
//
// No SDK dependency is added for this: Node's built-in fetch (stable since Node 18) is
// enough for the one HTTP call the generateContent API needs.

const fs = require('fs');
const path = require('path');
const { RetryableError, retryAsync, withTimeout, parseRetryAfterMs } = require('./networkRetry');
const businessRegistry = require('../../configuration/businessRegistry');

// Gemini's endpoint is parameterized by model (.../models/{model}:generateContent),
// unlike Claude's single fixed API_URL - there is no separate API_VERSION header
// either, since the API version ("v1beta") lives in the URL path, not a header.
const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_MODEL = 'gemini-3.6-flash';
const DEFAULT_MAX_TOKENS = 1024;

let envLoadAttempted = false;

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

function resolveCredentials(businessId) {
  if (!businessId) {
    loadEnvOnce();
    return {
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL,
      maxTokens: process.env.GEMINI_MAX_TOKENS,
    };
  }
  const credentials = businessRegistry.loadBusinessCredentials(businessId);
  return {
    apiKey: credentials.GEMINI_API_KEY,
    model: credentials.GEMINI_MODEL,
    maxTokens: credentials.GEMINI_MAX_TOKENS,
  };
}

function isConfigured({ businessId = null } = {}) {
  const { apiKey } = resolveCredentials(businessId);
  return Boolean(apiKey && apiKey.trim());
}

// Takes the raw `candidates` array from a Gemini generateContent response (mirrors
// claudeClient.js's extractText(content) taking the raw `content` array) and joins the
// first candidate's text parts, ignoring any non-text parts (e.g. functionCall).
function extractText(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const parts =
    candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts)
      ? candidates[0].content.parts
      : [];
  return parts
    .filter((part) => part && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

async function sendMessage({ messages, system, model, maxTokens, businessId = null } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('sendMessage requires a non-empty `messages` array.');
  }

  const resolved = resolveCredentials(businessId);
  const apiKey = resolved.apiKey;
  if (!apiKey || !apiKey.trim()) {
    const message = businessId
      ? `Business '${businessId}' has no configured GEMINI_API_KEY. Create ` +
        `configuration/businesses/${businessId}/.env with a real key before calling sendMessage().`
      : 'GEMINI_API_KEY is not set. Copy .env.example to .env and add a real key from ' +
        'https://aistudio.google.com/apikey before calling sendMessage().';
    throw new Error(message);
  }

  const resolvedModel = model || resolved.model || DEFAULT_MODEL;
  const resolvedMaxTokens = maxTokens || Number(resolved.maxTokens) || DEFAULT_MAX_TOKENS;

  // Translate the external, Claude-shaped messages ({role: 'user'|'assistant', content})
  // into Gemini's contents/parts shape - 'assistant' has no Gemini equivalent, it maps
  // to 'model'.
  const contents = messages.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  const body = { contents, generationConfig: { maxOutputTokens: resolvedMaxTokens } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `${API_BASE_URL}/${resolvedModel}:generateContent`;

  return retryAsync(async () => {
    let response;
    try {
      response = await withTimeout((signal) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
          signal,
        })
      );
    } catch (err) {
      throw new RetryableError(`Could not reach the Gemini API: ${err.message}`);
    }

    const raw = await response.json().catch(() => null);

    if (!response.ok) {
      const apiMessage = raw && raw.error && raw.error.message ? raw.error.message : response.statusText;
      const message = `Gemini API request failed (${response.status}): ${apiMessage}`;
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(message, { retryAfterMs: parseRetryAfterMs(response) });
      }
      throw new Error(message);
    }

    if (!raw || !Array.isArray(raw.candidates)) {
      throw new Error('Gemini API returned a success response with an unexpected/missing content shape.');
    }

    return {
      text: extractText(raw.candidates),
      // Gemini's response body does not echo back the model id (unlike Claude's
      // raw.model), so this reports the model actually used to build the request URL.
      model: resolvedModel,
      stopReason: raw.candidates[0] && raw.candidates[0].finishReason,
      usage: raw.usageMetadata,
      raw,
    };
  });
}

module.exports = {
  sendMessage,
  isConfigured,
  loadEnvOnce,
  resolveCredentials,
  extractText,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
};

if (require.main === module) {
  loadEnvOnce();
  if (!isConfigured()) {
    console.log('Gemini API connection layer loaded, but GEMINI_API_KEY is not set.');
    console.log('Copy .env.example to .env and add a real key to actually call Gemini:');
    console.log('  https://aistudio.google.com/apikey');
    process.exit(0);
  }
  sendMessage({ messages: [{ role: 'user', content: 'Reply with exactly: connection ok' }] })
    .then((result) => {
      console.log('Gemini API connection succeeded.');
      console.log(`Model: ${result.model}`);
      console.log(`Reply: ${result.text}`);
    })
    .catch((err) => {
      console.error(`STOP: ${err.message}`);
      process.exit(1);
    });
}
