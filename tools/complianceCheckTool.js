'use strict';

// The compliance_check tool (tools/toolRegistry.js): the shared-core Compliance stage,
// exposed so it is reachable ONLY through the gated dispatch surface every other tool
// goes through - agent/core/orchestratorExecutionContract.js's TOOL_EXECUTORS, behind
// agent/core/toolPermissions.js's checkToolAccess(), inside the run's usage limits, and
// recorded by audit/auditTrail.js. There is no direct HTTP call, no new client, and no
// second orchestration layer here.
//
// THIS TOOL APPROVES NOTHING AND PUBLISHES NOTHING. It has no integration import, no
// destination field, and it never touches approvals/. Its output is a verdict that a
// human approver reads next; approvals/approvalWorkflow.js remains the only place a
// decision is ever recorded, and a BLOCK carries no override because this project's
// approval architecture has no authorized-override mechanism to invoke.
//
// DETERMINISTIC BY DEFAULT, AND FREE. compliance/complianceEngine.js does all the real
// work offline: schema validation, required-evidence presence, verification markers,
// unsupported-claim detection, distinctive-phrase similarity against supplied reference
// material, IP indicators, structured platform rules, and explicit prohibited content.
// No model is called unless a caller explicitly opts in, so an ordinary compliance check
// costs zero tokens.
//
// THE OPTIONAL AI-ASSISTED PASS (aiAssistedAmbiguityCheck: true) exists for the one
// thing deterministic rules genuinely cannot do: notice a claim that reads as
// established fact but is not traceable to the supplied evidence, in wording no pattern
// anticipates. It is bounded hard:
//   - it goes through tools/aiReasoningCompletion.js, so AI_PROVIDER selection
//     (agent/core/aiProviderSelector.js), agent/core/tokenControls.js's per-call ceiling
//     and per-run budget, and the input/output token split all apply unchanged. Neither
//     provider is named anywhere in this file.
//   - it is never shown reference/competitor material, credentials, or a business
//     config - only the content itself (bounded), the caller's established facts, and
//     the declared third-party brand names.
//   - its findings are merged through complianceEngine.js's applyAdditionalFindings(),
//     which appends only and re-derives the verdict through the single
//     deriveComplianceStatus() rule. It can therefore escalate PASS -> REVIEW and can
//     NEVER clear, downgrade, or resolve a finding. It is refused the 'block' severity
//     outright: a BLOCK must come from a deterministic rule, never from a judgment call.
//   - if the caller asked for it and it fails, the result escalates to REVIEW saying so
//     - a check that did not run is never reported as one that passed.
//
// aiReasoningCompletion is required as a module object and called via property access
// so a test can substitute it without a mocking framework - this project's existing
// convention (see tools/aiReasoningCompletion.js's own header).
//
// Returns { status, result, error, model, stopReason, tokensUsed, inputTokens,
// outputTokens } - never throws. Usage fields are present only when a model call was
// actually made (the default deterministic path makes none, and spends nothing).
//   status 'failed'  - no/invalid input; there was nothing to check
//   status 'blocked' - BLOCK: an explicit project or configured policy rule was violated
//   status 'partial' - REVIEW: a human/legal/policy judgment is required
//   status 'success' - PASS: no issue was detected by the checks that actually ran

const aiReasoningCompletion = require('./aiReasoningCompletion');
const {
  evaluateCompliance,
  applyAdditionalFindings,
} = require('../compliance/complianceEngine');
const { createComplianceFinding, COMPLIANCE_INPUT_FIELDS } = require('../compliance/complianceModel');

// A conservative per-call ceiling for one structured findings reply.
// agent/core/tokenControls.js caps this against both the per-call ceiling and the run's
// remaining budget, so this is a request, never an entitlement.
const MAX_TOKENS = 1024;

// How much content the optional AI pass may ever see. A compliance check must not become
// a way to ship an unbounded document to a model.
const MAX_AI_CONTENT_CHARACTERS = 4000;

// The compliance input contract fields (compliance/complianceModel.js's
// COMPLIANCE_INPUT_FIELDS). The tool's own control fields - aiAssistedAmbiguityCheck,
// tokensUsedThisRun, businessId - are execution concerns, NOT part of the compliance
// contract, so they are projected out here rather than widening that contract to
// accommodate them. Doing it this way also means a caller cannot smuggle an unrecognized
// field through this tool into the engine.
const COMPLIANCE_INPUT_KEYS = COMPLIANCE_INPUT_FIELDS.map((field) => field.id);

function toComplianceInput(researchParams) {
  const input = {};
  for (const key of COMPLIANCE_INPUT_KEYS) {
    if (researchParams[key] !== undefined) input[key] = researchParams[key];
  }
  return input;
}

