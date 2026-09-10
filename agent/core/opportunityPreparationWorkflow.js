'use strict';

// Takes ONE already-discovered market opportunity and prepares it for a human decision:
//
//   opportunity -> product validation -> SEO -> listing draft -> compliance -> approval
//
// IT IS NOT A SECOND ORCHESTRATOR. It defines a stage LIST and the glue around it; the
// stages themselves are run by the existing agent/core/growthWorkflowOrchestrator.js
// engine, whose stage list became injectable for exactly this reason. Every stage still
// executes through buildPlanStep with that engine's own trackers, approval gating, audit
// trail, usage ledger and tool-result cache. There is no dispatch logic in this file.
//
// IT STOPS BEFORE ANY MARKETPLACE WRITE. The last thing it does is create a PENDING
// approval request through the existing approvals/approvalWorkflow.js. Nothing here
// publishes, updates, prices or creates anything on Shopify or Etsy, and no tool it can
// reach is capable of doing so - every stage tool is classified analysis_only.
//
// ETSY CANNOT BE AUTHORISED TO PUBLISH FROM HERE, and that is structural rather than a
// promise: this project registers no Etsy write tool, integrations/adapters/etsyClient.js
// reports canPublish() false, and the read client issues GET only. An Etsy opportunity
// therefore reaches AWAITING_APPROVAL and stops - it can never reach PUBLISH_AUTHORIZED.
//
// NOTHING IS INVENTED. The listing draft is built from what the opportunity's own record
// established. A product fact the research did not establish is reported as
// NEEDS_INFORMATION rather than written into marketing copy - see collectMissingFacts.

const { runGrowthWorkflow } = require('./growthWorkflowOrchestrator');
const { createApprovalRequest } = require('../../approvals/approvalWorkflow');
const { evaluateCompliance } = require('../../compliance/complianceEngine');
const { detectProtectedMarks } = require('../../compliance/etsyIpRiskDetector');

// The explicit lifecycle. A state is only ever set from a real outcome; there is no
// PUBLISHED or PUBLISH_AUTHORIZED here, because this workflow cannot reach them.
const WORKFLOW_STATES = [
  'DISCOVERED',
  'VALIDATING',
  'VALIDATED',
  'COMPLIANCE_REVIEW',
  'COMPLIANCE_BLOCKED',
  'SEO_ANALYSIS',
  'LISTING_DRAFT',
  'NEEDS_INFORMATION',
  'AWAITING_APPROVAL',
  'FAILED',
];

// The product facts a digital-product listing needs and that market research does not
// establish. Each is reported as NEEDS_INFORMATION rather than guessed - writing "instant
// download, editable in Canva, commercial licence included" about a product nobody has
// specified is exactly the fabrication this project refuses.
const REQUIRED_LISTING_FACTS = [
  'file_formats',
  'file_count',
  'dimensions',
  'editable_where',
  'personalization',
  'delivery_method',
  'turnaround_time',
  'licence',
];

// The stage list handed to the existing engine. Order is deliberate and differs from the
// growth workflow's: SEO runs BEFORE the listing draft, so the draft is written with the
// SEO result available rather than analysed afterwards.
const OPPORTUNITY_PREPARATION_STAGES = [
  {
    key: 'validation',
    specialistId: 'product',
    objective: 'Validate whether this market opportunity is genuinely suitable for this business.',
    forcedSelection: { toolId: 'product_research', capabilityId: 'product_opportunity_analysis' },
  },
  {
    key: 'seo',
    specialistId: 'seo',
    objective: 'Analyse search visibility for the validated opportunity.',
    forcedSelection: { toolId: 'seo_analysis', capabilityId: 'product_seo' },
  },
  {
    key: 'listing',
    specialistId: 'listing',
    objective: 'Compose a listing content draft for the validated opportunity.',
    forcedSelection: { toolId: 'listing_content_generation', capabilityId: 'listing_content' },
  },
];

