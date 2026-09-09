'use strict';

// The Etsy listing -> compliance boundary: turns one real Etsy listing record into a
// compliance input, runs the existing engine over it, and layers on the Etsy IP
// indicators. It is the single place the Etsy pieces meet the compliance pieces.
//
// A PURE PROJECTION, exactly like complianceEngine.js's own
// complianceInputFromContentGenerationResult(). It reads a listing; it does not fetch,
// write, publish, approve, or modify anything, and compliance/complianceEngine.js is
// unchanged - the Etsy specifics arrive through the two extension points that module
// already provides: policy_context.platform_rules, and applyAdditionalFindings().
//
// ===================================================================================
// NEEDS_INFORMATION - THE RULE AGAINST FILLING IN GAPS.
// ===================================================================================
// A digital invitation listing is defined largely by facts that exist only in the seller's
// own files and account: which file formats are included, how many, at what dimensions,
// whether it is editable and where, how it is delivered, what licence comes with it. None
// of that can be inferred from a title, and inventing any of it would put a false claim in
// front of a buyer.
//
// So every such fact this module reports is either (a) present in the listing data, and
// carried through verbatim, or (b) absent, and reported as the literal string
// NEEDS_INFORMATION. There is no third case and no default. describeListingFacts() below
// is the whole of that logic, and it never consults anything but the record it was given -
// not the shop's other listings, not the business config, not a plausible assumption about
// what a shop like this usually sells.
//
// UNKNOWN PRODUCT NATURE IS ITSELF REPORTED. If the listing data does not say whether the
// product is digital or physical, the digital-fulfilment rules are NOT applied (blocking
// on an assumption would be fabrication) - but a REVIEW finding is raised naming the gap,
// so the check that could not run is visible rather than silently counted as passed.
//
// FAIL CLOSED. required_checks explicitly includes ip_indicators and platform_policy, so
// if either cannot run the engine's own "required check did not run" guard turns it into a
// REVIEW. Ambiguity resolves to REVIEW; it never resolves to PASS.

const { evaluateCompliance, applyAdditionalFindings } = require('./complianceEngine');
const { createComplianceFinding } = require('./complianceModel');
const { getEtsyPlatformRules } = require('./etsyPolicyRules');
const { detectEtsyIpRisk } = require('./etsyIpRiskDetector');

const ETSY_PLATFORM = 'etsy';

// The literal value reported for any product fact the listing data does not establish.
// A string constant rather than null/undefined so it survives serialization into a report
// and reads unambiguously to a human: this was not answered, and was not guessed.
const NEEDS_INFORMATION = 'NEEDS_INFORMATION';

// The checks this project requires for Etsy listing content. ip_indicators and
// platform_policy are named explicitly (beyond compliancePolicy.js's
// DEFAULT_REQUIRED_CHECKS) because for an Etsy listing they are the two that matter most,
// and naming them means a run in which either could not execute produces a REVIEW rather
// than a quiet omission.
const ETSY_REQUIRED_CHECKS = ['provenance', 'unsupported_claims', 'prohibited_content', 'ip_indicators', 'platform_policy'];