const TOOL_STATUS_BY_VERDICT = {
  PASS: 'success',
  REVIEW: 'partial',
  BLOCK: 'blocked',
};

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// The prompt for the optional pass. Built ONLY from the content, the caller's own
// established facts, and declared third-party brand names - reference/competitor
// material is deliberately absent, so the model cannot reproduce wording it was never
// shown, and cannot be used as a laundering route for it.
function buildAmbiguityInstruction(researchParams) {
  const content = String(researchParams.content);
  const truncated = content.length > MAX_AI_CONTENT_CHARACTERS;
  const provenance =
    researchParams.provenance && typeof researchParams.provenance === 'object' ? researchParams.provenance : {};
  const supportedFacts = normalizeArray(provenance.supported_facts).filter(isNonEmptyString);
  const businessContext =
    researchParams.business_context && typeof researchParams.business_context === 'object'
      ? researchParams.business_context
      : {};
  const thirdPartyBrands = normalizeArray(businessContext.third_party_brands).filter(isNonEmptyString);

  const lines = [
    'You are reviewing a piece of our own draft marketing/website content for claims that are not supported by the evidence we hold. You are NOT a lawyer and must not make any legal determination.',
    '',
    'CONTENT:',
    truncated ? `${content.slice(0, MAX_AI_CONTENT_CHARACTERS)}\n[content truncated for this check]` : content,
    '',
    supportedFacts.length > 0
      ? 'These are the ONLY facts we have established. Anything stated as fact beyond them is unsupported:'
      : 'We have established NO specific facts for this content. Any specific figure, duration, measurement, material, price, or performance claim in it is therefore unsupported.',
    ...supportedFacts.map((fact) => `- ${fact}`),
  ];

  if (thirdPartyBrands.length > 0) {
    lines.push('', 'These third-party brands may appear; note any wording that implies an affiliation or endorsement we have not stated:', ...thirdPartyBrands.map((brand) => `- ${brand}`));
  }

  lines.push(
    '',
    'Report ONLY genuinely ambiguous or unsupported claims that a deterministic keyword check would miss. Do not repeat obvious pattern matches, and do not report ordinary marketing language as a problem.',
    '',
    'Rules:',
    '- Never state or imply that anything is legal, compliant, copyright-safe, or trademark-safe. You cannot determine that.',
    '- Never clear, dismiss, or resolve a concern - you can only raise one.',
    '- If you are unsure whether something is supported, report it. Uncertainty is a reason to flag, never a reason to stay silent.',
    '- If you find nothing, return an empty findings array.',
    '',
    'Reply with JSON ONLY, no markdown fences and no commentary, in exactly this shape:',
    '{"findings":[{"reason":"one sentence stating what is unsupported or ambiguous","recommended_action":"what a human should do about it"}]}'
  );

  return lines.join('\n');
}