const STAGE_KEYS = OPPORTUNITY_PREPARATION_STAGES.map((stage) => stage.key);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// A stable, compact reference to the opportunity being prepared. Deliberately NOT a copy
// of the research result: it names where the opportunity lives (session + run + rank) and
// carries only the few fields the later stages and the approval record actually read.
// No credential can appear here because none exists in the source record.
function buildOpportunitySnapshot(opportunity, { sessionId = null, runId = null } = {}) {
  if (!opportunity || typeof opportunity !== 'object') {
    throw new Error('buildOpportunitySnapshot requires the opportunity record.');
  }
  return {
    session_id: sessionId,
    run_id: runId,
    rank: opportunity.rank !== undefined ? opportunity.rank : null,
    product: opportunity.product || null,
    market: opportunity.market || null,
    // Relayed, never recomputed - the research already decided these.
    customer_fit_reason: opportunity.customer_fit_reason || null,
    scores: opportunity.scores || null,
    compliance: opportunity.compliance || null,
    // Channel only when the record explicitly carries one. Never inferred from a product
    // name, and never defaulted to Shopify.
    channel: opportunity.channel || null,
    channel_reference: opportunity.channel_reference || null,
    // Source URLs only - the evidence itself stays in the run record.
    evidence_refs: asArray(opportunity.evidence)
      .map((item) => item && item.source_url)
      .filter(Boolean),
  };
}

// Evidence for the specialists, built ONLY from what the opportunity record established.
// Each entry names the real research run it came from.
function buildStageEvidence(snapshot) {
  const source = [`Market opportunity #${snapshot.rank} from research run ${snapshot.run_id || 'unknown'}`];
  const evidence = [];
  if (snapshot.customer_fit_reason) {
    evidence.push({ topic: 'Customer fit', finding: snapshot.customer_fit_reason, source });
  }
  if (snapshot.market) {
    evidence.push({ topic: 'Market', finding: `The research placed this opportunity in "${snapshot.market}".`, source });
  }
  const scores = snapshot.scores || {};
  if (typeof scores.evidence_coverage === 'number') {
    evidence.push({
      topic: 'Evidence coverage',
      finding: `The research measured ${scores.evidence_coverage}% evidence coverage across its own signal dimensions.`,
      source,
    });
  }
  return evidence;
}

// The product facts this opportunity does NOT establish. Everything in
// REQUIRED_LISTING_FACTS is missing unless the opportunity record genuinely carries it -
// market research establishes demand and relevance, not file formats.
function collectMissingFacts(opportunity) {
  const established = opportunity && opportunity.facts && typeof opportunity.facts === 'object' ? opportunity.facts : {};
  return REQUIRED_LISTING_FACTS.filter((fact) => !nonEmptyString(established[fact]));
}

// The compliance gate, run through the EXISTING engine on the draft's own text. Never
// rewrites anything to make a verdict pass.
// The product name is ALWAYS included alongside the draft text, never used only as a
// fallback when the draft is empty: a protected mark most often arrives in the product name
// itself ("Disney Alphabet Font"), and checking only generated copy would let it through.
function checkDraftCompliance(snapshot, draftText) {
  const content = [snapshot.product, draftText].filter(nonEmptyString).join('\n');
  const verdict = evaluateCompliance({
    content,
    content_type: 'listing_draft',
    content_reference: `opportunity-${snapshot.rank}`,
    provenance: {
      source: 'opportunity_preparation_workflow',
      generator: 'agent/core/opportunityPreparationWorkflow.js',
      evidence: snapshot.evidence_refs,
      supported_facts: [],
    },
    required_checks: ['provenance', 'unsupported_claims', 'prohibited_content'],
  });

  // THE PROTECTED-MARK HARD STOP, applied on exactly the rule and the exact function
  // workflows/customerMarketOpportunityWorkflow.js already applies at discovery time.
  // complianceEngine.js's own ip_indicators check only detects CALLER-DECLARED third-party
  // brands and affiliation wording - it does not carry the known-mark list, which lives in
  // compliance/etsyIpRiskDetector.js. Without this pass a draft titled "Star Wars Alphabet
  // Bundle" would reach a human as REVIEW rather than BLOCK.
  //
  // A mark is NEVER reworded around to get past this, and a high-demand brand term is never
  // kept because it is popular - the opportunity is excluded instead.
  const marks = detectProtectedMarks(content);
  if (marks.length > 0) {
    return {
      status: 'BLOCK',
      review_reasons: verdict.review_reasons,
      findings: marks.map((mark) => ({
        check_type: 'ip_indicators',
        severity: 'block',
        message: `Protected mark indicator '${mark.mark || mark}' appears in this opportunity. Excluded rather than reworded.`,
      })),
      limitations: verdict.limitations,
      checked_at: verdict.checked_at,
      checker_version: verdict.checker_version,
    };
  }

  return {
    status: verdict.status,
    review_reasons: verdict.review_reasons,
    findings: verdict.findings,
    limitations: verdict.limitations,
    checked_at: verdict.checked_at,
    checker_version: verdict.checker_version,
  };
}

