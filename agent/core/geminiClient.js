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

// Recognizes the Claude-shaped hosted web-search tool the research callers already pass
// (see workflows/customerMarketOpportunityWorkflow.js's WEB_SEARCH_TOOL and
// tools/webCompetitorResearchTool.js). Matched on the tool NAME rather than Anthropic's
// dated `type` string, so a future `web_search_20260101` still maps correctly. Any other
// tool definition is NOT translated - Gemini function-calling is a separate, unscoped
// capability, and silently mapping an arbitrary tool onto search would be worse than
// ignoring it.
function requestsWebSearch(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some(
    (tool) => tool && (tool.name === 'web_search' || (typeof tool.type === 'string' && tool.type.startsWith('web_search')))
  );
}

// Every REAL URL Gemini's Google Search grounding actually retrieved for one call - the
// exact counterpart of claudeClient.js's extractWebSearchResultUrls, and the anchor the
// research pipeline verifies candidate sources against.
//
// READS GROUNDING METADATA ONLY. A URL Gemini merely wrote into its prose ("according to
// example.com...") is NOT here and must never be treated as verified: only chunks Google
// Search itself returned appear in groundingChunks. That distinction is the whole point
// of this function - see the evidence contract in
// workflows/customerMarketOpportunityWorkflow.js.
//
// Takes the raw `candidates` array, mirroring extractText above.
function extractWebSearchResultUrls(candidates) {
  if (!Array.isArray(candidates)) return [];
  const urls = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const metadata = candidate && candidate.groundingMetadata;
    const chunks = metadata && Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
    for (const chunk of chunks) {
      const uri = chunk && chunk.web && typeof chunk.web.uri === 'string' ? chunk.web.uri : null;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      urls.push(uri);
    }
  }
  return urls;
}

// Params mirror claudeClient.js's sendMessage so the two clients stay interchangeable
// behind agent/core/aiProviderSelector.js:
//   tools - optional array of Claude-shaped tool definitions. Only the hosted web-search
//           tool is translated (to Gemini's own `google_search` grounding tool); it is
//           never sent on a call that did not ask for search.
async function sendMessage({ messages, system, model, maxTokens, businessId = null, tools } = {}) {
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
  // Google Search grounding, on the SAME generateContent endpoint this client already
  // uses - no API migration. Sent only when the caller actually asked for web search, so
  // ordinary reasoning calls are byte-identical to before this capability existed.
  if (requestsWebSearch(tools)) body.tools = [{ google_search: {} }];

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
  extractWebSearchResultUrls,
  requestsWebSearch,
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
