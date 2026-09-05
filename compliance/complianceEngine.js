'use strict';

// The Compliance engine: the shared-core, deterministic pre-action check that runs
// AFTER content is generated and BEFORE it is ever put in front of a human approver.
//
//   Discovery -> Gap Analysis -> Content Generation -> **Compliance** -> Human
//   Approval -> (a publishing stage that does not exist in this project)
//
// COMPLIANCE IS NOT APPROVAL, AND THIS FILE CANNOT APPROVE ANYTHING. It answers one
// question - "is this content sufficiently safe and compliant to proceed TO human
// approval?" - and returns a verdict. Whether an authorized human approved it is
// approvals/approvalWorkflow.js's question; nothing here creates, decides, or reads an
// approval request, and there is no override, force flag, or caller argument that can
// turn a BLOCK into a PASS. isEligibleForHumanApproval() below reports that a BLOCK is
// not eligible - it does not offer a way past it, because the existing architecture has
// no authorized-override mechanism and inventing one is not this task's scope
// (CLAUDE.md rule 1).
//
// NOTHING HERE PUBLISHES OR CALLS ANYTHING. No integration import, no HTTP call, no
// model call, no persistence. Every function below is pure over its arguments, exactly
// like agent/core/contentBriefEngine.js and approvals/approvalWorkflow.js. The one
// optional AI-assisted pass lives in tools/complianceCheckTool.js, so this engine stays
// entirely offline, free and testable.
//
// DETERMINISTIC FIRST, AND REUSED RATHER THAN REBUILT. Three detectors already exist in
// agent/core/contentBriefEngine.js and are imported here rather than reimplemented
// (CLAUDE.md rules 3-4): findVerificationMarkers, findUnsupportedFactualClaims and
// findCopiedCompetitorPhrase. The content generator applies them to its OWN draft as a
// post-check; Compliance applies them as an independent gate over any content from any
// producer, with the reference-material and policy dimensions the generator has no
// concept of. That is a different responsibility over the same primitives, not a second
// copy of them.
//
// COMPETITOR/REFERENCE TEXT NEVER LEAVES THIS FUNCTION. Reference material is read here
// and nowhere else: findings carry a fingerprint, a reference id and character offsets
// into OUR content - never a phrase, an excerpt, or a competitor's wording. Nothing in
// this file sends reference text to a model, and the content generator upstream is not
// changed: it still never sees competitor text at all.
//
// NO LEGAL CLAIM IS EVER MADE. A detected brand is reported as detected, never as
// infringing. An unestablished permission is REVIEW, never PASS. Every result carries
// compliancePolicy.js's LEGAL_LIMITATIONS unconditionally.

const {
  COPIED_PHRASE_WORD_RUN,
  findVerificationMarkers,
  findUnsupportedFactualClaims,
  findCopiedCompetitorPhrase,
} = require('../agent/core/contentBriefEngine');
const {
  CHECK_TYPES,
  DEFAULT_REQUIRED_CHECKS,
  PROHIBITED_ASSERTION_RULES,
  AFFILIATION_CLAIM_RULES,
  RECOGNIZED_PLATFORMS,
  PLATFORM_RULE_SEVERITIES,
  LEGAL_LIMITATIONS,
  COMPLIANCE_CHECKER_VERSION,
  COMPLIANCE_SCHEMA_VERSION,
  fingerprintPhrase,
  getPlatformRulesFor,
} = require('./compliancePolicy');
const {
  createEmptyComplianceResult,
  createComplianceFinding,
  createComplianceCheck,
  deriveComplianceStatus,
  deriveReviewReasons,
  validateComplianceInputShape,
  validateComplianceResultShape,
} = require('./complianceModel');

// A finding's reason may quote OUR OWN content so a human can find the passage. It is
// bounded so a finding can never become an unbounded dump, matching the same discipline
// audit/auditTrail.js applies to its own detail payloads.
const MAX_QUOTED_REASON_LENGTH = 240;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function bound(text) {
  const value = String(text);
  return value.length <= MAX_QUOTED_REASON_LENGTH ? value : `${value.slice(0, MAX_QUOTED_REASON_LENGTH)}…[TRUNCATED]`;
}

