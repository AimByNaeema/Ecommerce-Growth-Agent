'use strict';

// Candidate normalization, de-duplication, customer-fit measurement and ranking - the
// stages between "the research stage found many candidates" and "here are the Top 10 for
// THIS business" (workflows/customerMarketOpportunityWorkflow.js).
//
// PURE AND OFFLINE. No network call, no model call, no credential. Everything here is
// arithmetic over data the caller already collected, so every number is re-derivable from
// the same input - which is what makes a rank auditable rather than an opinion.
//
// HOW RANKING WORKS, AND WHAT IT DELIBERATELY IS NOT.
// agent/core/productOpportunityScoringEngine.js states its own contract plainly: its
// coverage_score is "a mechanical evidence-coverage measurement ... never a judgment about
// whether the opportunity is good", with "no unjustified weighting scheme invented". This
// module does NOT overturn that. It ranks on two mechanical measurements only:
//
//   1. EVIDENCE COVERAGE - how much of the opportunity is actually evidenced (that engine's
//      own percentage, reused unchanged).
//   2. CUSTOMER FIT      - how strongly the candidate matches this business's own real
//      market scope, measured as term overlap and reported WITH the matched terms.
//
// They are combined at EQUAL WEIGHT, which is the same principle that engine already
// applies across its own 8 dimensions - not a new weighting scheme, and not a claim that a
// higher-ranked candidate will sell better. The honest reading of rank 1 is "the
// best-evidenced candidate that is most relevant to this business", never "the most
// profitable product". That distinction is carried in the output as `rank_basis` so it
// cannot be lost downstream.
//
// A candidate with no evidence therefore cannot rank highly no matter how well it matches
// the catalogue, and a well-evidenced candidate for someone else's business cannot rank
// highly either. Both halves have to be real.

const NON_MEANINGFUL_TERMS = new Set([
  'and', 'the', 'for', 'with', 'from', 'this', 'that', 'you', 'your', 'our',
  'new', 'best', 'top', 'set', 'pack', 'file', 'files', 'digital', 'download',
  'downloads', 'instant', 'printable', 'design', 'designs', 'template', 'templates',
]);

// Term-overlap weights for customer fit. Ordered by how directly each says "this belongs
// in this business": the market this business is chiefly in outranks a market it also
// sells in, which outranks a recurring buyer-intent word. Stated here as data rather than
// buried in the arithmetic, so the whole basis of a fit score is one readable table.
const FIT_WEIGHTS = { primary_market: 3, related_market: 2, buyer_intent: 1 };
// The score a candidate would get by matching the primary market plus two related markets
// plus three buyer intents. Used only to express fit as a 0-100 percentage; a candidate
// matching more than this is simply capped at 100.
const FIT_SATURATION = FIT_WEIGHTS.primary_market + 2 * FIT_WEIGHTS.related_market + 3 * FIT_WEIGHTS.buyer_intent;

// Compliance verdicts that may appear in a ranked list at all. BLOCK is excluded outright;
// REVIEW is kept but never treated as cleared - see filterByCompliance.
const RANKABLE_COMPLIANCE_STATUSES = ['PASS', 'REVIEW'];

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTerm(value) {
  return String(value).toLowerCase().trim().replace(/\s+/g, ' ');
}

// A crude, deliberate singularizer: enough to make "invitations" and "invitation" the same
// candidate, and nothing more. It is not a linguistic model and does not try to be - an
// over-clever stemmer would silently merge genuinely different products.
function singularize(word) {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function meaningfulTokens(text) {
  return normalizeTerm(text)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !NON_MEANINGFUL_TERMS.has(w))
    .map(singularize);
}

// The identity two candidates share when they are the same opportunity worded differently.
// Order-independent (a token SET), so "invitation bridal shower" and "bridal shower
// invitations" collapse to one candidate.
function canonicalKey(name) {
  return [...new Set(meaningfulTokens(name))].sort().join(' ');
}