// The product facts a digital invitation listing is expected to establish, and the field
// on a normalized Etsy listing record that would carry each. Only fields Etsy actually
// returns are mapped; the rest have no source in the API at all, which is itself the
// honest answer and is why they resolve to NEEDS_INFORMATION rather than to a guess.
const DIGITAL_PRODUCT_FACTS = [
  { id: 'product_nature', label: 'Digital or physical', source_field: 'is_digital_product' },
  { id: 'listing_type', label: 'Etsy listing type', source_field: 'listing_type' },
  { id: 'price', label: 'Price', source_field: 'price' },
  { id: 'file_formats', label: 'Included file formats', source_field: null },
  { id: 'file_count', label: 'Number of files included', source_field: null },
  { id: 'dimensions', label: 'Finished dimensions', source_field: null },
  { id: 'editable_where', label: 'Whether and where the design is editable', source_field: null },
  { id: 'personalization', label: 'Personalization options', source_field: null },
  { id: 'delivery_method', label: 'How the buyer receives the files', source_field: null },
  { id: 'turnaround_time', label: 'Turnaround time', source_field: null },
  { id: 'licence', label: 'Rights/licence granted to the buyer', source_field: null },
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// True only when the listing record actually carries a usable value for a field. An empty
// string, null and undefined are all "absent" - a blank description does not establish
// anything, so it must not be reported as though it did.
function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// What this listing's own data does and does not establish. Every fact is either the
// listing's real value or the literal NEEDS_INFORMATION - see this file's header.
function describeListingFacts(listing) {
  if (!isPlainObject(listing)) {
    throw new Error('describeListingFacts requires a normalized Etsy listing record.');
  }
  const facts = {};
  for (const fact of DIGITAL_PRODUCT_FACTS) {
    const value = fact.source_field ? listing[fact.source_field] : undefined;
    facts[fact.id] = hasValue(value) ? value : NEEDS_INFORMATION;
  }
  return facts;
}

// The facts that came back unanswered, for reporting to a human.
function missingListingFacts(listing) {
  const facts = describeListingFacts(listing);
  return DIGITAL_PRODUCT_FACTS.filter((fact) => facts[fact.id] === NEEDS_INFORMATION).map((fact) => fact.id);
}

// The text a compliance check actually reads: the listing's own title, description and
// tags, joined. Only real listing text - nothing generated, nothing padded.
function listingContent(listing) {
  const parts = [];
  if (isNonEmptyString(listing.title)) parts.push(listing.title);
  if (isNonEmptyString(listing.description)) parts.push(listing.description);
  if (Array.isArray(listing.tags) && listing.tags.length > 0) parts.push(listing.tags.join(', '));
  return parts.join('\n\n');
}

// Projects one normalized Etsy listing (from
// integrations/adapters/etsyReadClient.js's normalizeEtsyListing) into a compliance input.
//
// `extras` supplies only what the listing itself has no concept of - the business's own
// declared brands and vocabulary, any competitor text to check for copying, and any
// additional prohibited terms. Nothing in extras can widen what the checks permit; it can
// only give them more to check against.
function complianceInputFromEtsyListing(listing, extras = {}) {
  if (!isPlainObject(listing)) {
    throw new Error('complianceInputFromEtsyListing requires a normalized Etsy listing record.');
  }
  const content = listingContent(listing);
  if (!isNonEmptyString(content)) {
    throw new Error(
      'complianceInputFromEtsyListing requires a listing carrying title, description or tag text - there is ' +
        'nothing for Compliance to check otherwise.'
    );
  }

  const businessContext = isPlainObject(extras.businessContext) ? extras.businessContext : {};

  return {
    content,
    content_type: 'etsy_listing',
    content_reference: isNonEmptyString(String(listing.listing_id || '')) ? `etsy_listing_${listing.listing_id}` : 'etsy_listing',
    provenance: {
      // The content was READ from the seller's live listing, not generated. Saying so
      // precisely is what lets the provenance check pass honestly.
      source: 'etsy_listing_data_retrieval',
      generator: 'integrations/adapters/etsyReadClient.js',
      evidence: [`Etsy listing ${listing.listing_id} as returned by the Etsy Open API v3`],
      supported_facts: Array.isArray(extras.supportedFacts) ? extras.supportedFacts : [],
    },
    reference_materials: Array.isArray(extras.referenceMaterials) ? extras.referenceMaterials : [],
    platform_context: { platform: ETSY_PLATFORM, surface: 'listing' },
    business_context: {
      business_id: isNonEmptyString(extras.businessId) ? extras.businessId : '',
      brand_names: Array.isArray(businessContext.brand_names) ? businessContext.brand_names : [],
      third_party_brands: Array.isArray(businessContext.third_party_brands) ? businessContext.third_party_brands : [],
    },
    policy_context: {
      // The digital-fulfilment rules are included ONLY when the listing's own data
      // confirms the product is digital - see compliance/etsyPolicyRules.js.
      platform_rules: getEtsyPlatformRules({ isDigitalProduct: listing.is_digital_product }),
      prohibited_terms: Array.isArray(extras.prohibitedTerms) ? extras.prohibitedTerms : [],
    },
    required_checks: ETSY_REQUIRED_CHECKS,
  };
}

// Runs the full Etsy compliance check for one listing and returns
// { result, facts, missing_facts }.
//
// THREE LAYERS, IN ORDER, EACH ONLY ABLE TO ESCALATE:
//   1. evaluateCompliance() - the existing six checks, with the Etsy platform rules
//      applied. This is the only layer that can produce BLOCK, and only from an explicit
//      configured rule.
//   2. The Etsy IP indicators - review/info only.
//   3. The unknown-product-nature finding - review only, raised when the listing data did
//      not say whether the product is digital, so the fulfilment rules could not run.
// Layers 2 and 3 go through applyAdditionalFindings(), which re-derives the verdict from
// the accumulated findings and REFUSES block severity - so PASS can become REVIEW, but
// nothing here can ever turn a REVIEW or BLOCK back into a PASS.
function checkEtsyListingCompliance(listing, extras = {}) {
  const input = complianceInputFromEtsyListing(listing, extras);
  const baseResult = evaluateCompliance(input);

  const additionalFindings = [];
  const additionalLimitations = [];

  const businessContext = isPlainObject(extras.businessContext) ? extras.businessContext : {};

  // The listing's OWN tags count as declared vocabulary for the IP detector.
  //
  // WHY THIS IS SAFE AND WHY IT MATTERS. Etsy titles are conventionally title-cased, so
  // the structural pass would otherwise report the ordinary descriptive words of almost
  // every listing - and a signal that fires on everything is not a signal. A tag is the
  // seller's own descriptive word for their own product, so treating it as accounted-for
  // is the same principle as the shop's declared brand vocabulary. It does NOT weaken
  // mark detection: the known-marks pass matches literally and is not filtered by
  // vocabulary at all, so tagging a listing 'bluey' still produces a protected-mark
  // finding. It only stops 'Floral' being reported as a mystery name on a listing tagged
  // 'floral'.
  const vocabularyContext = {
    ...businessContext,
    known_vocabulary: [
      ...(Array.isArray(businessContext.known_vocabulary) ? businessContext.known_vocabulary : []),
      ...(Array.isArray(listing.tags) ? listing.tags : []),
    ],
  };
  additionalFindings.push(...detectEtsyIpRisk({ content: input.content, businessContext: vocabularyContext }));

  if (listing.is_digital_product !== true && listing.is_digital_product !== false) {
    additionalFindings.push(
      createComplianceFinding({
        checkType: 'platform_policy',
        ruleId: 'etsy_product_nature_undetermined',
        severity: 'review',
        reason:
          "The listing data did not establish whether this product is digital or physical (neither 'is_digital' " +
          "nor a recognized 'listing_type' was present), so the rules that check a digital product is not " +
          'described as a physical one could not be applied. They were NOT applied on an assumption.',
        recommendedAction:
          'Confirm from the listing itself whether this is a digital download, then re-run the check so the ' +
          'fulfilment rules can actually run.',
      })
    );
  }

  const missing = missingListingFacts(listing);
  if (missing.length > 0) {
    additionalLimitations.push(
      `${missing.length} product fact(s) are not established by this listing's data and are reported as ` +
        `${NEEDS_INFORMATION} rather than inferred: ${missing.join(', ')}.`
    );
  }

  const result =
    additionalFindings.length > 0 || additionalLimitations.length > 0
      ? applyAdditionalFindings(baseResult, additionalFindings, additionalLimitations)
      : baseResult;

  return { result, facts: describeListingFacts(listing), missing_facts: missing };
}

module.exports = {
  ETSY_PLATFORM,
  NEEDS_INFORMATION,
  ETSY_REQUIRED_CHECKS,
  DIGITAL_PRODUCT_FACTS,
  describeListingFacts,
  missingListingFacts,
  listingContent,
  complianceInputFromEtsyListing,
  checkEtsyListingCompliance,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Etsy listing compliance (fail-closed, nothing inferred):\n');

  const listing = {
    channel: 'etsy',
    listing_id: 1234567890,
    title: 'Mickey Mouse Birthday Invitation',
    description: 'A lovely design. Ships in 3 business days, printed on cardstock.',
    tags: ['birthday', 'invitation'],
    is_digital_product: true,
    listing_type: 'download',
    price: null,
  };

  const outcome = checkEtsyListingCompliance(listing, {
    businessContext: { brand_names: ['Digital Studio By Naeema'] },
  });

  console.log(`Verdict: ${outcome.result.status}`);
  console.log(`Findings: ${outcome.result.findings.length}`);
  for (const finding of outcome.result.findings) {
    console.log(`  [${finding.severity}] ${finding.rule_id}`);
  }
  console.log(`\nProduct facts this listing's own data did NOT establish (reported as ${NEEDS_INFORMATION}):`);
  console.log(`  ${outcome.missing_facts.join(', ')}`);
  console.log('\nA verdict is not a clearance - the standing limitations travel with every result.');
}