// Caller/config-supplied policy strings are matched as LITERAL substrings, never
// compiled as patterns - a prohibited term or forbidden phrase coming from
// configuration must never be able to inject a regular expression into this process.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findLiteralTerm(content, term) {
  if (!isNonEmptyString(term)) return null;
  const pattern = new RegExp(escapeRegExp(term.trim()), 'i');
  const match = pattern.exec(content);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

// Whole-word match, so a brand name is not "detected" inside an unrelated longer word.
function findBrandMention(content, brand) {
  if (!isNonEmptyString(brand)) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(brand.trim())}(?![\\p{L}\\p{N}])`, 'iu');
  const match = pattern.exec(content);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

// Where a reproduced word-run sits in OUR content, as character offsets. The run itself
// is normalized lower-case words, so the pattern is built only from alphanumerics -
// there is nothing to escape and nothing of the reference text survives into the result.
function locateWordRun(content, run) {
  const words = String(run).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  const pattern = new RegExp(words.map(escapeRegExp).join('[^a-z0-9]+'), 'i');
  const match = pattern.exec(content);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

// ---------------------------------------------------------------------------------
// Input normalization - absent stays absent, never guessed.
// ---------------------------------------------------------------------------------

function normalizeInput(rawInput) {
  const validation = validateComplianceInputShape(rawInput);
  if (!validation.valid) {
    throw new Error(`evaluateCompliance received an invalid input: ${validation.errors.join('; ')}`);
  }

  const provenance = isPlainObject(rawInput.provenance) ? rawInput.provenance : {};
  const platformContext = isPlainObject(rawInput.platform_context) ? rawInput.platform_context : {};
  const businessContext = isPlainObject(rawInput.business_context) ? rawInput.business_context : {};
  const policyContext = isPlainObject(rawInput.policy_context) ? rawInput.policy_context : {};

  const referenceMaterials = normalizeArray(rawInput.reference_materials)
    .filter(isPlainObject)
    .map((material, index) => ({
      id: isNonEmptyString(material.id) ? material.id.trim() : `reference_material_${index + 1}`,
      text: typeof material.text === 'string' ? material.text : '',
      rights_status: isNonEmptyString(material.rights_status) ? material.rights_status.trim() : 'unknown',
    }));

  return {
    content: String(rawInput.content),
    content_type: isNonEmptyString(rawInput.content_type) ? rawInput.content_type.trim() : '',
    content_reference: isNonEmptyString(rawInput.content_reference) ? rawInput.content_reference.trim() : '',
    provenance: {
      source: isNonEmptyString(provenance.source) ? provenance.source.trim() : '',
      generator: isNonEmptyString(provenance.generator) ? provenance.generator.trim() : '',
      evidence: normalizeArray(provenance.evidence),
      supported_facts: normalizeArray(provenance.supported_facts).filter(isNonEmptyString),
    },
    reference_materials: referenceMaterials,
    platform: isNonEmptyString(platformContext.platform) ? platformContext.platform.trim().toLowerCase() : '',
    surface: isNonEmptyString(platformContext.surface) ? platformContext.surface.trim() : '',
    business_id: isNonEmptyString(businessContext.business_id) ? businessContext.business_id.trim() : '',
    brand_names: normalizeArray(businessContext.brand_names).filter(isNonEmptyString),
    third_party_brands: normalizeArray(businessContext.third_party_brands).filter(isNonEmptyString),
    prohibited_terms: normalizeArray(policyContext.prohibited_terms).filter(isNonEmptyString),
    platform_rules: normalizeArray(policyContext.platform_rules).filter(isPlainObject),
    // An explicit `required_checks` from the caller always wins - including over their
    // own provenance waiver, because demanding a check and waiving it is a contradiction
    // that must surface as a REVIEW rather than be silently resolved either way. Only
    // the DEFAULT list yields to the waiver, so require_provenance:false does not then
    // report the very gap it just waived.
    required_checks: Array.isArray(rawInput.required_checks)
      ? [...rawInput.required_checks]
      : DEFAULT_REQUIRED_CHECKS.filter((checkType) => checkType !== 'provenance' || rawInput.require_provenance !== false),
    require_provenance: rawInput.require_provenance !== false,
  };
}

// ---------------------------------------------------------------------------------
// Check 1: provenance. Missing provenance is a reportable outcome, never a silent PASS.
// ---------------------------------------------------------------------------------

function checkProvenance(input, findings, limitations) {
  if (!input.require_provenance) {
    limitations.push(
      'The caller declared provenance was not required for this content, so its origin and supporting evidence were NOT established by this check.'
    );
    return createComplianceCheck('provenance', 'not_applicable', 'Provenance was not required by the caller, so it was not evaluated.');
  }

  const before = findings.length;
  if (!isNonEmptyString(input.provenance.source)) {
    findings.push(
      createComplianceFinding({
        checkType: 'provenance',
        ruleId: 'provenance_source_missing',
        severity: 'review',
        reason:
          'No provenance source was supplied, so where this content came from could not be established. Provenance is required for this check, and a missing one is not treated as acceptable.',
        recommendedAction: 'Supply the producing stage/source of this content, or have a human confirm its origin before it proceeds.',
      })
    );
  }
  if (input.provenance.evidence.length === 0) {
    findings.push(
      createComplianceFinding({
        checkType: 'provenance',
        ruleId: 'provenance_evidence_missing',
        severity: 'review',
        reason:
          'No supporting evidence was carried with this content, so nothing establishes that the material it is based on was ever observed.',
        recommendedAction: 'Carry the upstream evidence references through with the content, or have a human verify the basis for it.',
      })
    );
  }

  return findings.length > before
    ? createComplianceCheck('provenance', 'flagged', 'Provenance was required but is incomplete.')
    : createComplianceCheck('provenance', 'passed', 'A provenance source and supporting evidence references were both supplied.');
}

// ---------------------------------------------------------------------------------
// Check 2: unsupported factual claims.
// ---------------------------------------------------------------------------------

function checkUnsupportedClaims(input, findings) {
  const before = findings.length;

  for (const marker of findVerificationMarkers(input.content)) {
    findings.push(
      createComplianceFinding({
        checkType: 'unsupported_claims',
        ruleId: 'explicit_verification_marker',
        severity: 'review',
        reason: `The content carries an unresolved verification marker: ${bound(marker)}. A fact the producer did not have is still outstanding.`,
        detectedRange: findLiteralTerm(input.content, marker),
        recommendedAction: 'Supply the missing fact and replace the marker, or remove the sentence. It must not go to a human approver unresolved.',
      })
    );
  }

  for (const claim of findUnsupportedFactualClaims(input.content, input.provenance.supported_facts)) {
    findings.push(
      createComplianceFinding({
        checkType: 'unsupported_claims',
        ruleId: 'claim_not_supported_by_evidence',
        severity: 'review',
        reason: bound(claim),
        recommendedAction:
          'Establish the figure as a supplied fact, or remove it. This checker cannot verify a claim and deliberately does not try.',
      })
    );
  }

  if (findings.length > before) {
    return createComplianceCheck('unsupported_claims', 'flagged', 'Claims were found that the supplied evidence does not support.');
  }
  return createComplianceCheck(
    'unsupported_claims',
    'passed',
    input.provenance.supported_facts.length > 0
      ? 'No claim was found beyond the facts the caller established.'
      : 'No unsupported specific claim, figure, or verification marker was detected. No supported facts were supplied, so only claims detectable from the content itself were checked.'
  );
}

// ---------------------------------------------------------------------------------
// Check 3: reference/competitor similarity. Detects copying without carrying a copy.
// ---------------------------------------------------------------------------------

function checkReferenceSimilarity(input, findings, limitations) {
  const usable = input.reference_materials.filter((material) => isNonEmptyString(material.text));

  if (usable.length === 0) {
    if (input.required_checks.includes('reference_similarity')) {
      findings.push(
        createComplianceFinding({
          checkType: 'reference_similarity',
          ruleId: 'required_check_could_not_run',
          severity: 'review',
          reason:
            'A reference-similarity check was required for this content, but no reference material was supplied, so copying could not be checked for at all.',
          recommendedAction: 'Supply the reference/competitor material this content should be compared against, or have a human confirm none applies.',
        })
      );
      return createComplianceCheck('reference_similarity', 'not_completed', 'Required, but no reference material was supplied.');
    }
    limitations.push(
      'No reference/competitor material was supplied, so no copying check was performed against any external source.'
    );
    return createComplianceCheck('reference_similarity', 'not_applicable', 'No reference material was supplied to compare against.');
  }

  const before = findings.length;
  for (const material of usable) {
    // Reused from agent/core/contentBriefEngine.js rather than reimplemented. The
    // returned run is used ONLY to locate and fingerprint the passage - it is never
    // placed in a finding, so no reference wording can escape through this result.
    const run = findCopiedCompetitorPhrase(input.content, [material.text]);
    if (!run) continue;
    findings.push(
      createComplianceFinding({
        checkType: 'reference_similarity',
        ruleId: 'distinctive_wording_matches_reference_material',
        severity: 'review',
        reason: `A run of ${COPIED_PHRASE_WORD_RUN} consecutive words in this content matches supplied reference material '${material.id}' (rights status: ${material.rights_status}). The matching wording is identified by fingerprint ${fingerprintPhrase(run)} and by its position in our own content; the reference wording itself is deliberately not reproduced here.`,
        evidenceReference: material.id,
        detectedRange: locateWordRun(input.content, run),
        recommendedAction:
          'Rewrite the identified passage in our own words, or have a human establish that this wording may be used. Whether the match is permissible is not something this checker can determine.',
      })
    );
  }

  return findings.length > before
    ? createComplianceCheck('reference_similarity', 'flagged', `Distinctive wording matching supplied reference material was detected in ${findings.length - before} case(s).`)
    : createComplianceCheck('reference_similarity', 'passed', `No run of ${COPIED_PHRASE_WORD_RUN} or more consecutive words matched any of the ${usable.length} supplied reference material(s).`);
}

// ---------------------------------------------------------------------------------
// Check 4: intellectual-property indicators. Indicators only - never a legal verdict.
// ---------------------------------------------------------------------------------

function checkIpIndicators(input, findings) {
  const before = findings.length;

  for (const rule of AFFILIATION_CLAIM_RULES) {
    const match = rule.pattern.exec(input.content);
    if (!match) continue;
    findings.push(
      createComplianceFinding({
        checkType: 'ip_indicators',
        ruleId: rule.id,
        severity: 'review',
        reason: `${rule.description} Detected wording: "${bound(match[0])}". Whether that relationship exists and may be stated is a legal/business determination this checker cannot make.`,
        detectedRange: { start: match.index, end: match.index + match[0].length },
        recommendedAction: rule.recommended_action,
      })
    );
  }

  const ownBrands = new Set(input.brand_names.map((brand) => brand.trim().toLowerCase()));
  for (const brand of input.third_party_brands) {
    if (ownBrands.has(brand.trim().toLowerCase())) continue;
    const range = findBrandMention(input.content, brand);
    if (!range) continue;
    findings.push(
      createComplianceFinding({
        checkType: 'ip_indicators',
        ruleId: 'third_party_brand_referenced',
        severity: 'review',
        reason: `The content references '${bound(brand)}', which the caller declared as a third-party brand. This is a detection only: whether this use is permitted, nominative, or misleading requires human/legal judgment that this checker cannot supply.`,
        detectedRange: range,
        recommendedAction: 'Have a human confirm the reference is accurate, permitted, and not implying an affiliation that does not exist.',
      })
    );
  }

  const thirdPartyMaterials = input.reference_materials.filter((material) => material.rights_status !== 'owned');
  if (thirdPartyMaterials.length > 0) {
    findings.push(
      createComplianceFinding({
        checkType: 'ip_indicators',
        ruleId: 'third_party_reference_material_supplied',
        severity: 'info',
        reason: `${thirdPartyMaterials.length} supplied reference material(s) are not declared as owned by this business (ids: ${thirdPartyMaterials.map((material) => material.id).join(', ')}); they were used only to check this content for copying.`,
        recommendedAction: 'No action required unless the reference-similarity check also produced a finding.',
      })
    );
  }

  const produced = findings.length - before;
  if (produced === 0) {
    return createComplianceCheck('ip_indicators', 'passed', 'No affiliation/endorsement wording and no declared third-party brand were detected in the content.');
  }
  return createComplianceCheck('ip_indicators', 'flagged', `${produced} intellectual-property indicator(s) were detected. None is an assertion about legal ownership or infringement.`);
}

// ---------------------------------------------------------------------------------
// Check 5: platform/policy. A boundary that applies rules; it never invents one.
// ---------------------------------------------------------------------------------

function checkPlatformPolicy(input, findings, limitations) {
  if (!isNonEmptyString(input.platform)) {
    if (input.required_checks.includes('platform_policy')) {
      findings.push(
        createComplianceFinding({
          checkType: 'platform_policy',
          ruleId: 'required_check_could_not_run',
          severity: 'review',
          reason:
            'A platform-policy check was required for this content, but no platform context was supplied, so no policy could be applied.',
          recommendedAction: 'Supply the platform this content is intended for, or have a human confirm which policy applies.',
        })
      );
      return createComplianceCheck('platform_policy', 'not_completed', 'Required, but no platform context was supplied.');
    }
    limitations.push('No platform context was supplied, so no platform or channel policy was evaluated.');
    return createComplianceCheck('platform_policy', 'not_applicable', 'No platform context was supplied.');
  }

  const rules = getPlatformRulesFor(input.platform_rules, input.platform);
  if (rules.length === 0) {
    const recognized = RECOGNIZED_PLATFORMS.includes(input.platform);
    findings.push(
      createComplianceFinding({
        checkType: 'platform_policy',
        ruleId: 'platform_policy_undetermined',
        severity: 'review',
        reason: `No structured policy rule was available to this checker for platform '${input.platform}'${recognized ? '' : " (which this project does not recognize as a configured context)"}, so its policy requirements could not be determined. This project asserts no platform's policy, and none was invented here.`,
        recommendedAction: `Supply the structured rules for '${input.platform}' in policy_context.platform_rules, or have a human review the content against that platform's own published policy.`,
      })
    );
    return createComplianceCheck('platform_policy', 'flagged', `Platform '${input.platform}' was named but no structured rule set was available for it.`);
  }

  const before = findings.length;
  for (const rule of rules) {
    const severity = PLATFORM_RULE_SEVERITIES.includes(rule.severity) ? rule.severity : 'review';
    for (const phrase of normalizeArray(rule.forbidden_phrases).filter(isNonEmptyString)) {
      const range = findLiteralTerm(input.content, phrase);
      if (!range) continue;
      findings.push(
        createComplianceFinding({
          checkType: 'platform_policy',
          ruleId: isNonEmptyString(rule.id) ? rule.id : `platform_rule_${input.platform}`,
          severity,
          reason: `The content matches a caller-supplied ${input.platform} policy rule${isNonEmptyString(rule.description) ? `: ${bound(rule.description)}` : '.'}${severity === 'block' ? ' It is blocked by that explicit rule.' : ' It requires review under that rule.'}`,
          detectedRange: range,
          recommendedAction:
            severity === 'block'
              ? 'Remove or rewrite the matching wording - an explicit configured policy rule forbids it.'
              : 'Have a human decide whether this wording is acceptable under that platform rule.',
        })
      );
      break;
    }
  }

  return findings.length > before
    ? createComplianceCheck('platform_policy', 'flagged', `${rules.length} structured rule(s) for '${input.platform}' were applied and produced findings.`)
    : createComplianceCheck('platform_policy', 'passed', `${rules.length} structured rule(s) for '${input.platform}' were applied and none matched. Only the supplied rules were checked - no other policy requirement was evaluated.`);
}

