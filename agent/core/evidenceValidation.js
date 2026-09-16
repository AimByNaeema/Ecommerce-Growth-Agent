'use strict';

// MULTI-SOURCE EVIDENCE VALIDATION - how much a set of cited sources actually corroborates a claim.
//
// WHY THIS EXISTS. The research pipeline already refuses any source a search tool did not return
// (workflows/customerMarketOpportunityWorkflow.js). But ONE verified page was enough to keep an
// opportunity, and five pages from the same site counted as five confirmations. Corroboration is a
// different question from provenance: "did search really return this URL" versus "do independent
// sources agree". This module answers only the second, deterministically, from the evidence it is given.
//
// THE RULES (all mechanical - nothing here reads page content or judges quality):
//   - Independence is by registrable domain. shop.example.com and example.com are one source;
//     example.co.uk is not example.com. A same-domain repeat is kept as a supporting source but never
//     counted as independent.
//   - The minimum number of independent sources is configuration (RESEARCH_MIN_INDEPENDENT_SOURCES,
//     default 2), not a constant buried in logic.
//   - Conflicts are detected, not resolved: numeric values for the same metric and unit that differ by
//     more than CONFLICT_RELATIVE_TOLERANCE, or different classifications for the same metric. A conflict
//     lowers confidence and is reported with every value and its source; no value is picked.
//   - Insufficient corroboration never becomes strong validation: fewer independent sources than the
//     minimum caps confidence at 'low', and 'high' requires both corroboration AND at least one measured
//     or observed claim.
//   - No evidence is fabricated: a claim with no valid http(s) source contributes nothing.
//
// EVIDENCE GRADES. The research model's own lower-case grades (measured, estimated, derived, inferred,
// unknown - agent/core/customerOpportunityResearchModel.js) are kept unchanged where they are recorded;
// this module reports them on the validation vocabulary below, which adds OBSERVED (a value a source
// states directly, as opposed to one this system measured).

const EVIDENCE_VALIDATION_GRADES = ['MEASURED', 'OBSERVED', 'ESTIMATED', 'DERIVED', 'INFERRED', 'UNKNOWN'];
const GRADE_STRENGTH = { MEASURED: 5, OBSERVED: 4, ESTIMATED: 3, DERIVED: 2, INFERRED: 1, UNKNOWN: 0 };
const VALIDATION_STATUSES = ['corroborated', 'insufficient_corroboration', 'conflicting', 'unverified'];
const CONFIDENCE_ORDER = ['none', 'low', 'medium', 'high'];

const MIN_INDEPENDENT_SOURCES_ENV = 'RESEARCH_MIN_INDEPENDENT_SOURCES';
const DEFAULT_MIN_INDEPENDENT_SOURCES = 2;
const CONFLICT_RELATIVE_TOLERANCE = 0.25;

// Public suffixes with two labels that are common in e-commerce sources. Not exhaustive by design: an
// unlisted multi-part suffix makes two sites look like one (fewer independent sources, lower
// confidence) - the safe direction - never the other way round.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.jp',
  'com.br', 'co.in', 'com.mx', 'co.za', 'com.sg', 'com.tr', 'com.cn', 'com.hk', 'co.kr', 'com.ar', 'com.my',
]);

function getMinIndependentSources() {
  const value = Number(process.env[MIN_INDEPENDENT_SOURCES_ENV]);
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_MIN_INDEPENDENT_SOURCES;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (err) {
    return false;
  }
}

