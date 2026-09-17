'use strict';

// CHIEF VENDOR CORRECTIONS - the manual production test failures.
//
//   1. "Suggest changing the vendor of 'Toy Story Font SVG' from 'Digital Studio By Naeema' to 'Digital Studio By
//      Naeema Test'" reached shopify_vendor_correction but failed: nothing populated the product, the current vendor
//      or the new vendor, so compliance could not be evaluated and no approval was created.
//   2. "Review the existing approved vendor correction for 'Toy Story Font SVG' and show its exact proposed change
//      and approval status" was answered by the SEO proposal check and showed unrelated pending SEO proposals.
//
// The product names here are fixtures: the behaviour is generic, and several products prove it. NO NETWORK (the
// test network guard), Shopify reads are fixtures, every Shopify write is a tripwire, and all state is temporary.

require('./testNetworkGuard');

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const name of ['RUN_HISTORY_STORE_DIR', 'COMMAND_CENTER_SESSION_DIR', 'APPROVAL_STORE_DIR', 'MEMORY_STORE_DIR', 'CIRCUIT_BREAKER_STORE_DIR', 'VERIFICATION_STORE_DIR']) {
  process.env[name] = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-chief-'));
}

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const approvalStore = require('../../approvals/approvalStore');
const vendorCorrection = require('../../agent/core/vendorCorrectionRequest');
const orchestrator = require('../../agent/core/orchestratorExecutionContract');
const commandCenterSession = require('../../agent/core/commandCenterSession');
const sessionStore = require('../../agent/core/commandCenterSessionStore');
const { executeApprovedCorrection } = require('../../integrations/approvedCorrectionDispatch');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

const PRODUCTS = [
  { id: 'gid://shopify/Product/101', title: 'Toy Story Font SVG', vendor: 'Digital Studio By Naeema' },
  { id: 'gid://shopify/Product/102', title: '200 Wild Flowers Clipart', vendor: 'Digital Studio By Naeema' },
  { id: 'gid://shopify/Product/103', title: "Mom's Clipart Bundle", vendor: 'Old Studio' },
  { id: 'gid://shopify/Product/104', title: 'Twin Title', vendor: 'A' },
  { id: 'gid://shopify/Product/105', title: 'Twin Title', vendor: 'B' },
].map((product) => ({ ...product, handle: product.id, description: 'd', seo: null, status: 'ACTIVE', productType: 'Digital', tags: [], variants: [], collections: [], metafields: [] }));

const WRITES = [];
let READ_FAILS = false;
shopifyClient.isConfigured = () => true;
shopifyClient.getProducts = async () => {
  if (READ_FAILS) throw new Error('Shopify read unavailable (fixture)');
  return PRODUCTS;
};
for (const name of ['updateProductVendor', 'updateProductSeo', 'addProductsToCollection', 'adjustInventoryQuantities', 'createBlogArticle']) {
  shopifyClient[name] = async () => { WRITES.push(name); throw new Error(`WRITE TRIPWIRE: ${name}`); };
}

const PROPOSE = "Suggest changing the vendor of 'Toy Story Font SVG' from 'Digital Studio By Naeema' to 'Digital Studio By Naeema Test'";
const REVIEW = "Review the existing approved vendor correction for 'Toy Story Font SVG' and show its exact proposed change and approval status";

// A stored SEO proposal - the kind the review question was wrongly answered with.
function storeSeoProposal() {
  approvalStore.saveApprovalRecord({
    id: 'seo-run-apr-1',
    classification: 'approval_required',
    specialist_id: 'seo',
    tool_id: 'seo_quality_check',
    execution_request: { business_id: null, research_params: { proposal_kind: 'seo_metadata_proposal', product_reference: '200 Wild Flowers Clipart', shopify_product_id: 'gid://shopify/Product/102' } },
    reason: 'SEO proposal fixture',
    status: 'pending',
    requested_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
    decision_notes: null,
  });
}

async function chiefText(objective) {
  const result = await orchestrator.runOrchestratorContract(objective);
  const session = sessionStore.createSession({ goal: objective });
  const turn = await commandCenterSession.runSessionTurn(session, objective, { runChief: async () => result, saveRun: () => 'run-fixture', lookupResearch: () => null });
  return { result, text: turn.session.messages[turn.session.messages.length - 1].text };
}