// ---------------------------------------------------------------------------------
// Check 6: prohibited content. The only check that can BLOCK, and only on an explicit
// rule - the project's own, or one the caller/configuration declared.
// ---------------------------------------------------------------------------------

function checkProhibitedContent(input, findings) {
  const before = findings.length;

  for (const rule of PROHIBITED_ASSERTION_RULES) {
    const match = rule.pattern.exec(input.content);
    if (!match) continue;
    findings.push(
      createComplianceFinding({
        checkType: 'prohibited_content',
        ruleId: rule.id,
        severity: 'block',
        reason: `Blocked by project policy: ${rule.description} Detected wording: "${bound(match[0])}".`,
        detectedRange: { start: match.index, end: match.index + match[0].length },
        recommendedAction: rule.recommended_action,
      })
    );
  }

  for (const term of input.prohibited_terms) {
    const range = findLiteralTerm(input.content, term);
    if (!range) continue;
    findings.push(
      createComplianceFinding({
        checkType: 'prohibited_content',
        ruleId: 'declared_prohibited_term',
        severity: 'block',
        reason: `Blocked by project policy: the content uses "${bound(term)}", which this business's configured policy explicitly prohibits.`,
        detectedRange: range,
        recommendedAction: 'Remove the prohibited wording. This is an explicit configured rule, not a judgment about the content.',
      })
    );
  }

  return findings.length > before
    ? createComplianceCheck('prohibited_content', 'flagged', 'An explicit project or configured policy rule was violated.')
    : createComplianceCheck(
        'prohibited_content',
        'passed',
        `No explicit prohibited assertion was detected, and none of the ${input.prohibited_terms.length} configured prohibited term(s) appear.`
      );
}