// Merges duplicates rather than discarding them: the surviving candidate keeps every
// variant name it was seen under and the UNION of all their evidence, so de-duplication
// never loses a source. `mention_count` records how many times the research surfaced this
// opportunity - itself a real signal, and reported as a count, never as "popularity".
function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of asArray(candidates)) {
    if (!candidate || !nonEmptyString(candidate.product)) continue;
    const key = canonicalKey(candidate.product);
    if (key === '') continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...candidate,
        product: candidate.product.trim(),
        canonical_key: key,
        variant_names: [candidate.product.trim()],
        evidence: asArray(candidate.evidence),
        mention_count: 1,
      });
      continue;
    }

    if (!existing.variant_names.includes(candidate.product.trim())) {
      existing.variant_names.push(candidate.product.trim());
    }
    // Union of evidence, de-duplicated by source url/reference so one source counted twice
    // never looks like two independent confirmations.
    const seen = new Set(existing.evidence.map((e) => (e && (e.source_url || e.source)) || JSON.stringify(e)));
    for (const item of asArray(candidate.evidence)) {
      const id = (item && (item.source_url || item.source)) || JSON.stringify(item);
      if (!seen.has(id)) {
        existing.evidence.push(item);
        seen.add(id);
      }
    }
    existing.mention_count += 1;
  }
  return [...byKey.values()];
}

// How strongly this candidate belongs to THIS business, measured as overlap with the
// customer's own market scope. The matched terms are returned with the score, so the
// question "why does this product make sense for this customer?" is answered by naming
// the real words both sides share - never by an opaque number.
function scoreCustomerFit(candidate, marketScope) {
  const scope = marketScope && typeof marketScope === 'object' ? marketScope : {};
  const candidateTokens = new Set(
    meaningfulTokens(`${candidate.product || ''} ${candidate.market || ''} ${asArray(candidate.keywords).join(' ')}`)
  );

  const matched = { primary_market: [], related_market: [], buyer_intent: [] };
  const matchTerms = (terms, bucket) => {
    for (const term of asArray(terms).filter(nonEmptyString)) {
      const tokens = meaningfulTokens(term);
      if (tokens.length > 0 && tokens.every((t) => candidateTokens.has(t))) {
        matched[bucket].push(normalizeTerm(term));
      }
    }
  };

  matchTerms(scope.primary_market ? [scope.primary_market] : [], 'primary_market');
  matchTerms(scope.related_markets, 'related_market');
  matchTerms(scope.buyer_intents, 'buyer_intent');

  const raw =
    matched.primary_market.length * FIT_WEIGHTS.primary_market +
    matched.related_market.length * FIT_WEIGHTS.related_market +
    matched.buyer_intent.length * FIT_WEIGHTS.buyer_intent;
  const percentage = FIT_SATURATION > 0 ? Math.min(100, Math.round((raw / FIT_SATURATION) * 100)) : 0;

  const reasonParts = [];
  if (matched.primary_market.length > 0) reasonParts.push(`is in this business's primary market (${matched.primary_market.join(', ')})`);
  if (matched.related_market.length > 0) reasonParts.push(`overlaps categories it already sells (${matched.related_market.join(', ')})`);
  if (matched.buyer_intent.length > 0) reasonParts.push(`shares recurring catalogue terms (${matched.buyer_intent.join(', ')})`);

  return {
    score: percentage,
    matched_terms: matched,
    // Verbatim-usable answer to "why THIS customer", built only from terms both sides
    // genuinely contain.
    reason:
      reasonParts.length > 0
        ? `Relevant because it ${reasonParts.join('; ')}.`
        : 'No term in this candidate matches this business\'s primary market, existing categories, or recurring catalogue terms.',
    basis: `Term overlap with the customer's own market scope, weighted ${JSON.stringify(FIT_WEIGHTS)} and expressed as a percentage of ${FIT_SATURATION}.`,
  };
}

// Excludes BLOCK outright and reports what was removed and why, so an excluded candidate
// is visible as a decision rather than silently absent. REVIEW survives but is never
// treated as cleared - the caller must carry its status through to the output.
function filterByCompliance(candidates) {
  const eligible = [];
  const excluded = [];
  for (const candidate of asArray(candidates)) {
    const status = candidate && candidate.compliance && candidate.compliance.status;
    if (status === 'BLOCK') {
      excluded.push({
        product: candidate.product,
        compliance_status: 'BLOCK',
        reason: 'Excluded from ranking: the existing compliance engine returned BLOCK for this candidate.',
        findings: asArray(candidate.compliance.findings).slice(0, 5),
      });
      continue;
    }
    if (!RANKABLE_COMPLIANCE_STATUSES.includes(status)) {
      excluded.push({
        product: candidate.product,
        compliance_status: status || null,
        reason: 'Excluded from ranking: no compliance verdict was produced for this candidate, so it cannot be treated as eligible.',
        findings: [],
      });
      continue;
    }
    eligible.push(candidate);
  }
  return { eligible, excluded };
}

