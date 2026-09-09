'use strict';

// compliance/etsyComplianceInput.js - the Etsy listing -> compliance projection.
//
// The theme of this file is that nothing is ever filled in: a fact the listing data does
// not establish comes back as NEEDS_INFORMATION, and an unknown product nature is
// reported rather than assumed in either direction.

const assert = require('node:assert');
const {
  NEEDS_INFORMATION,
  ETSY_REQUIRED_CHECKS,
  DIGITAL_PRODUCT_FACTS,
  describeListingFacts,
  missingListingFacts,
  listingContent,
  complianceInputFromEtsyListing,
  checkEtsyListingCompliance,
} = require('../../compliance/etsyComplianceInput');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

const OWN_BUSINESS = { brand_names: ['Digital Studio By Naeema'], product_categories: ['Invitation', 'Birthday'] };

function listing(overrides = {}) {
  return {
    channel: 'etsy',
    listing_id: 1234567890,
    title: 'Floral Border Celebration Design',
    description: 'A hand drawn floral border in soft muted tones.',
    tags: ['floral', 'celebration'],
    state: 'active',
    is_digital_product: true,
    listing_type: 'download',
    price: null,
    ...overrides,
  };
}

// --- NEEDS_INFORMATION --------------------------------------------------------------

test('NEEDS_INFORMATION: every fact the listing data does not establish is reported, not guessed', () => {
  const facts = describeListingFacts(listing());
  for (const id of ['file_formats', 'file_count', 'dimensions', 'editable_where', 'personalization', 'delivery_method', 'turnaround_time', 'licence']) {
    assert.strictEqual(facts[id], NEEDS_INFORMATION, `${id} must be reported as unknown`);
  }
  // And the facts Etsy DOES return come through as their real values.
  assert.strictEqual(facts.product_nature, true);
  assert.strictEqual(facts.listing_type, 'download');
});

test('NEEDS_INFORMATION: an absent or blank value is absent - never a default', () => {
  const facts = describeListingFacts(listing({ price: '', listing_type: null }));
  assert.strictEqual(facts.price, NEEDS_INFORMATION);
  assert.strictEqual(facts.listing_type, NEEDS_INFORMATION);
});

test('NEEDS_INFORMATION: a real value is carried through unchanged', () => {
  const facts = describeListingFacts(listing({ price: { amount: 500, currency_code: 'GBP' } }));
  assert.deepStrictEqual(facts.price, { amount: 500, currency_code: 'GBP' });
  assert.ok(!missingListingFacts(listing({ price: { amount: 500 } })).includes('price'));
});

test('every declared product fact is either sourced from the API or explicitly unsourced', () => {
  for (const fact of DIGITAL_PRODUCT_FACTS) {
    assert.ok(typeof fact.id === 'string' && fact.id !== '');
    assert.ok(typeof fact.label === 'string' && fact.label !== '');
    assert.ok(fact.source_field === null || typeof fact.source_field === 'string');
  }
});

// --- THE PROJECTION -----------------------------------------------------------------

test('the projection sets the Etsy platform, surface and required checks', () => {
  const input = complianceInputFromEtsyListing(listing(), { businessContext: OWN_BUSINESS });
  assert.strictEqual(input.platform_context.platform, 'etsy');
  assert.strictEqual(input.platform_context.surface, 'listing');
  assert.deepStrictEqual(input.required_checks, ETSY_REQUIRED_CHECKS);
  assert.ok(input.required_checks.includes('ip_indicators'));
  assert.ok(input.required_checks.includes('platform_policy'));
});

test('provenance says the content was READ from the live listing, not generated', () => {
  const input = complianceInputFromEtsyListing(listing(), {});
  assert.strictEqual(input.provenance.source, 'etsy_listing_data_retrieval');
  assert.match(input.provenance.evidence[0], /Etsy listing 1234567890/);
});

test('the checked content is the listing\'s own title, description and tags - nothing added', () => {
  const content = listingContent(listing());
  assert.ok(content.includes('Floral Border Celebration Design'));
  assert.ok(content.includes('hand drawn floral border'));
  assert.ok(content.includes('floral, celebration'));
});

test('a listing with no text at all is refused rather than checked as empty', () => {
  assert.throws(
    () => complianceInputFromEtsyListing(listing({ title: '', description: '', tags: [] })),
    /nothing for Compliance to check/
  );
});

// --- VERDICTS -----------------------------------------------------------------------

test('DIGITAL PRODUCT ACCURACY: a digital listing claiming shipping is BLOCKED', () => {
  const outcome = checkEtsyListingCompliance(
    listing({ description: 'Your order ships in 3 business days.' }),
    { businessContext: OWN_BUSINESS }
  );
  assert.strictEqual(outcome.result.status, 'BLOCK');
  assert.ok(outcome.result.findings.some((f) => f.rule_id === 'etsy_digital_product_physical_shipping_claim'));
});

test('DIGITAL PRODUCT ACCURACY: a digital listing claiming printed cardstock is BLOCKED', () => {
  const outcome = checkEtsyListingCompliance(
    listing({ description: 'Every card is printed on cardstock with envelopes included.' }),
    { businessContext: OWN_BUSINESS }
  );
  assert.strictEqual(outcome.result.status, 'BLOCK');
});

