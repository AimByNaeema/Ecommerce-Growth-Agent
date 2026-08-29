'use strict';

const path = require('path');
const express = require('express');
const { loadBusinessConfig } = require('./tools/configValidator');
const aiProviderSelector = require('./agent/core/aiProviderSelector');

const BUSINESS_CONFIG_PATH = path.join(__dirname, 'configuration', 'business.yaml');

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
