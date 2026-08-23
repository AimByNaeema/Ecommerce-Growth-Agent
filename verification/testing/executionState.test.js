'use strict';

const assert = require('node:assert');
const {
  EXECUTION_STATE_FIELDS,
  createEmptyExecutionState,
  deriveExecutionState,
  validateExecutionStateShape,
} = require('../../agent/core/executionState');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

const EXPECTED_FIELD_IDS = [
  'request',
  'current_task',
  'selected_specialist',
  'inputs',
  'required_context',
  'outputs',
  'evidence',
  'confidence',
  'tool_calls',
  'approvals',
  'errors',
  'completion_state',
];

test('the schema has exactly the 12 required fields, in the requested order', () => {
  assert.deepStrictEqual(EXECUTION_STATE_FIELDS.map((field) => field.id), EXPECTED_FIELD_IDS);
});

test('every field has a non-empty title and description', () => {
  for (const field of EXECUTION_STATE_FIELDS) {
    assert.ok(field.title && field.title.trim() !== '', `${field.id} is missing a title`);
    assert.ok(field.description && field.description.trim() !== '', `${field.id} is missing a description`);
  }
});

test('createEmptyExecutionState returns minimal, honest defaults - nothing invented', () => {
  const state = createEmptyExecutionState('grow the store');
  assert.strictEqual(state.request, 'grow the store');
  assert.strictEqual(state.current_task, '');
  assert.strictEqual(state.selected_specialist, null);
  assert.strictEqual(state.inputs, null);
  assert.deepStrictEqual(state.required_context, []);
  assert.strictEqual(state.outputs, null);
  assert.deepStrictEqual(state.evidence, []);
  assert.strictEqual(state.confidence, 'unassessed');
  assert.deepStrictEqual(state.tool_calls, []);
  assert.deepStrictEqual(state.approvals, []);
  assert.deepStrictEqual(state.errors, []);
  assert.strictEqual(state.completion_state, 'not_started');
});

test('validateExecutionStateShape accepts a well-formed empty state', () => {
  const result = validateExecutionStateShape(createEmptyExecutionState('x'));
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
});

test('validateExecutionStateShape reports a missing field', () => {
  const state = createEmptyExecutionState('x');
  delete state.confidence;
  const result = validateExecutionStateShape(state);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('missing field: confidence'));
});

test('validateExecutionStateShape reports an unexpected extra field', () => {
  const state = createEmptyExecutionState('x');
  state.unnecessary_extra_data = 'should not exist';
  const result = validateExecutionStateShape(state);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('unexpected field: unnecessary_extra_data'));
});

test('validateExecutionStateShape rejects a non-array value for an array field', () => {
  const state = createEmptyExecutionState('x');
  state.errors = 'not an array';
  const result = validateExecutionStateShape(state);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('errors must be an array'));
});

test('validateExecutionStateShape rejects an invalid confidence value', () => {
  const state = createEmptyExecutionState('x');
  state.confidence = 'extremely_sure';
  const result = validateExecutionStateShape(state);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((err) => err.startsWith('confidence must be one of')));
});

test('validateExecutionStateShape rejects an invalid completion_state value', () => {
  const state = createEmptyExecutionState('x');
  state.completion_state = 'done_done';
  const result = validateExecutionStateShape(state);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((err) => err.startsWith('completion_state must be one of')));
});

// --- deriveExecutionState ------------------------------------------------------------

const seoTarget = { type: 'specialist', id: 'seo', title: 'SEO' };
const sharedTarget = { type: 'shared_infrastructure', id: 'configuration', title: 'configuration' };

