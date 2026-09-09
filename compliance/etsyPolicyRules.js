'use strict';

// Etsy-specific policy rules, as DATA - the structured rule set
// compliance/complianceEngine.js's checkPlatformPolicy() already knows how to apply.
//
// WHY THIS FILE EXISTS. compliance/compliancePolicy.js deliberately holds NO rules for
// any named platform: it recognizes 'etsy' as a context but asserts nothing about Etsy's
// requirements, so an Etsy check today resolves to platform_policy_undetermined -> REVIEW.
// That was the honest state when no Etsy rule set had been established. This file
// establishes one, in the exact shape that boundary already consumes:
//   { id, platform, description, forbidden_phrases: [string], severity: 'block'|'review' }
// compliance/complianceEngine.js is NOT modified - rules arrive through the caller's
// policy_context.platform_rules, which is the extension point it was built with.
//
// ISOLATED SO IT CAN BE UPDATED. Etsy's policies change, and this project must not hard-
// code an assumption that they cannot. Every Etsy policy rule lives in this one file, so
// a policy update is a single-file edit reviewed on its own, not a hunt through the
// engine. Where current official Etsy documentation ever conflicts with a rule here, the
// documentation wins and this file is what changes.
//
// WHAT THESE RULES ARE, AND ARE NOT. They encode requirements this project can state
// factually about THIS shop's own products - primarily that a digital product must not be
// described as a physical one. They are NOT a reproduction of Etsy's Seller Policy, they
// are not exhaustive, and passing them is not a compliance clearance. That standing
// limitation is already attached to every result by compliancePolicy.js's
// LEGAL_LIMITATIONS, so it is not restated per-rule here.
//
// NO DUPLICATION OF EXISTING CHECKS. Guarantee/refund wording, absolute-verification
// claims and affiliation/endorsement wording are already covered by
// compliancePolicy.js's PROHIBITED_ASSERTION_RULES and AFFILIATION_CLAIM_RULES, which run
// on every check regardless of platform. Repeating them here would produce duplicate
// findings for one problem, so they are deliberately absent.
//
// LITERAL SUBSTRINGS, NEVER REGULAR EXPRESSIONS. checkPlatformPolicy() matches
// forbidden_phrases as literal, case-insensitive substrings and never compiles them, so
// nothing in this file can inject a pattern into the checking process. Phrases are
// therefore written as plain wording, and short ambiguous ones are given 'review' rather
// than 'block' precisely because a substring match cannot judge context.

const ETSY_PLATFORM = 'etsy';

// ---------------------------------------------------------------------------------
// Rule set 1: physical fulfilment described on a DIGITAL product.
// ---------------------------------------------------------------------------------
//
// These apply ONLY when the listing data itself confirms the product is digital (see
// getEtsyPlatformRules below). A digital download has no shipping, no paper, no
// envelope and no tracking - so asserting any of those is a factual claim about the
// product that its own data contradicts. That is why the unambiguous ones may BLOCK:
// the contradiction is deterministic, established from the listing's own record, and not
// a judgment call.
const DIGITAL_PRODUCT_FULFILMENT_RULES = [
  {
    id: 'etsy_digital_product_physical_shipping_claim',
    platform: ETSY_PLATFORM,
    description:
      'A digital product is described as being shipped or posted. A digital download is delivered as a file; ' +
      'nothing is dispatched, so this statement contradicts the listing\'s own product data.',
    forbidden_phrases: [
      'will be shipped',
      'ships in',
      'ships within',
      'we will mail',
      'sent by post',
      'arrives in the post',
      'tracking number',
      'delivery address',
      'shipping address',
    ],
    severity: 'block',
  },
  {
    id: 'etsy_digital_product_physical_material_claim',
    platform: ETSY_PLATFORM,
    description:
      'A digital product is described as a printed physical item with materials. The file itself has no paper ' +
      'stock, weight or finish, so this describes something the buyer does not receive.',
    forbidden_phrases: [
      'printed on cardstock',
      'printed on card stock',
      'printed on premium',
      'printed on matte',
      'printed on textured',
      'professionally printed',
      'envelopes included',
      'envelope included',
      'gsm paper',
    ],
    severity: 'block',
  },
  {
    id: 'etsy_digital_product_fulfilment_wording_needs_review',
    platform: ETSY_PLATFORM,
    description:
      'A digital product uses fulfilment or physical-material wording that MAY be legitimate in context (for ' +
      'example explaining that nothing ships, or advising the buyer how to print at home), but which a literal ' +
      'match cannot judge.',
    forbidden_phrases: [
      'free shipping',
      'shipping cost',
      'shipping time',
      'turnaround time',
      'paper quality',
      'card stock',
      'cardstock',
      'printing service',
      'we print',
    ],
    severity: 'review',
  },
];