// Maps the opportunity's OWN recorded signals onto the product validation tool's optional
// dimension inputs, so evidence the research already gathered is reused instead of the
// validation stage reporting every dimension as unassessed.
//
// STRICTLY A RELAY. A dimension is supplied only when the research actually recorded an
// assessment for it; nothing is invented, and the confidence carried is the research's own.
// A signal the research left empty stays empty, and the tool then honestly reports it as
// having no evidence-backed assessment - which is the correct outcome, not a gap to fill.
//
// Evidence is handed over as { topic, finding, source } records, which is the shape
// agent/core/researchAgent.js's retrieveResearchData('generic', ...) requires - the same
// shape buildStageEvidence above already uses. Passing bare source URLs instead makes
// productAgent.js reject the whole call for a missing `topic`.
function buildValidationDimensions(opportunity, snapshot) {
  const params = {};
  const runReference = `Market opportunity #${snapshot.rank} from research run ${snapshot.run_id || 'unknown'}`;
  const map = [
    ['demand', 'Demand', 'demandAssessment', 'demandEvidence', 'demandConfidence'],
    ['competition', 'Competition', 'competitionAssessment', 'competitionEvidence', 'competitionConfidence'],
  ];
  for (const [key, topic, assessmentKey, evidenceKey, confidenceKey] of map) {
    const signal = opportunity && opportunity[key];
    if (!signal || !nonEmptyString(signal.assessment)) continue;
    const sources = asArray(signal.source).filter(nonEmptyString);
    params[assessmentKey] = signal.assessment;
    params[evidenceKey] = [
      { topic, finding: signal.assessment, source: sources.length > 0 ? sources : [runReference] },
    ];
    // The research's OWN confidence, relayed verbatim. Never upgraded, never defaulted -
    // an unstated confidence stays unstated, and productAgent.js then reports it as
    // 'unassessed' itself.
    if (nonEmptyString(signal.confidence)) params[confidenceKey] = signal.confidence;
  }
  // Market fit is the research's own customer-fit finding - the one dimension it measured
  // directly rather than characterised. No confidence is supplied because the research
  // never stated one for it; inventing a 'medium' here would be a fabricated figure.
  if (nonEmptyString(snapshot.customer_fit_reason)) {
    params.marketFitAssessment = snapshot.customer_fit_reason;
    params.marketFitEvidence = [
      { topic: 'Customer fit', finding: snapshot.customer_fit_reason, source: [runReference] },
    ];
  }
  return params;
}

// Reads a stage's real output from the plan the engine returned.
function stageOutput(plan, index) {
  const step = asArray(plan)[index];
  if (!step || !step.outputs) return null;
  return step.outputs.result || step.outputs;
}

function stageStatus(plan, index) {
  const step = asArray(plan)[index];
  return step ? step.completion_state || null : null;
}

// The listing DRAFT itself, which is not the tool's top-level result. tools/listingContentTool.js
// returns a research-record-shaped envelope (topic/findings/evidence/limitations) whose
// `specialized_records[0]` is the real agent/core/listingContentModel.js draft - the same
// place agent/core/crossAgentContext.js's own extractors read. Reading the envelope instead
// would silently hand compliance an empty string and check nothing.
function extractListingDraft(listingResult) {
  const records = listingResult && Array.isArray(listingResult.specialized_records)
    ? listingResult.specialized_records
    : [];
  const record = records[0];
  return record && typeof record === 'object' ? record : null;
}

// Whether the draft carries anything a person could actually review. A product_title alone
// does not count - listingContentTool.js echoes the caller's own productTitle into it, so a
// draft with only that field contains no composed content at all.
function draftIsReviewable(draft) {
  if (!draft) return false;
  return (
    nonEmptyString(draft.description) ||
    asArray(draft.benefits).length > 0 ||
    asArray(draft.features).length > 0 ||
    asArray(draft.selling_points).length > 0
  );
}

// Every piece of caller-facing text in the draft, concatenated for the compliance engine.
// Assembled from the draft's real fields only - if the draft is empty because nothing was
// established, this is empty too, and compliance is told so rather than being handed the
// product name as a stand-in for copy that does not exist.
function draftTextForCompliance(draft) {
  if (!draft) return '';
  return [
    draft.product_title,
    draft.description,
    draft.cta,
    ...asArray(draft.benefits),
    ...asArray(draft.features),
    ...asArray(draft.selling_points),
  ]
    .filter(nonEmptyString)
    .join('\n');
}

