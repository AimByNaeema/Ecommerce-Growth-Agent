'use strict';

// CONFIGURATION STATUS ONLY: which AI provider AI_PROVIDER selects, and whether that
// provider's key is present.
//
// It never calls a model. It exports no sendMessage and invokes none, so a caller that must
// not reach a model itself - server.js, which routes every model call through the shared
// tool stack (see verification/testing/askOrchestrationRouting.test.js) - can still REPORT
// the provider truthfully instead of printing a hard-coded provider name. It reads
// configuration through the same aiProviderSelector every model call already uses, so the
// status and the calls can never disagree about which provider is active.
//
// "configured" means a key is set - not that a model call has succeeded. No key value and no
// raw AI_PROVIDER value ever appears in the result, so it is safe to return from an endpoint.
const aiProviderSelector = require('./aiProviderSelector');

function getAiProviderStatus() {
  try {
    const provider = aiProviderSelector.getActiveProvider();
    return { provider, configured: Boolean(aiProviderSelector.isConfigured()), detail: null };
  } catch (err) {
    return {
      provider: null,
      configured: false,
      detail: 'AI_PROVIDER is set to a value this system does not recognise. Set it to "gemini" or "claude".',
    };
  }
}

module.exports = { getAiProviderStatus };