(async () => {
  // ---- Parsing is generic -------------------------------------------------------------------------
  test('PARSE: product, current vendor and new vendor are read exactly as quoted, for any product; unquoted "from ... to" too', () => {
    assert.deepStrictEqual(vendorCorrection.parseVendorChange(PROPOSE), { mentions_vendor: true, product_name: 'Toy Story Font SVG', from_vendor: 'Digital Studio By Naeema', to_vendor: 'Digital Studio By Naeema Test', quoted: true });
    const doubleQuoted = vendorCorrection.parseVendorChange('Change the vendor of “Halloween Ghost SVG” to “Spooky Studio”.');
    assert.deepStrictEqual([doubleQuoted.product_name, doubleQuoted.from_vendor, doubleQuoted.to_vendor], ['Halloween Ghost SVG', null, 'Spooky Studio']);
    const unquoted = vendorCorrection.parseVendorChange("Change the vendor of Mom's Clipart Bundle from Old Studio to New Studio.");
    assert.deepStrictEqual([unquoted.product_name, unquoted.from_vendor, unquoted.to_vendor], ["Mom's Clipart Bundle", 'Old Studio', 'New Studio']);
  });

  test('DECIDE: propose vs review vs neither - SEO, negated and diagnostic requests keep their existing routing', () => {
    const decide = (objective) => vendorCorrection.decideVendorCorrection({ objective, routingResult: orchestrator.planRouting(objective) }).kind;
    assert.strictEqual(decide(PROPOSE), 'propose');
    assert.strictEqual(decide(REVIEW), 'review');
    assert.strictEqual(decide('Show the pending vendor correction approval for "200 Wild Flowers Clipart"'), 'review');
    assert.strictEqual(decide('Review the existing approved SEO proposal for "200 Wild Flowers Clipart"'), null, 'an SEO proposal question is not a vendor one');
    assert.strictEqual(decide('Do not change the vendor of "Toy Story Font SVG" to "X".'), null);
    assert.strictEqual(decide('Check my Shopify products for vendor mismatches'), null);
  });

  // ---- 1. Proposal creation ------------------------------------------------------------------------
  let approvalId = null;
  await testAsync('PROPOSE (exact production text): one pending approval for shopify_vendor_correction with the exact product, current and new vendor; nothing written', async () => {
    const { result, text } = await chiefText(PROPOSE);
    assert.strictEqual(result.routing.status, 'planned', result.routing.reason);
    const correction = result.vendor_correction;
    assert.strictEqual(correction.status, 'awaiting_approval', correction.reason);
    assert.deepStrictEqual(
      [correction.product_id, correction.product_reference, correction.current_vendor, correction.new_vendor],
      ['gid://shopify/Product/101', 'Toy Story Font SVG', 'Digital Studio By Naeema', 'Digital Studio By Naeema Test']
    );
    assert.strictEqual(result.pending_approvals.length, 1);
    const approval = result.pending_approvals[0];
    assert.strictEqual(approval.tool_id, 'shopify_vendor_correction');
    assert.strictEqual(approval.status, 'pending');
    assert.strictEqual(approval.id, correction.approval_id);
    const params = approval.execution_request.research_params;
    assert.deepStrictEqual([params.productId, params.productReference, params.currentVendor, params.newVendor, params.proposal_kind], ['gid://shopify/Product/101', 'Toy Story Font SVG', 'Digital Studio By Naeema', 'Digital Studio By Naeema Test', 'vendor_correction']);
    assert.ok(['PASS', 'REVIEW'].includes(approval.execution_request.compliance.compliance_status), 'compliance was evaluated and rides on the approval');
    assert.strictEqual(approval.execution_request.compliance_input.content, 'Digital Studio By Naeema Test');
    assert.strictEqual(correction.compliance_status, approval.execution_request.compliance.compliance_status);
    assert.ok(/current "Digital Studio By Naeema" -> proposed "Digital Studio By Naeema Test"/.test(text), text);
    assert.ok(/waiting for your decision\. Nothing has been written/.test(text), text);
    assert.deepStrictEqual(WRITES, []);
    // The server persists every pending approval of a Chief run (server.js registerChiefRun) - done here as it does.
    approvalStore.saveApprovalRecord(approval, { executionState: 'awaiting_decision' });
    approvalId = approval.id;
  });

  await testAsync('PROPOSE AGAIN: the same open change is shown, never requested twice', async () => {
    const result = await orchestrator.runOrchestratorContract(PROPOSE);
    assert.strictEqual(result.vendor_correction.status, 'existing');
    assert.strictEqual(result.vendor_correction.approval_id, approvalId);
    assert.strictEqual(result.pending_approvals.length, 0);
  });

  // ---- 5. No Shopify mutation before approval --------------------------------------------------------
  await testAsync('NO MUTATION BEFORE APPROVAL: the pending correction cannot execute - not as stored, not with a caller claiming it approved', async () => {
    const stored = approvalStore.loadApprovalRecord(approvalId).approval_request;
    const asStored = await executeApprovedCorrection(stored);
    assert.strictEqual(asStored.reason_code, 'approval_not_approved');
    const forged = await executeApprovedCorrection({ ...stored, status: 'approved', decided_by: 'someone', decided_at: new Date().toISOString() });
    assert.strictEqual(forged.reason_code, 'approval_not_approved', 'a caller-supplied approval is never evidence');
    assert.deepStrictEqual(WRITES, []);
  });

  // ---- 2 + 3. Existing correction lookup, never an SEO proposal ----------------------------------------
  await testAsync('REVIEW (exact production text): the stored vendor correction with its exact change and approval status; no SEO proposal, nothing created', async () => {
    storeSeoProposal();
    const { result, text } = await chiefText(REVIEW);
    assert.strictEqual(result.proposal_check, undefined, 'the SEO proposal check did not run');
    assert.strictEqual(result.vendor_correction.status, 'found');
    const [entry] = result.vendor_correction.corrections;
    assert.strictEqual(result.vendor_correction.corrections.length, 1);
    assert.deepStrictEqual(
      [entry.approval_id, entry.approval_status, entry.execution_state, entry.current_vendor_at_proposal, entry.new_vendor, entry.store_vendor_now],
      [approvalId, 'pending', 'awaiting_decision', 'Digital Studio By Naeema', 'Digital Studio By Naeema Test', 'Digital Studio By Naeema']
    );
    assert.ok(text.includes(`${approvalId} for "Toy Story Font SVG": vendor "Digital Studio By Naeema" -> "Digital Studio By Naeema Test" | approval status: pending`), text);
    assert.ok(!/SEO|Wild Flowers|seo-run-apr-1/.test(text), `no SEO proposal is shown: ${text}`);
    assert.strictEqual(result.pending_approvals.length, 0);
    assert.deepStrictEqual(WRITES, []);
  });

  await testAsync('REVIEW: a product with no vendor correction says so - SEO proposals for it are not offered instead', async () => {
    const { result, text } = await chiefText('Review the existing approved vendor correction for "200 Wild Flowers Clipart" and show its approval status');
    assert.strictEqual(result.routing.clarification_type, 'vendor_correction_not_found');
    assert.ok(/No vendor correction is stored in the approval system for "200 Wild Flowers Clipart"/.test(text), text);
    assert.ok(!/seo-run-apr-1|Pending SEO proposals/.test(text), text);
  });

  await testAsync('REVIEW BY APPROVAL ID: the named approval is found exactly', async () => {
    const result = await orchestrator.runOrchestratorContract(`Show the approval status of the pending vendor correction ${approvalId}`);
    assert.strictEqual(result.vendor_correction.status, 'found', result.routing.reason);
    assert.deepStrictEqual(result.vendor_correction.corrections.map((entry) => entry.approval_id), [approvalId]);
  });

  // ---- 4. Missing or invalid parameters fail closed ---------------------------------------------------
  const failsClosed = [
    ['no new vendor', "Change the vendor of 'Toy Story Font SVG'", 'vendor_correction_missing_parameters', /What should the vendor of "Toy Story Font SVG" become/],
    ['product not in the store', "Suggest changing the vendor of 'Toy Story Font' to 'New Studio'", 'vendor_correction_product_not_found', /No product in your store is titled exactly "Toy Story Font"\. Similar titles: "Toy Story Font SVG"/],
    ['two products share the title', "Change the vendor of 'Twin Title' to 'C'", 'vendor_correction_product_ambiguous', /More than one product/],
    ['stated current vendor is wrong', "Suggest changing the vendor of 'Toy Story Font SVG' from 'Someone Else' to 'X'", 'vendor_correction_current_mismatch', /currently has the vendor "Digital Studio By Naeema"/],
    ['new vendor equals current', "Change the vendor of 'Toy Story Font SVG' to 'Digital Studio By Naeema'", 'vendor_correction_invalid_parameters', /already "Digital Studio By Naeema"/],
    ['new vendor too long', `Change the vendor of 'Toy Story Font SVG' to '${'x'.repeat(256)}'`, 'vendor_correction_invalid_parameters', /at most 255/],
    ['mixed with another job', "Suggest changing the vendor of 'Toy Story Font SVG' to 'New Studio' and write a marketing campaign", 'vendor_correction_mixed', /also for something else/],
  ];
  for (const [label, objective, type, reason] of failsClosed) {
    await testAsync(`FAILS CLOSED (${label}): a precise question back, no approval, nothing written`, async () => {
      const result = await orchestrator.runOrchestratorContract(objective);
      assert.strictEqual(result.routing.status, 'clarification_required');
      assert.strictEqual(result.routing.clarification_type, type, result.routing.reason);
      assert.ok(reason.test(result.routing.reason), result.routing.reason);
      assert.strictEqual(result.vendor_correction.approvals_created, 0);
      assert.ok(!result.pending_approvals || result.pending_approvals.length === 0);
      assert.deepStrictEqual(WRITES, []);
    });
  }

  await testAsync('FAILS CLOSED (store unreadable): no product or current vendor is assumed', async () => {
    READ_FAILS = true;
    try {
      const result = await orchestrator.runOrchestratorContract("Change the vendor of '200 Wild Flowers Clipart' to 'New Studio'");
      assert.strictEqual(result.routing.clarification_type, 'vendor_correction_store_unreadable');
      assert.strictEqual(result.vendor_correction.approvals_created, 0);
    } finally {
      READ_FAILS = false;
    }
    assert.deepStrictEqual(WRITES, []);
  });

  await testAsync('GENERIC: another product gets its own correction with its own values', async () => {
    const result = await orchestrator.runOrchestratorContract("Change the vendor of Mom's Clipart Bundle from Old Studio to New Studio.");
    assert.strictEqual(result.vendor_correction.status, 'awaiting_approval', result.routing.reason);
    const params = result.pending_approvals[0].execution_request.research_params;
    assert.deepStrictEqual([params.productId, params.currentVendor, params.newVendor], ['gid://shopify/Product/103', 'Old Studio', 'New Studio']);
    assert.deepStrictEqual(WRITES, []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
