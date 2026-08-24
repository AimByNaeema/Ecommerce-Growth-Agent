'use strict';

// The customer_research tool (tools/toolRegistry.js): connects the Chief/Orchestrator
// to agent/core/researchAgent.js's runCustomerMarketIntelligence(). Thin wrapper - see
// tools/marketResearchTool.js's header for the full rationale (structured passthrough,
// honest missing-input handling, never-fabricate guarantee) - identical here.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//   status 'empty'   - valid input, but no evidence was supplied for any segment
//   status 'partial' - some segments have evidence, others don't
//   status 'success' - every composed segment record has evidence

const { runCustomerMarketIntelligence } = require('../agent/core/researchAgent');

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

function runCustomerResearchTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - customer_research requires structured parameters (e.g. segments, evidence) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = runCustomerMarketIntelligence(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runCustomerResearchTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - customer_research tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { segments: [{ needs: ['(placeholder need)'] }] },
    'no evidence supplied (empty)': {
      segments: [{ segmentDefinition: '(Example segment A)', needs: ['(placeholder need)'] }],
    },
    'mixed evidence (partial)': {
      segments: [
        { segmentDefinition: '(Example segment A)', needs: ['(placeholder need)'] },
        {
          segmentDefinition: '(Example segment B)',
          needs: ['(placeholder need)'],
          evidence: ['(placeholder source reference)'],
        },
      ],
    },
    'evidence supplied (success)': {
      segments: [
        {
          segmentDefinition: '(Example segment A)',
          needs: ['(placeholder need)'],
          evidence: ['(placeholder source reference)'],
        },
      ],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runCustomerResearchTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