// ---------------------------------------------------------------------------------
// The evaluation itself.
// ---------------------------------------------------------------------------------

// Runs every deterministic check over one piece of content and returns a validated
// compliance result. Pure and offline - no model call, no I/O, no persistence, nothing
// published, nothing approved. Throws only when the input is unusable (no content),
// which is a caller error, never a compliance outcome.
function evaluateCompliance(rawInput) {
  const input = normalizeInput(rawInput);

  const findings = [];
  const limitations = [];
  const checks = [
    checkProvenance(input, findings, limitations),
    checkUnsupportedClaims(input, findings),
    checkReferenceSimilarity(input, findings, limitations),
    checkIpIndicators(input, findings),
    checkPlatformPolicy(input, findings, limitations),
    checkProhibitedContent(input, findings),
  ];

  // Any required check that did not actually run must already have produced a REVIEW
  // finding above. This is the belt-and-braces guard: a required check reported as
  // not_applicable can never be quietly counted as a passed one.
  for (const checkType of input.required_checks) {
    const check = checks.find((entry) => entry.check_type === checkType);
    if (check && check.status === 'not_applicable') {
      findings.push(
        createComplianceFinding({
          checkType,
          ruleId: 'required_check_not_applicable',
          severity: 'review',
          reason: `The '${checkType}' check was required for this content but could not be applied (${check.detail}), so it did not produce a result.`,
          recommendedAction: 'Supply the input that check needs, or have a human decide whether it can be waived for this content.',
        })
      );
    }
  }

  const result = createEmptyComplianceResult(input.content_reference);
  result.content_type = input.content_type;
  result.checks = checks;
  result.findings = findings;
  result.status = deriveComplianceStatus(findings);
  result.review_reasons = deriveReviewReasons(findings);
  result.provenance = {
    source: input.provenance.source,
    generator: input.provenance.generator,
    evidence: input.provenance.evidence,
    supported_fact_count: input.provenance.supported_facts.length,
    reference_material_ids: input.reference_materials.map((material) => material.id),
  };
  result.policy_context = {
    platform: input.platform || null,
    surface: input.surface || null,
    business_id: input.business_id || null,
    structured_platform_rules_applied: getPlatformRulesFor(input.platform_rules, input.platform).length,
    configured_prohibited_terms: input.prohibited_terms.length,
    required_checks: input.required_checks,
  };
  result.limitations = [...LEGAL_LIMITATIONS, ...limitations];
  result.checked_at = new Date().toISOString();
  result.checker_version = COMPLIANCE_CHECKER_VERSION;
  result.schema_version = COMPLIANCE_SCHEMA_VERSION;

  const validation = validateComplianceResultShape(result);
  if (!validation.valid) {
    throw new Error(`evaluateCompliance produced an invalid compliance result: ${validation.errors.join('; ')}`);
  }
  return result;
}

