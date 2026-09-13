'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
// The platform vocabulary, reused rather than restated: a platform may only be enabled
// once this project has a real adapter for it (agent/core/channelModel.js's CHANNELS).
const { CHANNELS, isValidChannel } = require('../agent/core/channelModel');

// The 12 required fields for business configuration (see configuration/business.example.yaml).
// All are required - this validator does not support per-task variability. The template's
// 13th field, `integrations`, is intentionally not required here - a business is valid with
// zero integrations connected (see configuration/business.example.yaml's own comment).
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

// ---------------------------------------------------------------------------------
// enabled_platforms - the ONLY authority on whether a platform is enabled.
// ---------------------------------------------------------------------------------
//
// WHY IT EXISTS. Nothing in this project previously stated which platforms a business
// actually sells on. The question was answered downstream by credential presence - a
// Shopify token in .env meant "Shopify is on", an Etsy token meant "Etsy is on" - which
// made enablement an accident of configuration rather than a decision, and left the Etsy
// tools reported as permitted for a business with no Etsy shop. This field is the
// decision, and agent/core/toolPermissions.js's platform gate reads nothing else.
//
// CREDENTIALS ARE NOT ENABLEMENT, AND ENABLEMENT IS NOT CREDENTIALS. They are independent
// and both are needed: this field says a platform is PERMITTED, credentials say a call can
// physically be made. A platform listed here without credentials simply fails at the
// adapter with its own clear error; credentials without a listing here are refused by the
// permission gate before any call is attempted.
//
// DISTINCT FROM THE EXISTING FREE-TEXT `platform:` FIELD, which is descriptive prose for
// the business context ("Shopify", and in configuration/business.sample.yaml literally
// "WooCommerce (example placeholder)"). That field gates nothing and is not consulted
// here; conflating the two is exactly how an unvalidated string would become an access
// decision.
//
// OPTIONAL, LIKE `integrations`. It is deliberately NOT in REQUIRED_FIELDS: a business
// config that predates this field stays valid, exactly as one with no `integrations`
// does. Absent means an empty list, which the permission gate treats as "no platform
// enabled" and therefore denies every platform-bound tool - absent is honest ("nothing
// has been stated"), never a permissive default.
const ENABLED_PLATFORMS_FIELD = 'enabled_platforms';

// The enabled platforms a config actually states, as a clean array of RECOGNIZED
// platforms. Pure, and never throws: an absent field, a non-array value, and
// unrecognized entries all simply contribute nothing, so the worst a malformed config can
// produce is an empty list (which denies, per the gate). Use validateEnabledPlatforms()
// below to find out WHY a config is malformed - this reader's job is only to report what
// is legitimately enabled.
function readEnabledPlatforms(config) {
  const value = config && config[ENABLED_PLATFORMS_FIELD];
  if (!Array.isArray(value)) return [];
  const enabled = [];
  for (const entry of value) {
    const normalized = typeof entry === 'string' ? entry.trim().toLowerCase() : entry;
    if (isValidChannel(normalized) && !enabled.includes(normalized)) enabled.push(normalized);
  }
  return enabled;
}

