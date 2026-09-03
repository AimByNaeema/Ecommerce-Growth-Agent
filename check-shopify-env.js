'use strict';

// One-off diagnostic script - NEVER prints any real secret value, only whether each
// variable is present/non-empty and its length. Safe to run and to share the output
// of. Delete this file once the Shopify connection is confirmed working; it is not
// part of the permanent project (not referenced by any other file, not added to
// package.json scripts).

process.loadEnvFile('.env');

function report(name, value, { isSecret = true } = {}) {
  const present = typeof value === 'string' && value.trim() !== '';
  if (isSecret) {
    console.log(`${name}: ${present ? 'present' : 'MISSING/EMPTY'}${present ? ` (length ${value.trim().length})` : ''}`);
  } else {
    console.log(`${name}: ${present ? value : 'MISSING/EMPTY'}`);
  }
}

console.log('--- .env values loaded into this process (secrets shown as length only) ---');
report('SHOPIFY_STORE_DOMAIN', process.env.SHOPIFY_STORE_DOMAIN, { isSecret: false });
report('SHOPIFY_ADMIN_API_ACCESS_TOKEN', process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN);
report('SHOPIFY_CLIENT_ID', process.env.SHOPIFY_CLIENT_ID);
report('SHOPIFY_CLIENT_SECRET', process.env.SHOPIFY_CLIENT_SECRET);
report('SHOPIFY_API_VERSION', process.env.SHOPIFY_API_VERSION, { isSecret: false });