// ---------------------------------------------------------------------------------
// Monotonic escalation - the only way an additional (e.g. AI-assisted) check can
// affect a result.
// ---------------------------------------------------------------------------------

// Returns a NEW result with the extra findings appended and the status/review reasons
// re-derived. Escalation only: because deriveComplianceStatus() is the single rule for
// turning findings into a verdict and findings are only ever ADDED, an extra pass can
// move PASS -> REVIEW -> BLOCK and can never move a verdict the other way. Additional
// findings are also refused the 'block' severity entirely - a BLOCK must come from a
// deterministic project or configured rule, never from a judgment call.
function applyAdditionalFindings(result, additionalFindings, additionalLimitations = []) {
  const baseValidation = validateComplianceResultShape(result);
  if (!baseValidation.valid) {
    throw new Error(`applyAdditionalFindings requires a valid compliance result: ${baseValidation.errors.join('; ')}`);
  }

  const extra = normalizeArray(additionalFindings).filter(isPlainObject);
  for (const finding of extra) {
    if (finding.severity === 'block') {
      throw new Error(
        'applyAdditionalFindings refuses a block-severity finding: a BLOCK may only come from a deterministic project or configured policy rule, never from a supplementary or AI-assisted judgment.'
      );
    }
  }

  const findings = [...result.findings, ...extra];
  const updated = {
    ...result,
    findings,
    status: deriveComplianceStatus(findings),
    review_reasons: deriveReviewReasons(findings),
    limitations: [...result.limitations, ...normalizeArray(additionalLimitations).filter(isNonEmptyString)],
    checks: result.checks.map((check) =>
      extra.some((finding) => finding.check_type === check.check_type) && check.status === 'passed'
        ? { ...check, status: 'flagged', detail: `${check.detail} A supplementary check also produced findings for this check type.` }
        : check
    ),
  };

  const validation = validateComplianceResultShape(updated);
  if (!validation.valid) {
    throw new Error(`applyAdditionalFindings produced an invalid compliance result: ${validation.errors.join('; ')}`);
  }
  return updated;
}

