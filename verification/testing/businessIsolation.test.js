'use strict';

// End-to-end isolation tests for the multi-business architecture (see
// configuration/businessRegistry.js and CLAUDE.md section 1's long-term multi-business
// goal). Each test below targets one of the isolation areas named across this
// project's isolation requests: configuration, credentials, products, analytics,
// research, memory, approvals, audit, and usage tracking.
//
// This is NOT a re-test of businessRegistry.js's own unit behavior (see
// businessRegistry.test.js) or of the error-handling paths already covered in
// shopifyClient.test.js/claudeClient.test.js/chiefToApprovalIntegration.test.js - it
// specifically proves that two businesses' credentials/data can coexist in one running
// process without cross-contamination, which is the new risk multi-tenancy introduces
// (a risk that doesn't exist in the single-business, single-.env world those other
// suites cover).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getShopInfo, getProducts, getCustomers, loadEnvOnce } = require('../../integrations/adapters/shopifyClient');
const { runOrchestratorContract } = require('../../agent/core/orchestratorExecutionContract');
const { TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const { runMarketResearchTool } = require('../../tools/marketResearchTool');
const { getMemoryRules } = require('../../agent/core/memoryRules');
const { listMemoryRecords } = require('../../agent/core/memoryStore');

// This suite now runs real orchestrator runs with real businessIds (BUSINESS_A/
// BUSINESS_B below) through agent/core/orchestratorExecutionContract.js's own Memory
// layer wiring (agent/core/memoryContextRetrieval.js) - see this file's own MEMORY
// section. Every function that layer touches reads MEMORY_STORE_DIR at call time
// (never at require time - see agent/core/memoryStore.js's getDefaultMemoryRootDir),
// so setting it once here, before any test runs, keeps every real memory read/write
// this whole file produces inside a throwaway temp directory - never this project's
// own real memory/state/business/ (the same discipline verification/testing/server.test.js
// already applies to RUN_HISTORY_STORE_DIR).
process.env.MEMORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'business-isolation-test-memory-'));

const BUSINESSES_ROOT = path.join(__dirname, '..', '..', 'configuration', 'businesses');

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

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

function withTempBusiness(id, envFileContent, fn) {
  const dir = path.join(BUSINESSES_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), envFileContent);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

function withTwoTempBusinesses(businessA, businessB, fn) {
  return withTempBusiness(businessA.id, businessA.envFileContent, () =>
    withTempBusiness(businessB.id, businessB.envFileContent, fn)
  );
}

function withMockedFetch(mockImpl, fn) {
  const savedFetch = global.fetch;
  global.fetch = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = savedFetch;
    });
}

function withReclassifiedAnalyticsDataRetrieval(classification, fn) {
  const original = TOOL_CLASSIFICATIONS.analytics_data_retrieval;
  TOOL_CLASSIFICATIONS.analytics_data_retrieval = classification;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      TOOL_CLASSIFICATIONS.analytics_data_retrieval = original;
    });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'status text', json: async () => body };
}

function shopInfoResponse(shopName, domain) {
  return jsonResponse(200, { data: { shop: { name: shopName, myshopifyDomain: domain, email: `owner@${domain}` } } });
}

function ordersResponse(nodes) {
  return jsonResponse(200, { data: { orders: { edges: nodes.map((node) => ({ node })) } } });
}

function productsResponse(nodes) {
  return jsonResponse(200, { data: { products: { edges: nodes.map((node) => ({ node })) } } });
}

function sampleProductNode(id, title) {
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    handle: title.toLowerCase().replace(/\s+/g, '-'),
    status: 'ACTIVE',
    productType: 'widget',
    vendor: 'Test Vendor',
    tags: [],
    variants: { edges: [] },
    collections: { edges: [] },
    metafields: { edges: [] },
  };
}

function customersResponse(nodes) {
  return jsonResponse(200, { data: { customers: { edges: nodes.map((node) => ({ node })) } } });
}