// The registrable domain a URL belongs to, or null for anything that is not an http(s) URL.
function sourceDomain(value) {
  if (!isHttpUrl(value)) return null;
  const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

function toValidationGrade(grade) {
  const upper = typeof grade === 'string' ? grade.trim().toUpperCase() : '';
  return EVIDENCE_VALIDATION_GRADES.includes(upper) ? upper : 'UNKNOWN';
}

// Numeric disagreement per metric+unit, and classification disagreement per metric. Every conflicting
// value is returned with its source; nothing is averaged or chosen.
function detectConflicts(claims) {
  const conflicts = [];
  const numeric = new Map();
  const categorical = new Map();
  for (const claim of claims) {
    if (!claim || !claim.metric) continue;
    if (claim.value !== null && claim.value !== undefined && claim.value !== '' && Number.isFinite(Number(claim.value))) {
      const key = `${claim.metric}|${claim.unit || ''}`;
      if (!numeric.has(key)) numeric.set(key, []);
      numeric.get(key).push({ value: Number(claim.value), unit: claim.unit || null, source_url: claim.source_url });
    }
    if (typeof claim.classification === 'string' && claim.classification.trim() && claim.classification !== 'unknown') {
      if (!categorical.has(claim.metric)) categorical.set(claim.metric, []);
      categorical.get(claim.metric).push({ value: claim.classification.trim().toLowerCase(), source_url: claim.source_url });
    }
  }
  for (const [key, values] of numeric) {
    if (values.length < 2) continue;
    const magnitudes = values.map((entry) => Math.abs(entry.value));
    const max = Math.max(...magnitudes);
    const min = Math.min(...magnitudes);
    const signs = new Set(values.map((entry) => Math.sign(entry.value)).filter((sign) => sign !== 0));
    const spread = max === 0 ? 0 : (max - min) / max;
    if (signs.size > 1 || spread > CONFLICT_RELATIVE_TOLERANCE) {
      conflicts.push({ metric: key.split('|')[0], kind: 'numeric', unit: values[0].unit, values });
    }
  }
  for (const [metric, values] of categorical) {
    if (new Set(values.map((entry) => entry.value)).size > 1) conflicts.push({ metric, kind: 'classification', unit: null, values });
  }
  return conflicts;
}

function lowerConfidence(level) {
  const index = CONFIDENCE_ORDER.indexOf(level);
  return CONFIDENCE_ORDER[Math.max(1, index - 1)];
}

function minConfidence(a, b) {
  return CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(a), CONFIDENCE_ORDER.indexOf(b))];
}

// `claims`: [{ source_url, grade, metric?, value?, unit?, classification?, retrieved_at? }].
// Returns the corroboration verdict for the claims taken together.
function validateEvidence({ claims = [], minIndependentSources = getMinIndependentSources() } = {}) {
  const minimum = Number.isInteger(minIndependentSources) && minIndependentSources >= 1 ? minIndependentSources : DEFAULT_MIN_INDEPENDENT_SOURCES;
  const valid = (Array.isArray(claims) ? claims : []).filter((claim) => claim && isHttpUrl(claim.source_url));

  const supporting = [];
  const seenUrls = new Set();
  const domains = new Map();
  const duplicates = [];
  let strongest = 'UNKNOWN';
  for (const claim of valid) {
    const grade = toValidationGrade(claim.grade);
    if (GRADE_STRENGTH[grade] > GRADE_STRENGTH[strongest]) strongest = grade;
    if (seenUrls.has(claim.source_url)) continue;
    seenUrls.add(claim.source_url);
    const domain = sourceDomain(claim.source_url);
    supporting.push({ source_url: claim.source_url, domain, grade, retrieved_at: claim.retrieved_at || null });
    if (domains.has(domain)) {
      duplicates.push({ source_url: claim.source_url, domain, counted_with: domains.get(domain) });
    } else {
      domains.set(domain, claim.source_url);
    }
  }

  const independent = domains.size;
  const conflicts = detectConflicts(valid);
  const corroborated = independent >= minimum;
  let status;
  let confidence;
  if (independent === 0) {
    status = 'unverified';
    confidence = 'none';
  } else {
    const base = corroborated ? (GRADE_STRENGTH[strongest] >= GRADE_STRENGTH.OBSERVED ? 'high' : 'medium') : 'low';
    if (conflicts.length > 0) {
      status = 'conflicting';
      confidence = minConfidence(lowerConfidence(base), 'medium');
    } else {
      status = corroborated ? 'corroborated' : 'insufficient_corroboration';
      confidence = base;
    }
  }

  return {
    status,
    confidence,
    min_independent_sources: minimum,
    independent_source_count: independent,
    independent_domains: [...domains.keys()],
    supporting_sources: supporting,
    same_domain_duplicates: duplicates,
    conflicts,
    strongest_grade: strongest,
    rule:
      `At least ${minimum} independent source domain(s) are required for corroboration; repeats from one domain count once; ` +
      'conflicting values lower confidence; high confidence also requires a measured or observed claim.',
  };
}

module.exports = {
  EVIDENCE_VALIDATION_GRADES,
  VALIDATION_STATUSES,
  CONFIDENCE_ORDER,
  MIN_INDEPENDENT_SOURCES_ENV,
  DEFAULT_MIN_INDEPENDENT_SOURCES,
  CONFLICT_RELATIVE_TOLERANCE,
  getMinIndependentSources,
  sourceDomain,
  toValidationGrade,
  detectConflicts,
  minConfidence,
  validateEvidence,
};