// ---------------------------------------------------------------------------------
// The boundary to human approval - reported, never crossed.
// ---------------------------------------------------------------------------------

// Whether this content may proceed TO a human approver. NOT an approval, and not a way
// past a BLOCK: a BLOCK is ineligible, and this project's approval architecture
// (approvals/approvalArchitecture.js) has no authorized-override mechanism, so none is
// offered here.
function isEligibleForHumanApproval(result) {
  return Boolean(result && result.status !== 'BLOCK');
}

// A compact, backward-compatible summary the existing approval flow can carry alongside
// an approval request WITHOUT any change to approvals/approvalRequestModel.js's schema
// or to approvals/approvalWorkflow.js's lifecycle. It is plain data - it creates no
// request, decides nothing, and adds no second approval state machine.
function summarizeComplianceForApproval(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('summarizeComplianceForApproval requires a compliance result.');
  }
  return {
    compliance_status: result.status,
    compliance_checked_at: result.checked_at,
    compliance_checker_version: result.checker_version,
    eligible_for_human_approval: isEligibleForHumanApproval(result),
    review_reasons: [...(result.review_reasons || [])],
    blocking_findings: (result.findings || [])
      .filter((finding) => finding && finding.severity === 'block')
      .map((finding) => ({ check_type: finding.check_type, rule_id: finding.rule_id, reason: finding.reason })),
  };
}

