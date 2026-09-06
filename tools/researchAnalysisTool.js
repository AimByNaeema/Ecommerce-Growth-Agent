'use strict';

// The research_analysis tool (tools/toolRegistry.js): connects the Chief/Orchestrator to
// the three agent/core/researchAgent.js capabilities that were already implemented but had
// no tool wrapping them - global_market_research, trend_research, and opportunity_discovery
// (the "HONEST tool_ids GAPS" agent/core/specialistCapabilityRegistry.js's own header
// declares). Thin wrapper - no new research logic is added here, only structured input
// handling, capability dispatch, and an honest outcome status, matching
// tools/marketResearchTool.js's convention exactly.
//
// NO NEW ENGINE, AND NO SECOND DISPATCHER. Dispatch goes through researchAgent.js's own
// existing runResearch({ researchType, ... }) entry point rather than calling the three
// handlers directly, so this file adds no capability table of its own that could drift
// from the agent's. The three ids below are already exactly RESEARCH_TYPE_HANDLERS keys,
// verified against that source.
//
// DELIBERATELY SCOPED TO THE THREE UNWIRED CAPABILITIES. runResearch also dispatches
// market_research, competitor_research, customer_market_intelligence and
// customer_segmentation, but each of those already has its own tool
// (tools/marketResearchTool.js, tools/competitorResearchTool.js,
// tools/customerResearchTool.js). Accepting them here too would be a second route to the
// same capability - exactly the duplicate functionality CLAUDE.md rule 4 forbids - so an
// already-wired researchType is refused with a message naming the tool that owns it,
// rather than silently served twice.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a free-text
// objective through by default; structured research input (markets, trends, signals,
// evidence, ...) must arrive via executionRequest.research_params - the same optional
// passthrough every other research tool uses. When it's missing, this tool reports that
// honestly instead of guessing parameters from the objective text: no market, trend,
// demand figure, search volume or opportunity is ever invented here.
//
// researchParams.researchType selects which capability to run. The orchestrator supplies
// it automatically from the routed capability id (see that file's
// TOOL_CAPABILITY_SELECTORS, valueMap null - the capability id IS the value), so a normal
// Chief route never has to pass it by hand.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams, an unknown/already-wired researchType, or a
//                       required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied anywhere
//   status 'success' - valid input, every composed record ended up evidence-backed
//   status 'partial' - valid input, some but not all records ended up evidence-backed

const { runResearch } = require('../agent/core/researchAgent');

// The capabilities this tool owns - the three that had no tool wrapper.
const SUPPORTED_RESEARCH_TYPES = ['global_market_research', 'trend_research', 'opportunity_discovery'];

// Already reachable elsewhere; named here so the refusal can point at the right tool
// instead of just rejecting a legitimate research type.
const RESEARCH_TYPES_OWNED_BY_OTHER_TOOLS = {
  market_research: 'market_research',
  competitor_research: 'competitor_research (or live_competitor_research)',
  customer_market_intelligence: 'customer_research',
  customer_segmentation: 'customer_research',
};

// Identical to tools/marketResearchTool.js's own deriveStatus - the shared
// researchAgent.js limitation wording ("No evidence was supplied for ...") is what both
// read, so the same rule applies unchanged.
function deriveStatus(result) {
  const recordsMissingEvidence = result.limitations.filter((l) => l.startsWith('No evidence was supplied for')).length;
  const total = result.specialized_records.length;
  const recordsWithEvidence = total - recordsMissingEvidence;
  if (recordsWithEvidence === 0) return 'empty';
  if (recordsWithEvidence === total) return 'success';
  return 'partial';
}

function runResearchAnalysisTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - research_analysis requires structured parameters ' +
        '(e.g. markets, trends, signals, evidence) that a free-text objective cannot provide.',
    };
  }

  const { researchType, ...params } = researchParams;

  if (RESEARCH_TYPES_OWNED_BY_OTHER_TOOLS[researchType]) {
    return {
      status: 'failed',
      result: null,
      error:
        `researchType '${researchType}' is already served by the ${RESEARCH_TYPES_OWNED_BY_OTHER_TOOLS[researchType]} tool - ` +
        `research_analysis covers only: ${SUPPORTED_RESEARCH_TYPES.join(', ')}.`,
    };
  }

  if (!SUPPORTED_RESEARCH_TYPES.includes(researchType)) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown researchType: ${researchType}. Must be one of: ${SUPPORTED_RESEARCH_TYPES.join(', ')}`,
    };
  }

  try {
    // researchAgent.js's own dispatcher - never a local copy of its handler table.
    const result = runResearch({ researchType, ...params });
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { SUPPORTED_RESEARCH_TYPES, RESEARCH_TYPES_OWNED_BY_OTHER_TOOLS, runResearchAnalysisTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - research_analysis tool:\n');

  const cases = {
    'no researchParams (failed)': undefined,
    'unknown researchType (failed)': { researchType: 'not_a_real_type' },
    'already-wired researchType (failed, names the owning tool)': { researchType: 'market_research' },
    'global_market_research, no evidence (empty)': {
      researchType: 'global_market_research',
      markets: [{ market: '(placeholder) United States' }],
    },
    'trend_research with evidence (success)': {
      researchType: 'trend_research',
      trends: [
        {
          topic: '(placeholder) sustainable materials',
          finding: '(placeholder) caller-supplied observation',
          source: ['(placeholder source)'],
        },
      ],
    },
    'opportunity_discovery with evidence (success)': {
      researchType: 'opportunity_discovery',
      signals: [
        {
          topic: '(placeholder) bundle demand',
          finding: '(placeholder) caller-supplied observation',
          source: ['(placeholder source)'],
        },
      ],
    },
  };

  for (const [label, params] of Object.entries(cases)) {
    const outcome = runResearchAnalysisTool(params);
    console.log(`--- ${label}`);
    console.log(`    status: ${outcome.status}${outcome.error ? ` | error: ${outcome.error}` : ''}`);
    if (outcome.result) console.log(`    research_type: ${outcome.result.research_type} | records: ${outcome.result.specialized_records.length}`);
  }

  console.log('\nEvery value above is an invented placeholder - this tool composes only what a caller supplies.');
}