// The equal-weight combination of the two mechanical measurements - see this file's header
// for why it is these two and nothing else.
function rankScore(coveragePercentage, customerFitScore) {
  const coverage = Number.isFinite(coveragePercentage) ? coveragePercentage : 0;
  const fit = Number.isFinite(customerFitScore) ? customerFitScore : 0;
  return Math.round((coverage + fit) / 2);
}

// Ranks eligible candidates and returns at most `limit`. Deliberately returns FEWER than
// the limit when fewer are genuinely supported: a candidate with no evidence at all is
// dropped rather than used to pad the list to a round number.
function rankCandidates(candidates, { limit = 10, minEvidenceCount = 1 } = {}) {
  const scored = [];
  const dropped = [];

  for (const candidate of asArray(candidates)) {
    const evidence = asArray(candidate.evidence);
    if (evidence.length < minEvidenceCount) {
      dropped.push({
        product: candidate.product,
        reason: `Dropped before ranking: ${evidence.length} evidence item(s), below the minimum of ${minEvidenceCount}. A slot is left empty rather than filled with an unevidenced candidate.`,
      });
      continue;
    }
    const coverage = candidate.coverage_score && Number.isFinite(candidate.coverage_score.percentage)
      ? candidate.coverage_score.percentage
      : 0;
    const fit = candidate.customer_fit && Number.isFinite(candidate.customer_fit.score) ? candidate.customer_fit.score : 0;
    scored.push({ ...candidate, rank_score: rankScore(coverage, fit) });
  }

  scored.sort(
    (a, b) =>
      b.rank_score - a.rank_score ||
      (b.customer_fit ? b.customer_fit.score : 0) - (a.customer_fit ? a.customer_fit.score : 0) ||
      asArray(b.evidence).length - asArray(a.evidence).length ||
      String(a.product).localeCompare(String(b.product))
  );

  return {
    ranked: scored.slice(0, Math.max(0, limit)).map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    dropped,
    eligible_count: scored.length,
  };
}

module.exports = {
  FIT_WEIGHTS,
  FIT_SATURATION,
  RANKABLE_COMPLIANCE_STATUSES,
  normalizeTerm,
  singularize,
  meaningfulTokens,
  canonicalKey,
  dedupeCandidates,
  scoreCustomerFit,
  filterByCompliance,
  rankScore,
  rankCandidates,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - opportunity candidate engine:\n');
  const scope = {
    primary_market: 'svg design files',
    related_markets: ['png clipart'],
    buyer_intents: ['halloween', 'christmas'],
  };
  const raw = [
    { product: 'Halloween SVG Bundles', market: 'svg design files', evidence: [{ source_url: 'https://example.test/a' }], compliance: { status: 'PASS' } },
    { product: 'Halloween SVG bundle', market: 'svg design files', evidence: [{ source_url: 'https://example.test/b' }], compliance: { status: 'PASS' } },
    { product: 'Christmas PNG Clipart', market: 'png clipart', evidence: [{ source_url: 'https://example.test/c' }], compliance: { status: 'PASS' } },
    { product: 'Disney Princess SVG', market: 'svg design files', evidence: [{ source_url: 'https://example.test/d' }], compliance: { status: 'BLOCK', findings: [] } },
    { product: 'Kitchen Blender', market: 'appliances', evidence: [{ source_url: 'https://example.test/e' }], compliance: { status: 'PASS' } },
  ];

  const deduped = dedupeCandidates(raw);
  console.log(`Raw candidates: ${raw.length} -> after de-duplication: ${deduped.length}`);
  const merged = deduped.find((c) => c.variant_names.length > 1);
  if (merged) console.log(`  merged variants: ${JSON.stringify(merged.variant_names)} (evidence union: ${merged.evidence.length})`);

  const { eligible, excluded } = filterByCompliance(deduped);
  console.log(`\nCompliance: ${eligible.length} eligible, ${excluded.length} excluded`);
  for (const item of excluded) console.log(`  BLOCKED: ${item.product}`);

  const withFit = eligible.map((c) => ({ ...c, customer_fit: scoreCustomerFit(c, scope), coverage_score: { percentage: 50 } }));
  const { ranked } = rankCandidates(withFit, { limit: 10 });
  console.log('\nRanked:');
  for (const item of ranked) {
    console.log(`  ${item.rank}. ${item.product}  rank_score=${item.rank_score}  fit=${item.customer_fit.score}`);
    console.log(`      ${item.customer_fit.reason}`);
  }
  console.log('\nThe unrelated product ranks last on fit alone - no market judgment is made anywhere above.');
}
