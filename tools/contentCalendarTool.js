'use strict';

// The content_calendar_generation tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/socialAdvertisingAgent.js's content_calendar
// capability. Thin wrapper - no new calendar logic is added here, only structured
// input handling and an honest outcome status, matching
// tools/marketingAnalysisTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (entryReference, date,
// platform, campaign, product, kpi, campaignContext, evidence, etc.) must arrive via
// executionRequest.research_params (the same optional passthrough every research/SEO/
// listing/marketing/social tool uses). When it's missing, this tool reports that
// honestly instead of guessing parameters from the objective text.
//
// Unlike tools/socialContentTool.js and tools/paidAdvertisingTool.js, there is only one
// capability here and `platform` is a required field on the record itself, not a
// dispatch key.
//
// researchParams.campaignContext, when supplied, is passed straight through to
// analyzeContentCalendar() - see agent/core/socialAdvertisingAgent.js for how the
// Marketing Agent's campaign_plan builder is reused to supply campaign context.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied
//   status 'success' - valid input, the underlying record ended up evidence-backed

const { analyzeContentCalendar } = require('../agent/core/socialAdvertisingAgent');

function deriveStatus(result) {
  const recordsMissingEvidence = result.limitations.filter((l) =>
    l.startsWith('No evidence was supplied for')
  ).length;
  const total = result.specialized_records.length;
  const recordsWithEvidence = total - recordsMissingEvidence;
  if (recordsWithEvidence === 0) return 'empty';
  if (recordsWithEvidence === total) return 'success';
  return 'partial';
}

function runContentCalendarTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - content_calendar_generation requires structured parameters (e.g. entryReference, date, platform) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = analyzeContentCalendar(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runContentCalendarTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - content_calendar_generation tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { entryReference: '', date: '2026-11-14', platform: 'tiktok' },
    'unknown platform (failed)': { entryReference: '(Example entry)', date: '2026-11-14', platform: 'snapchat' },
    'no evidence supplied (empty)': {
      entryReference: '(Example Nov 14 tiktok post)',
      date: '2026-11-14',
      platform: 'tiktok',
      topic: 'Cold-weather stress test (caller-supplied placeholder).',
      hook: 'You\'re about to see the warmest $80 jacket on the internet (caller-supplied placeholder).',
    },
    'evidence supplied (success)': {
      entryReference: '(Example Nov 14 tiktok post)',
      date: '2026-11-14',
      platform: 'tiktok',
      topic: 'Cold-weather stress test (caller-supplied placeholder).',
      evidence: ['(placeholder prior-post performance)'],
    },
    'Marketing Agent campaign context supplied - campaign is derived, not caller-typed': {
      entryReference: '(Example Nov 14 tiktok post)',
      date: '2026-11-14',
      platform: 'tiktok',
      campaignContext: {
        campaignReference: '(Example winter jacket launch campaign)',
        objective: 'Drive first-week sales (caller-supplied placeholder).',
        evidence: ['(placeholder prior-campaign result)'],
      },
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runContentCalendarTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    if (outcome.result) console.log(`  campaign: ${outcome.result.specialized_records[0].campaign || '(none)'}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