// ---------------------------------------------------------------------------------
// The content-generation adapter - the minimum integration, and read-only.
// ---------------------------------------------------------------------------------

// Maps one agent/core/contentBriefModel.js content-generation result into a compliance
// input. A pure projection: tools/seoContentGenerationTool.js,
// agent/core/contentBriefEngine.js and agent/core/contentBriefModel.js are NOT modified
// by this stage, and their evidence/provenance guarantees are carried through exactly as
// produced, never re-derived. `extras` supplies only what the generator has no concept
// of - reference materials, platform/policy context, declared brands.
function complianceInputFromContentGenerationResult(generationResult, extras = {}) {
  if (!isPlainObject(generationResult)) {
    throw new Error('complianceInputFromContentGenerationResult requires a content-generation result object.');
  }
  if (!isNonEmptyString(generationResult.generated_content)) {
    throw new Error(
      'complianceInputFromContentGenerationResult requires a result carrying generated content - a blocked or review result has none, and there is nothing for Compliance to check.'
    );
  }

  const input = {
    content: generationResult.generated_content,
    content_type: generationResult.content_type || '',
    content_reference: generationResult.opportunity_reference || '',
    provenance: {
      source: 'seo_content_generation',
      generator: 'tools/seoContentGenerationTool.js',
      evidence: Array.isArray(generationResult.evidence) ? generationResult.evidence : [],
      supported_facts: normalizeArray(extras.supportedFacts).filter(isNonEmptyString),
    },
  };

  if (extras.referenceMaterials) input.reference_materials = extras.referenceMaterials;
  if (extras.platformContext) input.platform_context = extras.platformContext;
  if (extras.businessContext) input.business_context = extras.businessContext;
  if (extras.policyContext) input.policy_context = extras.policyContext;
  if (extras.requiredChecks) input.required_checks = extras.requiredChecks;
  if (extras.requireProvenance !== undefined) input.require_provenance = extras.requireProvenance;

  return input;
}