test('deriveExecutionState reports high confidence and complete only for a real successful outcome', () => {
  const state = deriveExecutionState({
    request: 'check my shop',
    currentTask: 'check my shop',
    target: sharedTarget,
    category: 'configuration',
    toolId: 'business_configuration_retrieval',
    requiredContextIds: ['tool_context', 'business_context'],
    outcome: { status: 'success', data: { name: 'Test Shop' }, error: null, classification: 'analysis_only' },
    verificationStatus: 'passed',
  });
  assert.strictEqual(validateExecutionStateShape(state).valid, true);
  assert.strictEqual(state.confidence, 'high');
  assert.strictEqual(state.completion_state, 'complete');
  assert.deepStrictEqual(state.outputs, { name: 'Test Shop' });
  assert.deepStrictEqual(state.evidence, [{ tool_id: 'business_configuration_retrieval', status: 'success' }]);
  assert.deepStrictEqual(state.tool_calls, ['business_configuration_retrieval']);
  assert.deepStrictEqual(state.approvals, [{ classification: 'analysis_only', status: 'auto_approved' }]);
  assert.deepStrictEqual(state.errors, []);
  assert.deepStrictEqual(state.required_context, ['tool_context', 'business_context']);
});

test('deriveExecutionState reports unassessed confidence and blocked completion for a not_available outcome, with no fabricated evidence', () => {
  const state = deriveExecutionState({
    request: 'run seo analysis',
    currentTask: 'run seo analysis',
    target: seoTarget,
    category: 'seo',
    toolId: 'seo_analysis',
    requiredContextIds: ['tool_context'],
    outcome: { status: 'not_available', data: null, error: "Capability 'seo_analysis' is registered but not yet implemented.", classification: null },
    verificationStatus: 'unverified',
  });
  assert.strictEqual(validateExecutionStateShape(state).valid, true);
  assert.strictEqual(state.confidence, 'unassessed');
  assert.strictEqual(state.completion_state, 'blocked');
  assert.strictEqual(state.outputs, null);
  assert.deepStrictEqual(state.evidence, []);
  assert.deepStrictEqual(state.approvals, []);
  assert.strictEqual(state.errors.length, 1);
});

test('deriveExecutionState reports failed completion and records the error for an error outcome', () => {
  const state = deriveExecutionState({
    request: "check my shop's business configuration",
    currentTask: "check my shop's business configuration",
    target: sharedTarget,
    category: 'configuration',
    toolId: 'business_configuration_retrieval',
    requiredContextIds: ['tool_context', 'business_context'],
    outcome: { status: 'error', data: null, error: 'SHOPIFY_STORE_DOMAIN is not set.', classification: 'analysis_only' },
    verificationStatus: 'failed',
  });
  assert.strictEqual(validateExecutionStateShape(state).valid, true);
  assert.strictEqual(state.completion_state, 'failed');
  assert.strictEqual(state.confidence, 'unassessed');
  assert.deepStrictEqual(state.errors, ['SHOPIFY_STORE_DOMAIN is not set.']);
  assert.deepStrictEqual(state.evidence, []);
});

test('deriveExecutionState invents nothing when no tool was matched at all (e.g. Listing/Social & Advertising today)', () => {
  const listingTarget = { type: 'specialist', id: 'listing', title: 'Listing' };
  const state = deriveExecutionState({
    request: 'improve my listing content',
    currentTask: 'improve my listing content',
    target: listingTarget,
    category: null,
    toolId: null,
    requiredContextIds: ['tool_context'],
    outcome: { status: 'not_available', data: null, error: "No tool is registered yet for the 'listing' specialist.", classification: null },
    verificationStatus: 'unverified',
  });
  assert.strictEqual(validateExecutionStateShape(state).valid, true);
  assert.strictEqual(state.inputs, null);
  assert.deepStrictEqual(state.tool_calls, []);
  assert.strictEqual(state.completion_state, 'blocked');
});

test('deriveExecutionState leaves a state not_started when no outcome has happened yet', () => {
  const state = deriveExecutionState({
    request: 'run seo analysis',
    currentTask: 'run seo analysis',
    target: seoTarget,
    requiredContextIds: [],
    outcome: null,
    verificationStatus: 'unverified',
  });
  assert.strictEqual(validateExecutionStateShape(state).valid, true);
  assert.strictEqual(state.completion_state, 'not_started');
  assert.deepStrictEqual(state.errors, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