test('UNKNOWN PRODUCT NATURE is REPORTED, and the fulfilment rules are not applied blindly', () => {
  const outcome = checkEtsyListingCompliance(
    listing({ is_digital_product: null, listing_type: null, description: 'Your order ships in 3 business days.' }),
    { businessContext: OWN_BUSINESS }
  );
  assert.notStrictEqual(outcome.result.status, 'BLOCK', 'blocking on an assumed product nature would be fabrication');
  assert.strictEqual(outcome.result.status, 'REVIEW');
  assert.ok(outcome.result.findings.some((f) => f.rule_id === 'etsy_product_nature_undetermined'));
});

test('IP RISK: a protected mark in a listing title drives REVIEW', () => {
  const outcome = checkEtsyListingCompliance(listing({ title: 'Bluey Birthday Invitation' }), { businessContext: OWN_BUSINESS });
  assert.strictEqual(outcome.result.status, 'REVIEW');
  assert.ok(outcome.result.findings.some((f) => f.rule_id === 'etsy_protected_mark_indicator'));
});

test('COMPETITOR COPY: verbatim reuse of supplied reference text is detected', () => {
  const copied = 'the most enchanting hand illustrated botanical suite for your unforgettable celebration day';
  const outcome = checkEtsyListingCompliance(listing({ description: copied }), {
    businessContext: OWN_BUSINESS,
    referenceMaterials: [{ id: 'competitor_listing_1', text: copied, rights_status: 'not_owned' }],
  });
  assert.ok(
    outcome.result.findings.some((f) => f.check_type === 'reference_similarity'),
    'verbatim reuse of a competitor passage must be detected'
  );
  assert.notStrictEqual(outcome.result.status, 'PASS');
});

test('AMBIGUITY RESOLVES TO REVIEW, NEVER PASS', () => {
  // Missing provenance evidence plus an unresolved name: neither is a certainty, and the
  // verdict is REVIEW rather than an optimistic PASS.
  const outcome = checkEtsyListingCompliance(listing({ title: 'Aveline Marchetti Wedding Suite' }), {
    businessContext: OWN_BUSINESS,
  });
  assert.strictEqual(outcome.result.status, 'REVIEW');
  assert.ok(outcome.result.review_reasons.length > 0, 'a REVIEW must always say why');
});

test('PASS is reachable for a clean, well-evidenced listing whose vocabulary is declared', () => {
  const clean = listing({ tags: ['floral', 'border', 'celebration'] });
  const outcome = checkEtsyListingCompliance(clean, {
    businessContext: OWN_BUSINESS,
    supportedFacts: [clean.description, clean.title, clean.tags.join(', ')],
  });
  assert.strictEqual(outcome.result.status, 'PASS', `expected PASS, got ${outcome.result.status}: ${outcome.result.review_reasons.join('; ')}`);
});

test("a listing's own tags account for its descriptive words, but NEVER for a protected mark", () => {
  // Tags legitimately quiet the structural pass (see checkEtsyListingCompliance)...
  const undeclared = checkEtsyListingCompliance(listing({ title: 'Woodland Fox Party Design', tags: [] }), {
    businessContext: OWN_BUSINESS,
  });
  assert.ok(undeclared.result.findings.some((f) => f.rule_id === 'etsy_unresolved_proper_noun'));

  const declared = checkEtsyListingCompliance(
    listing({ title: 'Woodland Fox Party Design', tags: ['woodland', 'fox', 'party'] }),
    { businessContext: OWN_BUSINESS }
  );
  assert.ok(!declared.result.findings.some((f) => f.rule_id === 'etsy_unresolved_proper_noun'));

  // ...but a tag can NEVER silence the known-marks pass. Self-declaring 'bluey' does not
  // make Bluey unprotected, so the mark is still reported.
  const tagged = checkEtsyListingCompliance(
    listing({ title: 'Bluey Party Design', tags: ['bluey', 'party'] }),
    { businessContext: OWN_BUSINESS }
  );
  assert.ok(
    tagged.result.findings.some((f) => f.rule_id === 'etsy_protected_mark_indicator'),
    'a seller-supplied tag must never be able to suppress a protected-mark finding'
  );
  assert.strictEqual(tagged.result.status, 'REVIEW');
});

test('FAIL CLOSED: an undeclared name-shaped title reviews - the accepted noise trade-off', () => {
  // This is the deliberate cost of not maintaining a safe-list: a title this checker
  // cannot resolve goes to a human. The tuning path is declaring vocabulary (above), not
  // relaxing the detector.
  const outcome = checkEtsyListingCompliance(listing({ title: 'Thornfield Manor Suite', tags: [] }), {
    businessContext: OWN_BUSINESS,
  });
  assert.strictEqual(outcome.result.status, 'REVIEW');
  assert.ok(outcome.result.findings.some((f) => f.rule_id === 'etsy_unresolved_proper_noun'));
});

test('THE STANDING LIMITATIONS TRAVEL WITH EVERY RESULT - a PASS is not a clearance', () => {
  const outcome = checkEtsyListingCompliance(listing(), { businessContext: OWN_BUSINESS });
  assert.ok(outcome.result.limitations.length > 0);
  assert.ok(outcome.result.limitations.some((limitation) => /not legal advice/i.test(limitation)));
  assert.ok(outcome.result.limitations.some((limitation) => /not a clearance/i.test(limitation)));
});

test('the unanswered facts are reported as a limitation on the result', () => {
  const outcome = checkEtsyListingCompliance(listing(), { businessContext: OWN_BUSINESS });
  assert.ok(outcome.missing_facts.length > 0);
  assert.ok(
    outcome.result.limitations.some((limitation) => limitation.includes(NEEDS_INFORMATION)),
    'the result must say which facts were not established'
  );
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('etsyComplianceInput.test.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
