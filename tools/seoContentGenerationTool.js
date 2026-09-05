'use strict';

// The seo_content_generation tool (tools/toolRegistry.js): the workflow stage AFTER the
// Information Gap Finder. Takes a validated information-gap opportunity, composes a
// structured content brief, and - only when the evidence justifies it - generates a
// content draft for a human to review.
//
// THIS TOOL PUBLISHES NOTHING. It has no integration import, no HTTP call of its own, no
// destination or schedule field. Its output is a brief plus a draft; Compliance, human
// approval and publishing are separate, later stages that do not exist yet. `target_page`
// records where the content is INTENDED to go - nothing here writes to it.
//
// REUSES THE EXISTING MODEL PATH, ADDS NO CLIENT. Generation goes through
// tools/aiReasoningCompletion.js's runReasoningCompletion(), which is itself a thin
// wrapper over agent/core/aiProviderSelector.js. So AI_PROVIDER selection, the shared
// per-run token budget (agent/core/tokenControls.js), and the input/output token split
// used by usage/usageTracker.js all apply here exactly as they do to every other model
// call. There is no new Claude client, no new Gemini client, and no provider decision
// made in this file - required as a module object so a test can substitute it without a
// mocking framework, matching this project's existing convention.
//
// DETERMINISTIC WORK STAYS DETERMINISTIC. Validating the opportunity, composing the
// brief, assembling the prompt, and scrutinizing what came back are all
// agent/core/contentBriefEngine.js's job and cost zero tokens. The model is used for one
// thing only: writing the prose. A blocked or review opportunity never reaches it at all,
// so an unevidenced question costs nothing.
//
// NO SEPARATE GENERATOR WAS BUILT WHERE ONE EXISTED. agent/core/listingAgent.js's
// generateListingContent() was inspected first and is deliberately not reused: it is
// product-listing-shaped (title/benefits/features/attributes/variants/CTA) and,
// by its own documented design, only ever RELAYS text a caller already supplied - it
// never writes a sentence. Neither property fits website SEO content answering a
// customer question, so forcing it would have meant either corrupting its semantics or
// silently producing empty content. This capability is separate for that reason.
//
// Returns { status, result, error, model, stopReason, tokensUsed, inputTokens,
// outputTokens } - never throws. Usage fields are present only when a model call was
// actually made (a blocked/review opportunity makes none, and spends nothing).
//   status 'failed'  - no/invalid opportunity supplied, or the model call itself failed
//   status 'blocked' - the opportunity must not become content (see the result's
//                       review_reasons); no model call was made
//   status 'partial' - a brief was produced but the content is not ready: either the
//                       opportunity needed review, or the draft failed a post-check
//   status 'success' - brief and draft produced, every post-check passed

const { runReasoningCompletion } = require('./aiReasoningCompletion');
const {
  gateOpportunity,
  buildBrief,
  buildGenerationInstruction,
  checkGeneratedContent,
} = require('../agent/core/contentBriefEngine');
const {
  createEmptyContentGenerationResult,
  validateContentGenerationResultShape,
} = require('../agent/core/contentBriefModel');

// A conservative per-call ceiling for one piece of content. tokenControls.js caps this
// against both the per-call ceiling and the run's remaining budget, so this is a request,
// never an entitlement.
const MAX_TOKENS = 2048;

const BASE_LIMITATIONS = [
  'This is a draft for a human to review - nothing here is published, scheduled, or sent anywhere, and no page is modified.',
  'Every specific fact in the draft must be verified by a human before publication; the generator was given only the facts the caller supplied and was instructed to mark anything else for verification.',
  'No search volume, traffic, ranking, or customer-percentage figure is produced or estimated anywhere in this result.',
  'Competitor research informed only WHERE the information gap is; no competitor wording was supplied to the generator or reproduced in the draft.',
];

function buildResult(opportunity, brief, params) {
  const result = createEmptyContentGenerationResult(
    typeof params.opportunityId === 'string' && params.opportunityId.trim()
      ? params.opportunityId.trim()
      : opportunity.normalized_question || opportunity.question
  );
  result.brief = brief;
  result.content_type = brief.content_type;
  result.target_question = brief.target_question;
  result.target_page = brief.target_page;
  result.evidence = brief.evidence;
  result.limitations = [...BASE_LIMITATIONS];
  return result;
}

function finalize(result, status, reviewReasons) {
  result.status = status;
  result.review_reasons = reviewReasons;
  const validation = validateContentGenerationResultShape(result);
  if (!validation.valid) {
    throw new Error(`seo_content_generation produced an invalid result: ${validation.errors.join('; ')}`);
  }
  return result;
}

