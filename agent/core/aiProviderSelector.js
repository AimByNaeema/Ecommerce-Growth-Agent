'use strict';

// A thin selector between agent/core/claudeClient.js and agent/core/geminiClient.js -
// NOT a new AI client. It reads AI_PROVIDER from .env to decide which of the two
// already-built connection layers is "active," and delegates sendMessage/isConfigured
// to that one, unchanged. Both clients share the same shape (sendMessage, isConfigured)
// so no adapter/translation logic is needed here - this stays a pure pass-through.
//
// Deliberately NOT wired into agent/core/agentContract.js, the orchestrator, or any
// tool - it stays a standalone, directly-callable module for now, same boundary
// claudeClient.js and geminiClient.js already have. That wiring is separate,
// explicitly-scoped work per CLAUDE.md rule 1/section 6.

const claudeClient = require('./claudeClient');
const geminiClient = require('./geminiClient');

// Deliberate configured default (not a business assumption about which provider is
// "better") - AI_PROVIDER unset/blank means "gemini".
const DEFAULT_PROVIDER = 'gemini';
const VALID_PROVIDERS = ['claude', 'gemini'];

const CLIENTS = {
  claude: claudeClient,
  gemini: geminiClient,
};

// Resolves AI_PROVIDER to "claude" or "gemini". Reuses claudeClient.js's own
// loadEnvOnce() to load the root .env file instead of duplicating that fs/path/
// process.loadEnvFile logic a third time (CLAUDE.md rules 3-4) - either client's copy
// has the identical effect, since both just populate process.env once per process.
function getActiveProvider() {
  claudeClient.loadEnvOnce();

  const raw = process.env.AI_PROVIDER;
  if (raw === undefined || raw === null || raw.trim() === '') {
    return DEFAULT_PROVIDER;
  }

  const normalized = raw.trim().toLowerCase();
  if (!VALID_PROVIDERS.includes(normalized)) {
    throw new Error(
      `Unrecognized AI_PROVIDER value '${raw}'. Set AI_PROVIDER to "claude" or "gemini" ` +
      'in .env, or leave it unset to use the default ("gemini").'
    );
  }
  return normalized;
}

function resolveClient() {
  return CLIENTS[getActiveProvider()];
}

function isConfigured(...args) {
  return resolveClient().isConfigured(...args);
}

function sendMessage(...args) {
  return resolveClient().sendMessage(...args);
}

module.exports = {
  sendMessage,
  isConfigured,
  getActiveProvider,
  DEFAULT_PROVIDER,
};

if (require.main === module) {
  let provider;
  try {
    provider = getActiveProvider();
  } catch (err) {
    console.error(`STOP: ${err.message}`);
    process.exit(1);
  }
  console.log(`Active AI provider: ${provider}`);
  console.log(
    isConfigured()
      ? `${provider} is configured.`
      : `${provider} is NOT configured (missing API key) - see .env.example.`
  );
}
