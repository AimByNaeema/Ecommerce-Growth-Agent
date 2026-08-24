'use strict';

// The competitor_research tool (tools/toolRegistry.js): connects the Chief/Orchestrator
// to agent/core/researchAgent.js's runCompetitorResearch(). Thin wrapper - see
// tools/marketResearchTool.js's header for the full rationale (structured passthrough,
// honest missing-input handling, never-fabricate guarantee) - identical here.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied for any competitor
//   status 'partial' - some competitors have evidence/source, others don't
//   status 'success' - every composed competitor record has evidence/source

const { runCompetitorResearch } = require('../agent/core/researchAgent');

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

function runCompetitorResearchTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - competitor_research requires structured parameters (e.g. competitors, source) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = runCompetitorResearch(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runCompetitorResearchTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - competitor_research tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { competitors: [{ market: 'European Union' }] },
    'no evidence supplied (empty)': {
      competitors: [{ competitor: '(Example Co. A)', strengths: ['(placeholder strength)'] }],
    },
    'mixed evidence (partial)': {
      competitors: [
        { competitor: '(Example Co. A)', strengths: ['(placeholder strength)'] },
        {
          competitor: '(Example Co. B)',
          strengths: ['(placeholder strength)'],
          source: ['(placeholder source reference)'],
        },
      ],
    },
    'evidence supplied (success)': {
      competitors: [
        {
          competitor: '(Example Co. A)',
          strengths: ['(placeholder strength)'],
          source: ['(placeholder source reference)'],
        },
      ],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runCompetitorResearchTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
