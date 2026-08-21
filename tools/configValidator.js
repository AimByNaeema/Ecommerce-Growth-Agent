'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

// The 12 fields defined for business configuration (see configuration/business.example.yaml).
// All are required - this validator does not support per-task variability.
const REQUIRED_FIELDS = [
  'business_name',
  'business_model',
  'platform',
  'product_model',
  'target_markets',
  'countries',
  'currencies',
  'product_categories',
  'customer_segments',
  'brand.name',
  'business_goals',
  'marketing_channels',
];

function getField(config, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, config);
}

function isMissing(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// Checks a config object against REQUIRED_FIELDS. Does not guess or fill in
// defaults - only reports what is present or missing.
function validateBusinessConfig(config) {
  const missing = REQUIRED_FIELDS.filter((field) => isMissing(getField(config, field)));
  return { valid: missing.length === 0, missing };
}

// Reads and parses a business config YAML file. Throws a clear error (does not
// guess or fall back to defaults) if the file does not exist.
function loadBusinessConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Business configuration file not found: ${filePath}\n` +
      `Copy configuration/business.example.yaml to that path and fill in the business's values.`
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return YAML.parse(raw) || {};
}

module.exports = { REQUIRED_FIELDS, validateBusinessConfig, loadBusinessConfig };

if (require.main === module) {
  const targetPath = process.argv[2] || path.join('configuration', 'business.yaml');

  let config;
  try {
    config = loadBusinessConfig(targetPath);
  } catch (err) {
    console.error(`STOP: ${err.message}`);
    process.exit(1);
  }

  const { valid, missing } = validateBusinessConfig(config);
  if (!valid) {
    console.error(`STOP: business configuration is incomplete (${targetPath}).`);
    console.error('Missing required fields:');
    for (const field of missing) {
      console.error(`  - ${field}`);
    }
    process.exit(1);
  }

  console.log(`Business configuration is valid (${targetPath}).`);
  process.exit(0);
}