// ---------------------------------------------------------------------------------
// Rule set 2: claims that require evidence this checker does not have.
// ---------------------------------------------------------------------------------
//
// REVIEW only, never BLOCK. Each of these may be perfectly true of a given product - the
// point is that its truth lives in the product's own files and rights, which a text check
// cannot see. Flagging routes it to the one party who can confirm it.
const UNEVIDENCED_CLAIM_RULES = [
  {
    id: 'etsy_third_party_editing_platform_claim',
    platform: ETSY_PLATFORM,
    description:
      'The content names a third-party editing or template platform. That is simultaneously a compatibility ' +
      'claim (does this product actually work there?) and a reference to another company\'s brand, and neither ' +
      'can be established from the text.',
    forbidden_phrases: ['canva', 'corjl', 'templett', 'photoshop', 'illustrator', 'google slides'],
    severity: 'review',
  },
  {
    id: 'etsy_licensing_or_commercial_use_claim',
    platform: ETSY_PLATFORM,
    description:
      'The content states what rights the buyer receives. What licence actually accompanies the files is a ' +
      'business and legal fact that must come from the product itself, never from generated wording.',
    forbidden_phrases: [
      'commercial use',
      'commercial license',
      'commercial licence',
      'resell',
      'resale rights',
      'extended license',
      'royalty free',
      'royalty-free',
    ],
    severity: 'review',
  },
  {
    id: 'etsy_file_specification_claim',
    platform: ETSY_PLATFORM,
    description:
      'The content states concrete file facts (formats, counts, dimensions, resolution). These are verifiable ' +
      'only against the actual files attached to the listing, which this checker cannot open.',
    forbidden_phrases: [
      'high resolution',
      'high-resolution',
      '300 dpi',
      'editable template',
      'instantly editable',
      'fully editable',
      'unlimited downloads',
      'unlimited prints',
    ],
    severity: 'review',
  },
];

// Rules that apply to any Etsy content regardless of whether the product is digital.
const ETSY_BASE_RULES = [...UNEVIDENCED_CLAIM_RULES];

// Every rule this file defines, for inspection and for tests. NOT the set applied to a
// given piece of content - use getEtsyPlatformRules() for that.
const ETSY_PLATFORM_RULES = [...DIGITAL_PRODUCT_FULFILMENT_RULES, ...ETSY_BASE_RULES];

// The rules that apply to ONE listing, given what its own data says about it.
//
// THE DIGITAL RULES ARE NOT APPLIED ON AN ASSUMPTION. isDigitalProduct comes from the
// listing record's own is_digital/listing_type fields (see
// integrations/adapters/etsyReadClient.js's normalizeEtsyListing), and it is null when
// Etsy reported neither. Three distinct cases, deliberately:
//   true  -> the fulfilment rules apply, and the unambiguous ones may BLOCK.
//   false -> they do not apply; a physical product legitimately ships.
//   null  -> they do NOT apply either, because blocking on an assumption would be
//            fabricating the product's nature. Instead the caller
//            (compliance/etsyComplianceInput.js) raises a REVIEW for the unknown, so the
//            gap is reported rather than guessed in either direction.
function getEtsyPlatformRules({ isDigitalProduct = null } = {}) {
  if (isDigitalProduct === true) return [...DIGITAL_PRODUCT_FULFILMENT_RULES, ...ETSY_BASE_RULES];
  return [...ETSY_BASE_RULES];
}

function getEtsyRuleById(id) {
  return ETSY_PLATFORM_RULES.find((rule) => rule.id === id) || null;
}

module.exports = {
  ETSY_PLATFORM,
  DIGITAL_PRODUCT_FULFILMENT_RULES,
  UNEVIDENCED_CLAIM_RULES,
  ETSY_BASE_RULES,
  ETSY_PLATFORM_RULES,
  getEtsyPlatformRules,
  getEtsyRuleById,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Etsy policy rules (data only, applied by the existing engine):\n');
  console.log('Rules that can BLOCK - only on a listing whose own data confirms it is digital:');
  for (const rule of ETSY_PLATFORM_RULES.filter((entry) => entry.severity === 'block')) {
    console.log(`  [${rule.id}] ${rule.forbidden_phrases.length} phrase(s)`);
  }
  console.log('\nRules that can only ever REVIEW:');
  for (const rule of ETSY_PLATFORM_RULES.filter((entry) => entry.severity === 'review')) {
    console.log(`  [${rule.id}] ${rule.forbidden_phrases.length} phrase(s)`);
  }
  console.log('\nRules actually applied, by what the listing data says the product is:');
  console.log(`  is_digital_product true:    ${getEtsyPlatformRules({ isDigitalProduct: true }).length} rule(s)`);
  console.log(`  is_digital_product false:   ${getEtsyPlatformRules({ isDigitalProduct: false }).length} rule(s)`);
  console.log(`  is_digital_product unknown: ${getEtsyPlatformRules({ isDigitalProduct: null }).length} rule(s) (the gap is reported, not assumed)`);
}