module.exports = {
  CHECK_TYPES,
  evaluateCompliance,
  applyAdditionalFindings,
  isEligibleForHumanApproval,
  summarizeComplianceForApproval,
  complianceInputFromContentGenerationResult,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - compliance engine (deterministic, no model call):\n');

  const examples = [
    {
      label: 'Evidenced content, nothing detected',
      input: {
        content:
          'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it. With careful storage and gentle washing it stays warm and usable for a long time.',
        content_type: 'buying guide',
        content_reference: '(placeholder) how-long-does-an-insulated-jacket-last',
        provenance: { source: 'seo_content_generation', evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }] },
      },
    },
    {
      label: 'An outstanding verification marker',
      input: {
        content: 'An insulated jacket typically lasts [VERIFY: typical lifespan] with normal use.',
        provenance: { source: 'seo_content_generation', evidence: [{ signal_kind: 'community_forum', reference: '(placeholder)' }] },
      },
    },
    {
      label: 'An explicit project-policy violation',
      input: {
        content: 'Every design in our store is guaranteed copyright-free, so you can use it however you like.',
        provenance: { source: 'seo_content_generation', evidence: [{ signal_kind: 'community_forum', reference: '(placeholder)' }] },
      },
    },
    {
      label: 'A platform with no rule set available to this checker',
      input: {
        content: 'Our insulated jackets are made for cold, wet commutes.',
        provenance: { source: 'seo_content_generation', evidence: [{ signal_kind: 'community_forum', reference: '(placeholder)' }] },
        platform_context: { platform: 'etsy' },
        required_checks: ['platform_policy'],
      },
    },
  ];

  for (const example of examples) {
    const result = evaluateCompliance(example.input);
    console.log(`--- [${result.status}] ${example.label}`);
    for (const reason of result.review_reasons) console.log(`    reason: ${reason}`);
    console.log(`    eligible for human approval: ${isEligibleForHumanApproval(result)}`);
  }

  console.log('\nNothing above was approved or published - Compliance does neither.');
  console.log('Every value above is an invented placeholder.');
}