// Reports whether a config's enabled_platforms is well-formed, WITHOUT guessing a fix.
// Absent is valid (the field is optional). Present-but-wrong is an error naming the
// offending value, so a typo or an aspirational entry ('amazon', which has no adapter) is
// surfaced rather than silently dropped by readEnabledPlatforms() above.
//
// Returned separately from validateBusinessConfig() on purpose: that function's
// { valid, missing } contract is about REQUIRED fields being present, and widening it
// would change the meaning of every existing caller's result.
function validateEnabledPlatforms(config) {
  const errors = [];
  const value = config && config[ENABLED_PLATFORMS_FIELD];

  if (value === undefined || value === null) return { valid: true, errors };

  if (!Array.isArray(value)) {
    errors.push(
      `${ENABLED_PLATFORMS_FIELD} must be a list of platform ids (got ${typeof value}). Valid platforms: ${CHANNELS.join(', ')}.`
    );
    return { valid: false, errors };
  }

  const seen = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push(`${ENABLED_PLATFORMS_FIELD}[${index}] must be a non-empty platform id. Valid platforms: ${CHANNELS.join(', ')}.`);
      return;
    }
    const normalized = entry.trim().toLowerCase();
    if (!isValidChannel(normalized)) {
      errors.push(
        `${ENABLED_PLATFORMS_FIELD}[${index}] '${entry}' is not a platform this project has an adapter for. Valid platforms: ${CHANNELS.join(', ')}.`
      );
      return;
    }
    if (seen.includes(normalized)) {
      errors.push(`${ENABLED_PLATFORMS_FIELD} lists '${normalized}' more than once.`);
      return;
    }
    seen.push(normalized);
  });

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------------
// autonomy - whether this business permits the agent to act on its own, and what it
// may spend across a day doing so.
// ---------------------------------------------------------------------------------
//
// WHY IT EXISTS. `enabled_platforms` above answers "which platforms may be touched".
// This field answers a different and strictly narrower question: "may the agent start an
// action NOBODY asked for, right now?". Until this field existed, nothing in the project
// stated that at all, so agent/core/autonomyPolicy.js had no configured answer to read
// and could only fail closed on every request.
//
// OFF UNLESS EXPLICITLY ENABLED. Absent, blank, malformed, or `enabled: false` all mean
// the same thing - autonomy is not permitted - because the only honest reading of an
// unstated permission is that it was never granted. There is deliberately no way to
// express "on" by accident: `enabled` must be a real boolean true.
//
// CREDENTIALS AND PLATFORMS DO NOT IMPLY AUTONOMY. Neither a token in .env nor a platform
// in `enabled_platforms` grants it - those say a call could be made and is permitted;
// this says the agent may decide to make one by itself. This is the same conflation
// `enabled_platforms` exists to end, applied one level up.
//
// THE BUDGETS ARE COUNTS, NEVER MONEY. `daily_token_budget` is model output tokens across
// one UTC day; `daily_run_budget` is completed runs across the same day. This project has
// no price table anywhere (see usage/usageRecordModel.js and server.js's buildAiUsage),
// so a currency figure here would have to be invented. Both are optional: omitted means
// agent/core/autonomyPolicy.js applies its own conservative default ceiling derived from
// the existing per-run token budget, never an unlimited one.
//
// THE GLOBAL KILL SWITCH CAN ONLY SUBTRACT. AGENT_AUTONOMY_ENABLED (see .env.example) is
// evaluated alongside this field and can withdraw autonomy from every business at once;
// it can never grant autonomy to a business whose config does not enable it here.
const AUTONOMY_FIELD = 'autonomy';

// Whether a value is usable as a positive whole-number budget. A blank/absent budget is
// legitimate ("use the project default"), so it is NOT an error - it simply yields null.
function readPositiveIntegerBudget(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

// What a config actually states about autonomy, normalized. Pure, and never throws: every
// unusable value contributes nothing, so the worst a malformed config can produce is
// `{ enabled: false, ... }` - which denies. Use validateAutonomyConfig() below to find out
// WHY a config is malformed; this reader's job is only to report what was legitimately
// granted.
//
// `enabled` is true ONLY for a real boolean true. The string "true", 1, "yes" and every
// other near-miss read as false on purpose: a permission this consequential must be
// unambiguous in the file, not rescued by a coercion rule nobody can see.
function readAutonomyConfig(config) {
  const value = config && config[AUTONOMY_FIELD];
  const block = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: block.enabled === true,
    daily_token_budget: readPositiveIntegerBudget(block.daily_token_budget),
    daily_run_budget: readPositiveIntegerBudget(block.daily_run_budget),
    // How long an approval the autonomous cycle queues stays decidable, in whole hours. NO
    // DEFAULT: null means the owner has not stated one, and agent/core/autonomyPolicy.js then
    // refuses every autonomous action for the business rather than inventing an expiry.
    // Distinct from APPROVAL_CHALLENGE_TTL_MS, which is the minutes-long window for signing
    // one challenge.
    approval_ttl_hours: readPositiveIntegerBudget(block.approval_ttl_hours),
  };
}

