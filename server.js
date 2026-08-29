'use strict';

const path = require('path');
const express = require('express');
const { loadBusinessConfig } = require('./tools/configValidator');
const aiProviderSelector = require('./agent/core/aiProviderSelector');
const { getSpecialistById } = require('./agent/core/specialistRegistry');
// Required as the whole module object (not destructured) so a test can monkey-patch
// orchestratorExecutionContract.buildPlanStep on the shared, cached module instance -
// the same convention verification/testing/server.test.js already uses for
// aiProviderSelector.sendMessage.
const orchestratorExecutionContract = require('./agent/core/orchestratorExecutionContract');

const BUSINESS_CONFIG_PATH = path.join(__dirname, 'configuration', 'business.yaml');

// Maps the dashboard's specialist ids (public/index.html's SPECIALISTS list) to the
// real specialist ids agent/core/specialistRegistry.js uses. Identical for every id
// except "analytics" - the dashboard's short label - vs. the registry's
// "analytics_optimization".
const SPECIALIST_ID_MAP = {
  research: 'research',
  product: 'product',
  seo: 'seo',
  listing: 'listing',
  marketing: 'marketing',
  social_advertising: 'social_advertising',
  analytics: 'analytics_optimization',
};

function buildBusinessContext(config) {
  const lines = [
    `Business: ${config.business_name || 'unknown'}`,
    `Platform: ${config.platform || 'unknown'}`,
    `Product categories: ${(config.product_categories || []).join(', ')}`,
    `Target markets: ${(config.target_markets || []).join(', ')}`,
    `Customer segments: ${(config.customer_segments || []).join(', ')}`,
  ];
  return `You are the assistant for the following business:\n${lines.join('\n')}`;
}

function createApp() {
  const businessConfig = loadBusinessConfig(BUSINESS_CONFIG_PATH);
  const context = buildBusinessContext(businessConfig);

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.post('/ask', async (req, res) => {
    const { message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'A non-empty "message" string is required.' });
      return;
    }

    try {
      const result = await aiProviderSelector.sendMessage({
        messages: [{ role: 'user', content: `${context}\n\n${message}` }],
      });
      res.json({ reply: result.text });
    } catch (err) {
      res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.' });
    }
  });

  app.post('/run', async (req, res) => {
    const { specialist, objective } = req.body || {};
    const internalSpecialistId = SPECIALIST_ID_MAP[specialist];
    if (!internalSpecialistId || !getSpecialistById(internalSpecialistId)) {
      res.status(400).json({ error: `Unrecognized specialist id: "${specialist}".` });
      return;
    }
    if (typeof objective !== 'string' || !objective.trim()) {
      res.status(400).json({ error: 'A non-empty "objective" string is required.' });
      return;
    }

    try {
      const target = orchestratorExecutionContract.buildSpecialistTarget(internalSpecialistId);
      const trimmedObjective = objective.trim();
      const step = await orchestratorExecutionContract.buildPlanStep(target, trimmedObjective, trimmedObjective);
      const status = step.completion_state === 'complete' ? 'success' : 'partial';
      res.json({ ...step, status });
    } catch (err) {
      res.status(502).json({ error: 'The specialist could not complete this run right now. Please try again shortly.' });
    }
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}