async function runSeoContentGenerationTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object' || Array.isArray(researchParams)) {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured input was supplied - seo_content_generation requires an `opportunity` (an information-gap opportunity record from the Information Gap Finder) that a free-text objective cannot provide.',
    };
  }

  const { opportunity } = researchParams;

  // The gate runs before anything else, so an opportunity that must not become content
  // never reaches the model and never costs a token.
  const gate = gateOpportunity(opportunity);
  if (gate.status === 'blocked') {
    // A blocked opportunity may carry no question at all, so there is not always enough
    // to compose a brief from - report the refusal honestly rather than half-building one.
    if (!opportunity || typeof opportunity !== 'object' || typeof opportunity.question !== 'string' || !opportunity.question.trim()) {
      return { status: 'failed', result: null, error: gate.reasons[0] };
    }
    let blockedResult;
    try {
      blockedResult = buildResult(opportunity, buildBrief(opportunity, gate, researchParams), researchParams);
    } catch (err) {
      return { status: 'failed', result: null, error: err.message };
    }
    blockedResult.limitations.unshift('No content was generated and no model call was made, because this opportunity is blocked.');
    return { status: 'blocked', result: finalize(blockedResult, 'blocked', gate.reasons), error: null };
  }

  let brief;
  let result;
  try {
    brief = buildBrief(opportunity, gate, researchParams);
    result = buildResult(opportunity, brief, researchParams);
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }

  // An opportunity the Gap Finder itself left unresolved gets a brief a human can act
  // on, but no generated content - writing an article on an unvalidated question is
  // exactly the fabrication this stage exists to prevent, and it would spend real tokens
  // doing it.
  if (gate.status === 'review') {
    result.limitations.unshift('No content was generated and no model call was made, because this opportunity needs human review first.');
    return { status: 'partial', result: finalize(result, 'review', gate.reasons), error: null };
  }

  const instruction = buildGenerationInstruction(brief, researchParams);

  let completion;
  try {
    completion = await runReasoningCompletion({
      instruction,
      maxTokens: MAX_TOKENS,
      tokensUsedThisRun: Number(researchParams.tokensUsedThisRun) || 0,
      businessId: researchParams.businessId || null,
    });
  } catch (err) {
    // A refused token budget, an unconfigured provider, or an API failure - all
    // surfaced honestly, never replaced with a fabricated draft.
    return { status: 'failed', result: null, error: err.message };
  }

  const usage = {
    model: completion.model,
    stopReason: completion.stopReason,
    tokensUsed: completion.tokensUsed,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
  };

  // Deterministic scrutiny of what actually came back. The model was instructed not to
  // invent facts and was never shown competitor text, but an instruction is not a
  // guarantee - this is what makes the difference between 'ready' and 'review'.
  const checks = checkGeneratedContent(completion.text, {
    supportedFacts: researchParams.supportedFacts,
    competitorTexts: researchParams.competitorTexts,
    targetQuestion: brief.target_question,
  });

  result.generated_content = typeof completion.text === 'string' ? completion.text.trim() : '';

  if (checks.reasons.length > 0) {
    result.brief = { ...brief, status: 'review' };
    result.limitations.unshift(
      'The draft was generated but did not pass every honesty check - see review_reasons. It must be corrected or verified by a human before it goes any further.'
    );
    return { status: 'partial', result: finalize(result, 'review', checks.reasons), error: null, ...usage };
  }

  return { status: 'success', result: finalize(result, 'ready', []), error: null, ...usage };
}

module.exports = { runSeoContentGenerationTool };

if (require.main === module) {
  const { findInformationGaps } = require('../agent/core/informationGapEngine');

  console.log('Smart E-Commerce Growth AI Agent - seo_content_generation tool:\n');

  const { records } = findInformationGaps({
    questions: [
      {
        question: 'How should I store an insulated jacket over the summer?',
        questionType: 'troubleshooting',
        evidenceSources: [{ signalKind: 'community_forum', reference: '(placeholder forum reference)' }],
        competitorObservations: [
          { competitor: '(Example Co. A)', covered: false },
          { competitor: '(Example Co. B)', covered: false },
        ],
        productContext: '(Example insulated jacket)',
      },
      { question: 'An entirely unevidenced question?' },
    ],
  });

  (async () => {
    for (const opportunity of records) {
      const outcome = await runSeoContentGenerationTool({ opportunity });
      console.log(`--- "${opportunity.question}" -> status: ${outcome.status}`);
      if (outcome.error) console.log(`    error: ${outcome.error}`);
      if (outcome.result) {
        console.log(`    result status: ${outcome.result.status}`);
        for (const reason of outcome.result.review_reasons) console.log(`    reason: ${reason}`);
      }
      console.log('');
    }
    console.log('No question, competitor, or fact above is real - every value is a placeholder for demonstration.');
  })();
}