// Parses the model reply into findings this engine will accept. Strict by design: an
// unparseable or wrongly-shaped reply is an error, never a silently empty result that
// would read as "the AI found nothing".
function parseAmbiguityFindings(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('The AI-assisted ambiguity check returned no reply.');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('The AI-assisted ambiguity check did not return structured JSON.');
  }

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`The AI-assisted ambiguity check returned malformed JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new Error('The AI-assisted ambiguity check returned no `findings` array.');
  }

  return parsed.findings
    .filter((finding) => finding && typeof finding === 'object' && isNonEmptyString(finding.reason))
    .map((finding) =>
      createComplianceFinding({
        checkType: 'unsupported_claims',
        ruleId: 'ai_assisted_ambiguity_review',
        // Never 'block'. applyAdditionalFindings() refuses that severity outright; this
        // is the matching guarantee at the point findings are constructed, so a model
        // reply can never even propose one.
        severity: 'review',
        reason: `AI-assisted ambiguity check: ${String(finding.reason).trim()}`,
        recommendedAction: isNonEmptyString(finding.recommended_action)
          ? String(finding.recommended_action).trim()
          : 'A human must confirm whether this claim is supported before the content proceeds.',
      })
    );
}

async function runComplianceCheckTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object' || Array.isArray(researchParams)) {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured input was supplied - compliance_check requires a `content` string (plus any provenance, reference material, and policy context) that a free-text objective cannot provide.',
    };
  }

  // The deterministic evaluation is the whole check by default: offline, free, and the
  // only thing that can ever produce a BLOCK.
  let result;
  try {
    result = evaluateCompliance(toComplianceInput(researchParams));
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }

  if (researchParams.aiAssistedAmbiguityCheck !== true) {
    return { status: TOOL_STATUS_BY_VERDICT[result.status], result, error: null };
  }

  let completion;
  try {
    completion = await aiReasoningCompletion.runReasoningCompletion({
      instruction: buildAmbiguityInstruction(researchParams),
      maxTokens: MAX_TOKENS,
      tokensUsedThisRun: Number(researchParams.tokensUsedThisRun) || 0,
      businessId: researchParams.businessId || null,
    });
  } catch (err) {
    // A refused token budget, an unconfigured provider, or an API failure. The caller
    // asked for this check, so a result that quietly omits it would misrepresent what
    // was actually examined - it escalates instead.
    const escalated = applyAdditionalFindings(
      result,
      [
        createComplianceFinding({
          checkType: 'unsupported_claims',
          ruleId: 'ai_assisted_check_did_not_complete',
          severity: 'review',
          reason: `An AI-assisted ambiguity check was requested for this content but did not complete (${err.message}), so ambiguous or unsupported claims beyond the deterministic checks were not examined.`,
          recommendedAction: 'Re-run the check, or have a human read the content for unsupported claims before it proceeds.',
        }),
      ],
      ['The requested AI-assisted ambiguity check did not run, so this result reflects the deterministic checks only.']
    );
    return { status: TOOL_STATUS_BY_VERDICT[escalated.status], result: escalated, error: null };
  }

  const usage = {
    model: completion.model,
    stopReason: completion.stopReason,
    tokensUsed: completion.tokensUsed,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
  };

  let additionalFindings;
  try {
    additionalFindings = parseAmbiguityFindings(completion.text);
  } catch (err) {
    const escalated = applyAdditionalFindings(
      result,
      [
        createComplianceFinding({
          checkType: 'unsupported_claims',
          ruleId: 'ai_assisted_check_did_not_complete',
          severity: 'review',
          reason: `An AI-assisted ambiguity check was requested for this content but its reply could not be used (${err.message}), so its findings are unknown rather than absent.`,
          recommendedAction: 'Re-run the check, or have a human read the content for unsupported claims before it proceeds.',
        }),
      ],
      ['The requested AI-assisted ambiguity check produced an unusable reply, so this result reflects the deterministic checks only.']
    );
    return { status: TOOL_STATUS_BY_VERDICT[escalated.status], result: escalated, error: null, ...usage };
  }

  const merged = applyAdditionalFindings(result, additionalFindings, [
    'An AI-assisted ambiguity check also ran. It can only ADD review findings - it cannot clear, downgrade, or resolve any deterministic finding, and it cannot produce a BLOCK.',
  ]);

  return { status: TOOL_STATUS_BY_VERDICT[merged.status], result: merged, error: null, ...usage };
}

module.exports = { runComplianceCheckTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - compliance_check tool (deterministic path, no model call):\n');

  const examples = [
    {
      label: 'Evidenced content',
      params: {
        content:
          'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it. With careful storage and gentle washing it stays warm and usable for a long time.',
        content_type: 'buying guide',
        content_reference: '(placeholder) how-long-does-an-insulated-jacket-last',
        provenance: { source: 'seo_content_generation', evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }] },
      },
    },
    {
      label: 'A declared third-party brand and an affiliation claim',
      params: {
        content: 'We are an official reseller of (Placeholder Brand) insulated jackets.',
        provenance: { source: 'seo_content_generation', evidence: [{ signal_kind: 'community_forum', reference: '(placeholder)' }] },
        business_context: { brand_names: ['(Our Placeholder Store)'], third_party_brands: ['(Placeholder Brand)'] },
      },
    },
    {
      label: 'A configured prohibited term',
      params: {
        content: 'Every design here is a placeholder-forbidden-phrase, so buy with confidence.',
        provenance: { source: 'seo_content_generation', evidence: [{ signal_kind: 'community_forum', reference: '(placeholder)' }] },
        policy_context: { prohibited_terms: ['placeholder-forbidden-phrase'] },
      },
    },
  ];

  (async () => {
    for (const example of examples) {
      const outcome = await runComplianceCheckTool(example.params);
      console.log(`--- ${example.label} -> tool status: ${outcome.status}`);
      if (outcome.error) console.log(`    error: ${outcome.error}`);
      if (outcome.result) {
        console.log(`    compliance verdict: ${outcome.result.status}`);
        for (const reason of outcome.result.review_reasons) console.log(`    reason: ${reason}`);
      }
      console.log(`    tokens used: ${outcome.tokensUsed === undefined ? 'none - no model call was made' : outcome.tokensUsed}`);
      console.log('');
    }
    console.log('Nothing above was approved or published - Compliance does neither.');
    console.log('Every brand, phrase and reference above is an invented placeholder.');
  })();
}
