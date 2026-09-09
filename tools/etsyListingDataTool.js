'use strict';

// The etsy_listing_data_retrieval tool (tools/toolRegistry.js). Read-only: it retrieves
// the connected Etsy shop's own listings and reports, per listing, what its data does and
// does not establish plus the compliance verdict for its existing content. It writes
// nothing to Etsy and cannot - integrations/adapters/etsyReadClient.js issues GET requests
// only, and integrations/adapters/etsyClient.js's publish path remains closed and is not
// referenced here at all.
//
// WHY THE COMPLIANCE VERDICT TRAVELS WITH THE DATA. Returning Etsy listing text as plain
// retrieved data would invite every later step to treat it as safe by default - and this
// shop's existing listings are exactly where an unreviewed protected mark or an inaccurate
// physical-fulfilment claim would already be sitting. Attaching the verdict at retrieval
// means the content is never in circulation without it. The verdict is computed by the
// EXISTING engine through compliance/etsyComplianceInput.js; nothing is judged here.
//
// NOTHING IS INFERRED. Each listing carries `missing_facts` - the product facts (file
// formats, counts, dimensions, editability, delivery, turnaround, licence) that its own
// data does not establish, reported as NEEDS_INFORMATION rather than filled in.
//
// NEVER THROWS - same honest {status, result, error} envelope as every other
// TOOL_EXECUTORS entry.

const etsyReadClient = require('../integrations/adapters/etsyReadClient');
const { checkEtsyListingCompliance } = require('../compliance/etsyComplianceInput');

// Etsy listing verdict -> this project's tool status vocabulary. Identical mapping to
// tools/complianceCheckTool.js's, reused rather than reinvented so one verdict never means
// two different things depending on which tool reported it.
const COMPLIANCE_STATUS_TO_TOOL_STATUS = { PASS: 'success', REVIEW: 'partial', BLOCK: 'blocked' };

// Bounded by default so one call cannot walk an entire catalogue and spend the day's Etsy
// quota - the caller raises it deliberately when it means to.
const DEFAULT_LISTING_LIMIT = 25;

async function retrieveEtsyListingData(params = {}) {
  return etsyReadClient.getEtsyListings(params);
}

// The worst verdict across the listings checked. Worst-wins, so a single BLOCK is never
// averaged away by a page of clean listings.
function aggregateVerdict(verdicts) {
  if (verdicts.includes('BLOCK')) return 'BLOCK';
  if (verdicts.includes('REVIEW')) return 'REVIEW';
  return 'PASS';
}

async function runEtsyListingDataTool(researchParams) {
  const params = researchParams && typeof researchParams === 'object' ? researchParams : {};
  const businessId = params.businessId || null;

  try {
    if (!etsyReadClient.canRead({ businessId })) {
      const missing = etsyReadClient.missingReadCredentials(businessId);
      return {
        status: 'failed',
        result: null,
        // Key names only - no credential value is ever placed in a tool result.
        error: `Etsy reading is not configured: ${missing.join(', ')} not set. No Etsy request was attempted.`,
      };
    }

    const listings = await retrieveEtsyListingData({
      businessId,
      limit: params.limit || DEFAULT_LISTING_LIMIT,
      offset: params.offset || 0,
      state: params.state || null,
    });

    if (!Array.isArray(listings) || listings.length === 0) {
      return { status: 'empty', result: null, error: null };
    }

    const businessContext = params.businessContext && typeof params.businessContext === 'object' ? params.businessContext : {};

    const checked = listings.map((listing) => {
      const outcome = checkEtsyListingCompliance(listing, { businessContext, businessId: businessId || '' });
      return {
        listing,
        facts: outcome.facts,
        missing_facts: outcome.missing_facts,
        compliance: {
          status: outcome.result.status,
          review_reasons: outcome.result.review_reasons,
          findings: outcome.result.findings,
          checked_at: outcome.result.checked_at,
          checker_version: outcome.result.checker_version,
          limitations: outcome.result.limitations,
        },
      };
    });

    const verdict = aggregateVerdict(checked.map((entry) => entry.compliance.status));

    return {
      status: COMPLIANCE_STATUS_TO_TOOL_STATUS[verdict],
      result: {
        channel: etsyReadClient.ETSY_CHANNEL,
        listing_count: checked.length,
        aggregate_compliance_status: verdict,
        listings: checked,
        // Reported so a reader knows this is one page of a catalogue, not the whole of it.
        pagination: { limit: params.limit || DEFAULT_LISTING_LIMIT, offset: params.offset || 0 },
      },
      error: null,
    };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = {
  COMPLIANCE_STATUS_TO_TOOL_STATUS,
  DEFAULT_LISTING_LIMIT,
  retrieveEtsyListingData,
  aggregateVerdict,
  runEtsyListingDataTool,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - etsy_listing_data_retrieval (read-only, compliance attached):\n');
  runEtsyListingDataTool({}).then((outcome) => {
    console.log(`Status: ${outcome.status}`);
    if (outcome.error) console.log(`Reported: ${outcome.error}`);
    if (outcome.result) {
      console.log(`Listings: ${outcome.result.listing_count}`);
      console.log(`Aggregate compliance: ${outcome.result.aggregate_compliance_status}`);
    }
  });
}