// Prepares one opportunity. `runWorkflow` is injectable ONLY so tests can drive the
// sequencing without spending tokens; production passes nothing and gets the real engine.
async function prepareOpportunity({
  opportunity,
  sessionId = null,
  runId = null,
  businessId = null,
  approvalRequests = null,
  runWorkflow = runGrowthWorkflow,
} = {}) {
  const snapshot = buildOpportunitySnapshot(opportunity, { sessionId, runId });
  const missingFacts = collectMissingFacts(opportunity);

  // GATE ONE, before any specialist runs: an opportunity the research already BLOCKED
  // never proceeds toward a publishable listing, and no tokens are spent on it.
  const inboundCompliance = snapshot.compliance || null;
  if (inboundCompliance && inboundCompliance.status === 'BLOCK') {
    return {
      state: 'COMPLIANCE_BLOCKED',
      opportunity: snapshot,
      draft: null,
      stages: {},
      compliance: inboundCompliance,
      approval: null,
      missing_information: missingFacts,
      limitations: [
        'The research already returned a BLOCK compliance verdict for this opportunity, so no listing was prepared. A protected mark is never reworded to get past the detector.',
      ],
    };
  }

  const evidence = buildStageEvidence(snapshot);
  const productReference = snapshot.product || `Opportunity #${snapshot.rank}`;

  const outcome = await runWorkflow(
    businessId,
    {
      validation: { productIdentity: productReference, evidence, ...buildValidationDimensions(opportunity, snapshot) },
      seo: { seoCapability: 'product_seo', productReference, internalOptimizationOpportunities: [], evidence },
      listing: {
        listingCapability: 'listing_content',
        productReference,
        productTitle: productReference,
        // Only what the research established. No benefit is invented here.
        benefits: snapshot.customer_fit_reason ? [snapshot.customer_fit_reason] : [],
        evidence,
      },
    },
    { stages: OPPORTUNITY_PREPARATION_STAGES, runIdPrefix: 'opportunity-prep' }
  );

  const plan = asArray(outcome && outcome.plan);
  const stages = {
    validation: { status: stageStatus(plan, 0), result: stageOutput(plan, 0) },
    seo: { status: stageStatus(plan, 1), result: stageOutput(plan, 1) },
    listing: { status: stageStatus(plan, 2), result: stageOutput(plan, 2) },
  };

  // GATE TWO: the draft's own text goes through the existing compliance engine.
  const draft = extractListingDraft(stages.listing.result);
  const draftCompliance = checkDraftCompliance(snapshot, draftTextForCompliance(draft));

  if (draftCompliance.status === 'BLOCK') {
    return {
      state: 'COMPLIANCE_BLOCKED',
      opportunity: snapshot,
      draft: null,
      stages,
      compliance: draftCompliance,
      approval: null,
      missing_information: missingFacts,
      limitations: ['The listing draft did not clear compliance, so no approval was requested.'],
      workflow_run_id: outcome && outcome.run_id ? outcome.run_id : null,
    };
  }

  // GATE THREE: is there actually a draft for a person to decide on? The listing tool
  // invents nothing (see its own limitations), so an opportunity whose product facts were
  // never established composes an EMPTY draft - a title echoing the product reference and
  // nothing else. Asking a human to approve that would be asking them to approve a blank
  // page, so the workflow stops at NEEDS_INFORMATION and names exactly what is missing.
  // Fabricating the missing facts to produce a reviewable draft is the one thing this
  // workflow must never do.
  if (!draftIsReviewable(draft)) {
    return {
      state: 'NEEDS_INFORMATION',
      opportunity: snapshot,
      draft,
      stages,
      compliance: draftCompliance,
      approval: null,
      missing_information: missingFacts,
      limitations: [
        'No reviewable listing draft could be composed: the research established this opportunity\'s demand and relevance, not its product specification.',
        missingFacts.length > 0
          ? `${missingFacts.length} product fact(s) must be supplied by a person before a draft can be written: ${missingFacts.join(', ')}.`
          : 'No product description, benefits or selling points were established.',
      ],
      workflow_run_id: outcome && outcome.run_id ? outcome.run_id : null,
      audit_trail: outcome && outcome.audit_trail ? outcome.audit_trail : [],
      usage_summary: outcome && outcome.usage_summary ? outcome.usage_summary : null,
    };
  }

  // The approval request. Created for PASS and for REVIEW alike - a REVIEW draft needs a
  // human decision more than a PASS one does, and stalling it with no route to a person
  // would be the wrong kind of safe. Its compliance status travels with it unchanged, so
  // nothing downstream can read a REVIEW as cleared.
  let approval = null;
  const requests = Array.isArray(approvalRequests) ? approvalRequests : [];
  try {
    // The EXISTING approvals/approvalWorkflow.js contract, used exactly as
    // agent/core/orchestratorExecutionContract.js already uses it: a single object, a
    // deterministic per-run id, a real classification id, and an executionRequest the
    // decision can later be resumed against. No second approval mechanism.
    //
    // `listing_content_generation` is classified analysis_only, so nothing gated this
    // automatically - the request is created deliberately because the DRAFT is a proposal
    // for a consequential external action, and a person has to decide on it.
    approval = createApprovalRequest({
      // Scoped by session as well as rank: two sessions preparing their own "#1" must not
      // end up sharing one approval id.
      id: `apr-opportunity-${snapshot.session_id || 'nosession'}-${snapshot.rank}-${requests.length + 1}`,
      classification: 'approval_required',
      specialistId: 'listing',
      toolId: 'listing_content_generation',
      executionRequest: {
        business_id: businessId,
        specialist_id: 'listing',
        objective: `Publish the prepared listing draft for market opportunity #${snapshot.rank}.`,
        research_params: {
          opportunity: snapshot,
          // The channel this approval is FOR, only when the record stated one.
          target_channel: snapshot.channel,
          proposed_draft: draft,
          compliance_status: draftCompliance.status,
          evidence: snapshot.evidence_refs,
          missing_information: missingFacts,
          warnings:
            snapshot.channel === 'etsy'
              ? [
                  'Etsy is read-only in this project. This draft can be reviewed and approved, but it cannot be published to Etsy: no Etsy write tool exists and publishing is closed.',
                ]
              : [],
        },
      },
      reason:
        `A listing draft was prepared for market opportunity #${snapshot.rank} (${productReference}). ` +
        `Compliance returned ${draftCompliance.status}. ` +
        (missingFacts.length > 0
          ? `${missingFacts.length} product fact(s) remain unestablished: ${missingFacts.join(', ')}. `
          : '') +
        'Publishing it anywhere is a separate, human-approved action - nothing has been written to any marketplace.',
    });
    requests.push(approval);
  } catch (err) {
    return {
      state: 'FAILED',
      opportunity: snapshot,
      draft,
      stages,
      compliance: draftCompliance,
      approval: null,
      missing_information: missingFacts,
      limitations: [`An approval request could not be created: ${err.message}`],
      workflow_run_id: outcome && outcome.run_id ? outcome.run_id : null,
    };
  }

  // A reviewable draft exists and cleared GATE THREE above, so the workflow ends where it
  // is designed to end: waiting on a person. A REVIEW compliance verdict is carried in
  // `compliance` and is never smoothed into the state - a reader sees both.
  return {
    state: 'AWAITING_APPROVAL',
    opportunity: snapshot,
    draft,
    stages,
    compliance: draftCompliance,
    approval,
    missing_information: missingFacts,
    limitations: missingFacts.length > 0
      ? [
          `${missingFacts.length} product fact(s) are not established by the research and are reported as NEEDS_INFORMATION rather than written into the draft: ${missingFacts.join(', ')}.`,
        ]
      : [],
    workflow_run_id: outcome && outcome.run_id ? outcome.run_id : null,
    audit_trail: outcome && outcome.audit_trail ? outcome.audit_trail : [],
    usage_summary: outcome && outcome.usage_summary ? outcome.usage_summary : null,
  };
}

module.exports = {
  WORKFLOW_STATES,
  REQUIRED_LISTING_FACTS,
  OPPORTUNITY_PREPARATION_STAGES,
  STAGE_KEYS,
  buildOpportunitySnapshot,
  buildStageEvidence,
  buildValidationDimensions,
  collectMissingFacts,
  checkDraftCompliance,
  prepareOpportunity,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - opportunity preparation workflow:\n');
  console.log('Stages (run by the EXISTING growth workflow engine, not by this file):');
  for (const stage of OPPORTUNITY_PREPARATION_STAGES) {
    console.log(`  ${stage.key.padEnd(12)} ${stage.specialistId.padEnd(8)} ${stage.forcedSelection.toolId}/${stage.forcedSelection.capabilityId}`);
  }
  console.log(`\nStates: ${WORKFLOW_STATES.join(' -> ')}`);
  console.log('\nPUBLISH_AUTHORIZED and PUBLISHED are deliberately absent: this workflow ends at');
  console.log('a pending human approval and can reach no marketplace write.');
  console.log(`\nFacts always reported as NEEDS_INFORMATION unless the record establishes them:`);
  console.log(`  ${REQUIRED_LISTING_FACTS.join(', ')}`);
}
