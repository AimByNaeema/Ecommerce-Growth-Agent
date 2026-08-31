'use strict';

// Produces one honest, human-readable sentence for a finished execution state
// (agent/core/executionState.js) - the plain-language answer the dashboard shows as
// the primary result, so the raw internal state object is never the only thing a user
// sees for a run. Pure and read-only: never invents a claim beyond what the state
// itself already says, and never upgrades a failed/blocked/empty result into anything
// that reads as a completed answer.

const { getToolResultStatus } = require('./executionState');

function specialistLabel(state) {
  return state.selected_specialist && state.selected_specialist.title
    ? state.selected_specialist.title
    : 'This specialist';
}

function firstError(state) {
  return Array.isArray(state.errors) && state.errors.length > 0 ? state.errors[0] : null;
}

function outputsOwnSummary(outputs) {
  if (!outputs || typeof outputs !== 'object') return null;
  if (typeof outputs.summary === 'string' && outputs.summary.trim()) return outputs.summary;
  if (outputs.result && typeof outputs.result === 'object' && typeof outputs.result.summary === 'string' && outputs.result.summary.trim()) {
    return outputs.result.summary;
  }
  return null;
}

// state: one agent/core/executionState.js-shaped object (a plan step, or a /run
// response before the caller-added `status` field is spread on).
function summarizeExecutionState(state) {
  if (!state || typeof state !== 'object') {
    return 'No result is available.';
  }

  const label = specialistLabel(state);

  if (state.completion_state === 'not_started') {
    return 'This step has not run yet.';
  }

  if (state.completion_state === 'failed') {
    const message = firstError(state) || 'The request could not be completed.';
    return `${label} could not complete this request: ${message}`;
  }

  if (state.completion_state === 'blocked') {
    const toolStatus = getToolResultStatus(state.outputs);
    if (toolStatus === 'empty') {
      return `${label} ran, but no real business data was available - nothing to report yet.`;
    }
    const message = firstError(state) || 'Required information is missing or not yet available.';
    return `${label} is missing data needed to answer this: ${message}`;
  }

  // completion_state === 'complete'
  const ownSummary = outputsOwnSummary(state.outputs);
  if (ownSummary) return ownSummary;
  return `${label} completed this request successfully.`;
}

module.exports = { summarizeExecutionState };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - execution state summarizer:\n');
  const samples = [
    { completion_state: 'not_started', selected_specialist: null, outputs: null, errors: [] },
    {
      completion_state: 'failed',
      selected_specialist: { title: 'Product' },
      outputs: { status: 'failed', result: null, error: 'requires marketRow, productIdentity' },
      errors: ['requires marketRow, productIdentity'],
    },
    {
      completion_state: 'blocked',
      selected_specialist: { title: 'Analytics & Optimization' },
      outputs: { status: 'empty', result: { findings: [] }, error: null },
      errors: [],
    },
    {
      completion_state: 'complete',
      selected_specialist: { title: 'SEO' },
      outputs: { status: 'success', result: { summary: 'Found 3 keyword gaps.' }, error: null },
      errors: [],
    },
  ];
  for (const state of samples) {
    console.log(`[${state.completion_state}] ${summarizeExecutionState(state)}`);
  }
}