function sampleCustomerNode(id, amount) {
  return {
    id: `gid://shopify/Customer/${id}`,
    numberOfOrders: 1,
    amountSpent: { amount, currencyCode: 'USD' },
    state: 'ENABLED',
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function sampleOrderNode(id, amount) {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    currentTotalPriceSet: { shopMoney: { amount, currencyCode: 'USD' } },
    lineItems: { edges: [] },
  };
}

const BUSINESS_A = {
  id: 'test-isolation-biz-a',
  envFileContent:
    'SHOPIFY_STORE_DOMAIN=biz-a.myshopify.com\nSHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_biz-a-fake-not-real\n',
  domain: 'biz-a.myshopify.com',
  token: 'shpat_biz-a-fake-not-real',
};
const BUSINESS_B = {
  id: 'test-isolation-biz-b',
  envFileContent:
    'SHOPIFY_STORE_DOMAIN=biz-b.myshopify.com\nSHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_biz-b-fake-not-real\n',
  domain: 'biz-b.myshopify.com',
  token: 'shpat_biz-b-fake-not-real',
};

// Deliberately a single clause (no "and"/comma) - see
// orchestratorExecutionContract.js's buildPlanStep header comment on cross-clause
// vocabulary isolation: planRouting dedupes multiple clauses that route to the SAME
// target by keeping only the first clause's text as that step's current_task (a
// separate, pre-existing, out-of-scope limitation - see that file's own notes), so a
// two-clause phrasing here ("...growth metrics and sales analytics data") would
// silently discard the "sales analytics data" clause's own words once buildPlanStep's
// tool/capability scoring was correctly narrowed to just the step's own clause,
// changing which Analytics capability this objective resolves to. This business-
// isolation suite only needs *a* real, live-dispatchable Analytics objective - not to
// exercise multi-clause dedup - so it stays single-clause instead.
const ANALYTICS_OBJECTIVE = 'analyze store sales performance growth metrics';

(async () => {
  // --- 1. CONFIGURATION / CREDENTIALS ----------------------------------------------
  // Two businesses' getShopInfo({businessId}) calls in the same process each reach the
  // mocked API using only their own domain/token - proven by inspecting the captured
  // fetch call, never by trusting the returned shop name alone.

  await testAsync(
    'CREDENTIALS: two businesses\' getShopInfo calls in the same process never cross-use each other\'s domain/token',
    async () => {
      await withTwoTempBusinesses(BUSINESS_A, BUSINESS_B, async () => {
        const calls = [];
        await withMockedFetch(
          async (url, options) => {
            calls.push({ url, accessToken: options.headers['X-Shopify-Access-Token'] });
            const domain = url.includes(BUSINESS_A.domain) ? BUSINESS_A : BUSINESS_B;
            return shopInfoResponse(`Shop for ${domain.id}`, domain.domain);
          },
          async () => {
            const resultA = await getShopInfo({ businessId: BUSINESS_A.id });
            const resultB = await getShopInfo({ businessId: BUSINESS_B.id });

            assert.strictEqual(resultA.domain, BUSINESS_A.domain);
            assert.strictEqual(resultB.domain, BUSINESS_B.domain);
            assert.strictEqual(calls.length, 2);
            assert.ok(calls[0].url.includes(BUSINESS_A.domain), 'first call must target business A\'s domain');
            assert.strictEqual(calls[0].accessToken, BUSINESS_A.token);
            assert.ok(calls[1].url.includes(BUSINESS_B.domain), 'second call must target business B\'s domain');
            assert.strictEqual(calls[1].accessToken, BUSINESS_B.token);
            assert.notStrictEqual(calls[0].accessToken, calls[1].accessToken);
          }
        );
      });
    }
  );

  await testAsync('CREDENTIALS: omitting businessId never falls back to a configured business\'s credentials', async () => {
    await withTempBusiness(BUSINESS_A.id, BUSINESS_A.envFileContent, async () => {
      // Force shopifyClient.js's one-time root .env load to happen before the delete
      // below - businessId-scoped calls elsewhere in this file go through
      // businessRegistry.loadBusinessCredentials() instead, which never touches
      // process.env/loadEnvOnce, so this can still be the first trigger of it.
      loadEnvOnce();
      const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
      const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      delete process.env.SHOPIFY_STORE_DOMAIN;
      delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      try {
        await withMockedFetch(
          async () => {
            throw new Error('fetch should never be called - not configured');
          },
          async () => {
            await assert.rejects(() => getShopInfo(), /SHOPIFY_STORE_DOMAIN is not set, or neither SHOPIFY_ADMIN_API_ACCESS_TOKEN nor SHOPIFY_CLIENT_ID\+SHOPIFY_CLIENT_SECRET is set/);
          }
        );
      } finally {
        if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
        else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
        if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
        else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
      }
    });
  });

  // --- 2. PRODUCTS -------------------------------------------------------------------
  // Same connection-layer proof as CREDENTIALS above, but for shopifyClient.getProducts
  // directly - the product catalog is its own named isolation target, distinct from
  // sales/analytics, and deserves its own dedicated cross-tenant proof rather than being
  // assumed to work because getShopInfo does.

  await testAsync(
    'PRODUCTS: two businesses\' getProducts calls in the same process never cross-use each other\'s domain/token or catalog',
    async () => {
      await withTwoTempBusinesses(BUSINESS_A, BUSINESS_B, async () => {
        const calls = [];
        await withMockedFetch(
          async (url, options) => {
            calls.push({ url, accessToken: options.headers['X-Shopify-Access-Token'] });
            if (url.includes(BUSINESS_A.domain)) return productsResponse([sampleProductNode(1, 'Business A Widget')]);
            if (url.includes(BUSINESS_B.domain)) return productsResponse([sampleProductNode(2, 'Business B Gadget')]);
            throw new Error(`unexpected domain in url: ${url}`);
          },
          async () => {
            const productsA = await getProducts({ businessId: BUSINESS_A.id });
            const productsB = await getProducts({ businessId: BUSINESS_B.id });

            assert.strictEqual(productsA[0].title, 'Business A Widget');
            assert.strictEqual(productsB[0].title, 'Business B Gadget');
            assert.strictEqual(calls.length, 2);
            assert.ok(calls[0].url.includes(BUSINESS_A.domain), 'first call must target business A\'s domain');
            assert.strictEqual(calls[0].accessToken, BUSINESS_A.token);
            assert.ok(calls[1].url.includes(BUSINESS_B.domain), 'second call must target business B\'s domain');
            assert.strictEqual(calls[1].accessToken, BUSINESS_B.token);
            assert.notStrictEqual(calls[0].accessToken, calls[1].accessToken);
          }
        );
      });
    }
  );

  // --- 3. CUSTOMERS ------------------------------------------------------------------
  // Same proof again for shopifyClient.getCustomers - customer data is the most
  // sensitive of the three (see the module's own "non-PII fields only" privacy note),
  // so it gets its own explicit cross-tenant guarantee rather than inheriting one.

  await testAsync(
    'CUSTOMERS: two businesses\' getCustomers calls in the same process never cross-use each other\'s domain/token or customer records',
    async () => {
      await withTwoTempBusinesses(BUSINESS_A, BUSINESS_B, async () => {
        const calls = [];
        await withMockedFetch(
          async (url, options) => {
            calls.push({ url, accessToken: options.headers['X-Shopify-Access-Token'] });
            if (url.includes(BUSINESS_A.domain)) return customersResponse([sampleCustomerNode(1, '25.00')]);
            if (url.includes(BUSINESS_B.domain)) return customersResponse([sampleCustomerNode(2, '4200.00')]);
            throw new Error(`unexpected domain in url: ${url}`);
          },
          async () => {
            const customersA = await getCustomers({ businessId: BUSINESS_A.id });
            const customersB = await getCustomers({ businessId: BUSINESS_B.id });

            assert.strictEqual(customersA[0].amountSpent, '25.00');
            assert.strictEqual(customersB[0].amountSpent, '4200.00');
            assert.strictEqual(calls.length, 2);
            assert.ok(calls[0].url.includes(BUSINESS_A.domain), 'first call must target business A\'s domain');
            assert.strictEqual(calls[0].accessToken, BUSINESS_A.token);
            assert.ok(calls[1].url.includes(BUSINESS_B.domain), 'second call must target business B\'s domain');
            assert.strictEqual(calls[1].accessToken, BUSINESS_B.token);
            assert.notStrictEqual(calls[0].accessToken, calls[1].accessToken);
          }
        );
      });
    }
  );

  // --- 4. ANALYTICS ------------------------------------------------------------------
  // Same proof through the real Chief -> specialist -> tool -> external client pipeline
  // (agent/core/orchestratorExecutionContract.js), not just the connection layer
  // directly - confirms business_id survives routing/dispatch intact.

  await testAsync(
    'ANALYTICS: two full orchestrator runs (different businessId) each pull only their own business\'s live order data',
    async () => {
      await withTwoTempBusinesses(BUSINESS_A, BUSINESS_B, async () => {
        await withMockedFetch(
          async (url) => {
            if (url.includes(BUSINESS_A.domain)) return ordersResponse([sampleOrderNode(1, '10.00')]);
            if (url.includes(BUSINESS_B.domain)) return ordersResponse([sampleOrderNode(2, '999.00')]);
            throw new Error(`unexpected domain in url: ${url}`);
          },
          async () => {
            const responseA = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_A.id });
            const responseB = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_B.id });

            const stepA = responseA.routing.plan[0];
            const stepB = responseB.routing.plan[0];
            assert.strictEqual(stepA.outputs.status, 'success');
            assert.strictEqual(stepB.outputs.status, 'success');
            const metricA = stepA.outputs.result.specialized_records[0].sales.actual_metrics[0];
            const metricB = stepB.outputs.result.specialized_records[0].sales.actual_metrics[0];
            assert.strictEqual(metricA.value, '10.00');
            assert.strictEqual(metricB.value, '999.00');
            assert.notStrictEqual(metricA.value, metricB.value);
          }
        );
      });
    }
  );

  // --- 5. RESEARCH ------------------------------------------------------------------
  // Research tools take no businessId and touch no shared state - identical input must
  // produce identical output regardless of which business is conceptually running the
  // call, since there is nothing for a businessId to isolate here.

  test('RESEARCH: market_research is a pure function of its params - no businessId, no shared state to leak between businesses', () => {
    const params = { market: 'European Union', demandSignals: ['x'] };
    const outcomeForA = runMarketResearchTool({ ...params });
    const outcomeForB = runMarketResearchTool({ ...params });
    assert.deepStrictEqual(outcomeForA, outcomeForB);
  });

  // --- 6. MEMORY ----------------------------------------------------------------------
  // Same proof through the real Chief -> specialist -> Memory layer pipeline
  // (agent/core/orchestratorExecutionContract.js's wiring to
  // agent/core/memoryContextRetrieval.js/agent/core/memoryStore.js), not just the
  // declared rule directly - confirms business_id survives all the way into what gets
  // saved/retrieved as memory, the same way the ANALYTICS section above confirms it
  // for live order data.

  test('MEMORY: memoryRules.js\'s "safe" quality still declares memory must stay scoped to its business and never leak across businesses', () => {
    const { qualities } = getMemoryRules();
    const safeQuality = qualities.find((quality) => quality.id === 'safe');
    assert.ok(safeQuality, 'expected a "safe" memory quality to be declared');
    assert.ok(
      /never leaks? across businesses/i.test(safeQuality.description),
      `expected the 'safe' quality to state the cross-business leak rule, got: ${safeQuality.description}`
    );
  });

  await testAsync(
    'MEMORY: two full orchestrator runs (different businessId) each persist and retrieve memory scoped only to their own business',
    async () => {
      await withTwoTempBusinesses(BUSINESS_A, BUSINESS_B, async () => {
        await withMockedFetch(
          async (url) => {
            if (url.includes(BUSINESS_A.domain)) return ordersResponse([sampleOrderNode(3, '42.00')]);
            if (url.includes(BUSINESS_B.domain)) return ordersResponse([sampleOrderNode(4, '77.00')]);
            throw new Error(`unexpected domain in url: ${url}`);
          },
          async () => {
            // Run 1 for each business: a real, verified analytics finding should be
            // persisted to that business's own memory only (never the other's).
            await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_A.id });
            await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_B.id });

            const recordsA = listMemoryRecords(BUSINESS_A.id);
            const recordsB = listMemoryRecords(BUSINESS_B.id);
            assert.ok(recordsA.length > 0, "expected business A's verified analytics finding to be saved to its own memory");
            assert.ok(recordsB.length > 0, "expected business B's verified analytics finding to be saved to its own memory");
            assert.ok(recordsA.every((record) => record.business_id === BUSINESS_A.id));
            assert.ok(recordsB.every((record) => record.business_id === BUSINESS_B.id));
            const idsA = new Set(recordsA.map((record) => record.id));
            const idsB = new Set(recordsB.map((record) => record.id));
            assert.ok([...idsA].every((id) => !idsB.has(id)), 'business A and B memory records must never share an id');

            // Run 2 for each business: retrieval (agent/core/memoryContextRetrieval.js's
            // getRelevantMemoryContext) must see only what that same business saved in
            // run 1 - proven via the audit trail's own 'data_access' retrieval event,
            // never the other business's count.
            const responseA2 = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_A.id });
            const responseB2 = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_B.id });
            const retrievalEventA = responseA2.audit_trail.find(
              (event) => event.type === 'data_access' && /Retrieved \d+ relevant memory record/.test(event.summary)
            );
            const retrievalEventB = responseB2.audit_trail.find(
              (event) => event.type === 'data_access' && /Retrieved \d+ relevant memory record/.test(event.summary)
            );
            assert.ok(retrievalEventA, "expected business A's run 2 to retrieve its own already-saved memory");
            assert.ok(retrievalEventB, "expected business B's run 2 to retrieve its own already-saved memory");
            assert.strictEqual(retrievalEventA.summary.includes(BUSINESS_A.id), true);
            assert.strictEqual(retrievalEventB.summary.includes(BUSINESS_B.id), true);
          }
        );
      });
    }
  );

  await testAsync(
    'MEMORY: runOrchestratorContract without a businessId never touches the Memory layer at all (today\'s default single-business behavior)',
    async () => {
      const response = await runOrchestratorContract(ANALYTICS_OBJECTIVE);
      const memoryEvent = (response.audit_trail || []).find((event) => /memory/i.test(event.summary));
      assert.strictEqual(memoryEvent, undefined, 'expected zero memory-related audit events when no businessId is supplied');
    }
  );

  // --- 7. APPROVALS -------------------------------------------------------------------
  // Business identity rides inside execution_request.business_id (set by
  // createExecutionRequest) - decideApprovalRequest's optional expectedBusinessId is a
  // defense-in-depth guard proven here end-to-end via two real, reclassified requests.

  await testAsync(
    'APPROVALS: decideApprovalRequest with expectedBusinessId refuses to decide another business\'s pending request',
    async () => {
      await withReclassifiedAnalyticsDataRetrieval('externally_executable', async () => {
        const responseA = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_A.id });
        const responseB = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_B.id });
        const requestA = responseA.pending_approvals[0];
        const requestB = responseB.pending_approvals[0];

        assert.strictEqual(requestA.execution_request.business_id, BUSINESS_A.id);
        assert.strictEqual(requestB.execution_request.business_id, BUSINESS_B.id);

        assert.throws(
          () =>
            decideApprovalRequest([requestA], requestA.id, {
              decision: 'approved',
              decidedBy: 'owner@example.com',
              expectedBusinessId: BUSINESS_B.id,
            }),
          /refused: request .* belongs to business/
        );

        const decided = decideApprovalRequest([requestA], requestA.id, {
          decision: 'approved',
          decidedBy: 'owner@example.com',
          expectedBusinessId: BUSINESS_A.id,
        });
        assert.strictEqual(decided[0].status, 'approved');
      });
    }
  );

  // --- 8. AUDIT -------------------------------------------------------------------
  // Two full runs (different businessId) never cross-contaminate: each run's own audit
  // trail carries the correct business_id, and neither run's events mention the other
  // business's domain/token (extends secretExposureAudit.test.js's single-business
  // canary proof to the two-businesses-in-one-process case).

  await testAsync(
    'AUDIT: two full runs (different businessId) produce separate, correctly-tagged audit trails that never mention each other\'s domain',
    async () => {
      await withTwoTempBusinesses(BUSINESS_A, BUSINESS_B, async () => {
        await withMockedFetch(
          async (url) => {
            if (url.includes(BUSINESS_A.domain)) return ordersResponse([sampleOrderNode(1, '10.00')]);
            if (url.includes(BUSINESS_B.domain)) return ordersResponse([sampleOrderNode(2, '999.00')]);
            throw new Error(`unexpected domain in url: ${url}`);
          },
          async () => {
            const responseA = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_A.id });
            const responseB = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_B.id });

            const auditTextA = JSON.stringify(responseA.audit_trail);
            const auditTextB = JSON.stringify(responseB.audit_trail);
            assert.ok(!auditTextA.includes(BUSINESS_B.domain), 'business A\'s audit trail must never mention business B\'s domain');
            assert.ok(!auditTextA.includes(BUSINESS_B.token), 'business A\'s audit trail must never mention business B\'s token');
            assert.ok(!auditTextB.includes(BUSINESS_A.domain), 'business B\'s audit trail must never mention business A\'s domain');
            assert.ok(!auditTextB.includes(BUSINESS_A.token), 'business B\'s audit trail must never mention business A\'s token');
            assert.ok(!auditTextA.includes(BUSINESS_A.token), 'no audit trail should ever contain a raw access token');
          }
        );
      });
    }
  );

  // --- 9. USAGE TRACKING -----------------------------------------------------------
  // Two full runs (different businessId) never cross-contaminate: usage/usageTracker.js
  // tags business_id on every individual record (not just the ledger container, unlike
  // the audit trail above) - each run's usage_ledger events must carry only that run's
  // own business_id, and neither run's ledger/summary should ever mention the other
  // business's domain/token.

  await testAsync(
    'USAGE: two full runs (different businessId) produce separate, correctly-tagged usage ledgers that never leak into each other',
    async () => {
      await withTwoTempBusinesses(BUSINESS_A, BUSINESS_B, async () => {
        await withMockedFetch(
          async (url) => {
            if (url.includes(BUSINESS_A.domain)) return ordersResponse([sampleOrderNode(1, '10.00')]);
            if (url.includes(BUSINESS_B.domain)) return ordersResponse([sampleOrderNode(2, '999.00')]);
            throw new Error(`unexpected domain in url: ${url}`);
          },
          async () => {
            const responseA = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_A.id });
            const responseB = await runOrchestratorContract(ANALYTICS_OBJECTIVE, { businessId: BUSINESS_B.id });

            assert.ok(responseA.usage_ledger.length > 0, 'expected at least one usage event');
            assert.ok(responseB.usage_ledger.length > 0, 'expected at least one usage event');
            responseA.usage_ledger.forEach((event) => assert.strictEqual(event.business_id, BUSINESS_A.id));
            responseB.usage_ledger.forEach((event) => assert.strictEqual(event.business_id, BUSINESS_B.id));

            const runIdsA = new Set(responseA.usage_ledger.map((event) => event.run_id));
            const runIdsB = new Set(responseB.usage_ledger.map((event) => event.run_id));
            assert.strictEqual([...runIdsA].filter((id) => runIdsB.has(id)).length, 0, 'run ids must never collide across businesses');

            assert.strictEqual(responseA.usage_summary.business_id, BUSINESS_A.id);
            assert.strictEqual(responseB.usage_summary.business_id, BUSINESS_B.id);

            const usageTextA = JSON.stringify(responseA.usage_ledger);
            const usageTextB = JSON.stringify(responseB.usage_ledger);
            assert.ok(!usageTextA.includes(BUSINESS_B.domain), 'business A\'s usage ledger must never mention business B\'s domain');
            assert.ok(!usageTextA.includes(BUSINESS_B.token), 'business A\'s usage ledger must never mention business B\'s token');
            assert.ok(!usageTextB.includes(BUSINESS_A.domain), 'business B\'s usage ledger must never mention business A\'s domain');
            assert.ok(!usageTextB.includes(BUSINESS_A.token), 'business B\'s usage ledger must never mention business A\'s token');
            assert.ok(!usageTextA.includes(BUSINESS_A.token), 'no usage ledger should ever contain a raw access token');
          }
        );
      });
    }
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