// Reports whether a config's `autonomy` block is well-formed, WITHOUT guessing a fix.
// Absent is valid (the field is optional). Present-but-wrong is an error naming the
// offending value, so `enabled: "true"` or `daily_token_budget: -5` is surfaced rather
// than silently read as off/default by readAutonomyConfig() above.
//
// Returned separately from validateBusinessConfig() for the same reason
// validateEnabledPlatforms() is: that function's { valid, missing } contract is about
// REQUIRED fields being present, and widening it would change every existing caller's
// result.
function validateAutonomyConfig(config) {
  const errors = [];
  const value = config && config[AUTONOMY_FIELD];

  if (value === undefined || value === null) return { valid: true, errors };

  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${AUTONOMY_FIELD} must be a block with an \`enabled\` flag (got ${Array.isArray(value) ? 'list' : typeof value}).`);
    return { valid: false, errors };
  }

  if ('enabled' in value && value.enabled !== null && typeof value.enabled !== 'boolean') {
    errors.push(
      `${AUTONOMY_FIELD}.enabled must be true or false, not '${String(value.enabled)}' - autonomy is granted only by a real boolean, never by a string or number that merely looks like one.`
    );
  }

  for (const budgetField of ['daily_token_budget', 'daily_run_budget']) {
    if (!(budgetField in value)) continue;
    const raw = value[budgetField];
    if (raw === undefined || raw === null || raw === '') continue;
    if (readPositiveIntegerBudget(raw) === null) {
      errors.push(
        `${AUTONOMY_FIELD}.${budgetField} must be a whole number greater than zero (got '${String(raw)}'). It counts ${budgetField === 'daily_token_budget' ? 'model output tokens' : 'runs'} per UTC day - never money.`
      );
    }
  }

  if ('approval_ttl_hours' in value) {
    const raw = value.approval_ttl_hours;
    if (raw !== undefined && raw !== null && raw !== '' && readPositiveIntegerBudget(raw) === null) {
      errors.push(
        `${AUTONOMY_FIELD}.approval_ttl_hours must be a whole number of hours greater than zero (got '${String(raw)}'). It is how long an approval the autonomous cycle queues may still be decided.`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

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

module.exports = {
  REQUIRED_FIELDS,
  ENABLED_PLATFORMS_FIELD,
  validateBusinessConfig,
  validateEnabledPlatforms,
  readEnabledPlatforms,
  AUTONOMY_FIELD,
  validateAutonomyConfig,
  readAutonomyConfig,
  loadBusinessConfig,
};

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

  // A separate, additionally-reported step: enabled_platforms is optional, so a config
  // without it is still valid - but a config that states one WRONGLY must not pass
  // quietly, because that value is an access decision.
  const platformCheck = validateEnabledPlatforms(config);
  if (!platformCheck.valid) {
    console.error(`STOP: business configuration has an invalid ${ENABLED_PLATFORMS_FIELD} (${targetPath}).`);
    for (const error of platformCheck.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  // The same separately-reported treatment for the autonomy block, and for the same
  // reason: it is optional, but a config that states it WRONGLY must not pass quietly -
  // `enabled: "true"` reads as OFF to readAutonomyConfig(), and an operator who wrote it
  // meaning ON deserves to be told rather than to discover it from an agent that never acts.
  const autonomyCheck = validateAutonomyConfig(config);
  if (!autonomyCheck.valid) {
    console.error(`STOP: business configuration has an invalid ${AUTONOMY_FIELD} block (${targetPath}).`);
    for (const error of autonomyCheck.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(`Business configuration is valid (${targetPath}).`);
  const enabledPlatforms = readEnabledPlatforms(config);
  if (enabledPlatforms.length === 0) {
    console.log(
      `${ENABLED_PLATFORMS_FIELD}: none stated - every platform-bound tool is denied by agent/core/toolPermissions.js's platform gate.`
    );
  } else {
    console.log(`${ENABLED_PLATFORMS_FIELD}: ${enabledPlatforms.join(', ')}`);
  }

  const autonomy = readAutonomyConfig(config);
  if (!autonomy.enabled) {
    console.log(
      `${AUTONOMY_FIELD}: not enabled - agent/core/autonomyPolicy.js permits no agent-initiated action for this business.`
    );
  } else {
    console.log(
      `${AUTONOMY_FIELD}: enabled (daily_token_budget: ${autonomy.daily_token_budget === null ? 'project default' : autonomy.daily_token_budget}, ` +
      `daily_run_budget: ${autonomy.daily_run_budget === null ? 'project default' : autonomy.daily_run_budget}, ` +
      `approval_ttl_hours: ${autonomy.approval_ttl_hours === null ? 'NOT SET - every autonomous action is refused until it is' : autonomy.approval_ttl_hours}). ` +
      'The global AGENT_AUTONOMY_ENABLED kill switch can still withdraw this.'
    );
  }
  process.exit(0);
}
