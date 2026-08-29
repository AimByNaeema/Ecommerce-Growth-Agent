'use strict';

// Resolves a businessId to that business's own configuration and credentials, so the
// same agent core can serve more than one e-commerce business from a single running
// process without code changes (CLAUDE.md section 1's long-term goal). Each business
// gets its own folder under configuration/businesses/<id>/, holding a business.yaml
// (same shape as configuration/business.example.yaml, validated the same way) and a
// git-ignored .env (same KEY=VALUE shape as .env.example).
//
// NOT A DATABASE: this is the same file-based pattern the project already uses for its
// single business today, just parameterized by id - no new runtime/storage decision
// (CLAUDE.md rule 15). businessId is always OPTIONAL to every caller of this module's
// consumers (agent/core/claudeClient.js, integrations/adapters/shopifyClient.js,
// agent/core/orchestratorExecutionContract.js) - omitting it reproduces today's exact
// single-business behavior (root .env / process.env), so this is purely additive.
//
// WHY NOT process.loadEnvFile: that mutates the global, process-wide process.env -
// fine for exactly one business, unsafe once two businesses' credentials need to
// coexist in the same process. parseEnvFileContent()/loadBusinessCredentials() below
// read and parse a business's .env into a plain object instead, never touching
// process.env.
//
// SECURITY: businessId is used to build a filesystem path, so isValidBusinessId()'s
// safe-slug check (and getBusinessBasePath()'s use of it) is a real path-traversal
// guard, not just a style rule - an id containing '..', '/', or '\' is rejected before
// it ever reaches fs.

const fs = require('fs');
const path = require('path');
const { loadBusinessConfig: loadBusinessConfigFile } = require('../tools/configValidator');

const BUSINESSES_ROOT = path.join(__dirname, 'businesses');

const BUSINESS_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

const CREDENTIAL_KEYS = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_ADMIN_API_ACCESS_TOKEN',
  'SHOPIFY_API_VERSION',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MAX_TOKENS',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_MAX_TOKENS',
];

function isValidBusinessId(id) {
  return typeof id === 'string' && BUSINESS_ID_PATTERN.test(id);
}

// Validates id and returns configuration/businesses/<id> - never returns a path built
// from an invalid id, so an unvalidated id can never reach fs.
function getBusinessBasePath(id) {
  if (!isValidBusinessId(id)) {
    throw new Error(
      `Invalid businessId '${id}'. A businessId must start with a letter or digit and contain only ` +
      'letters, digits, hyphens, or underscores.'
    );
  }
  return path.join(BUSINESSES_ROOT, id);
}

// Lists configured business ids (subdirectories of configuration/businesses/). Returns
// [] when that directory doesn't exist yet - zero configured businesses is valid, same
// "never guess a default" convention as tools/configValidator.js.
function listBusinessIds() {
  if (!fs.existsSync(BUSINESSES_ROOT)) return [];
  return fs
    .readdirSync(BUSINESSES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidBusinessId(entry.name))
    .map((entry) => entry.name);
}

// Loads configuration/businesses/<id>/business.yaml by delegating to
// tools/configValidator.js's own loadBusinessConfig(filePath) - reused as-is (it is
// already generic over the file path), not reimplemented.
function loadBusinessConfig(id) {
  const basePath = getBusinessBasePath(id);
  return loadBusinessConfigFile(path.join(basePath, 'business.yaml'));
}

// Parses a .env-shaped string into a plain object: KEY=VALUE per line, blank lines and
// #-comments skipped, surrounding quotes on the value stripped. Pure - never touches
// process.env. Mirrors the subset of dotenv syntax .env.example already uses.
function parseEnvFileContent(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

// Reads and parses configuration/businesses/<id>/.env. Throws a clear, actionable
// error (never fabricates/defaults credentials) if the file doesn't exist. Returns a
// plain object with exactly CREDENTIAL_KEYS as keys (missing ones are '').
function loadBusinessCredentials(id) {
  const basePath = getBusinessBasePath(id);
  const envPath = path.join(basePath, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `Business credentials file not found: ${envPath}\n` +
      `Create configuration/businesses/${id}/.env (see .env.example for the required keys) ` +
      `before using business '${id}'.`
    );
  }
  const parsed = parseEnvFileContent(fs.readFileSync(envPath, 'utf8'));
  const credentials = {};
  for (const key of CREDENTIAL_KEYS) {
    credentials[key] = parsed[key] || '';
  }
  return credentials;
}

module.exports = {
  BUSINESS_ID_PATTERN,
  CREDENTIAL_KEYS,
  isValidBusinessId,
  getBusinessBasePath,
  listBusinessIds,
  loadBusinessConfig,
  parseEnvFileContent,
  loadBusinessCredentials,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Business Registry (per-business configuration/credentials):\n');
  const ids = listBusinessIds();
  if (ids.length === 0) {
    console.log('No businesses configured yet. Create configuration/businesses/<businessId>/business.yaml and .env to add one.');
  } else {
    console.log(`Configured businesses: ${ids.join(', ')}`);
  }
}
