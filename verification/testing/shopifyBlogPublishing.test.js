'use strict';

// Tests for the Shopify blog article publishing workflow:
//
//   SEO generated content -> Compliance -> Human Approval -> Publish Authorization
//     -> Shopify Blog Article
//
// The security property under test is a CALL COUNT. Almost every test below drives the
// workflow with something that must not be allowed to publish and then asserts that the
// Shopify mutation was called EXACTLY ZERO times - not that a call was made and its
// result discarded. The one authorized path asserts exactly one call, carrying the
// content that was actually approved.
//
// NO REAL SHOPIFY PUBLISHING, AND NO REAL NETWORK CALL, HAPPENS ANYWHERE IN THIS FILE.
// shopifyClient.createBlogArticle is replaced on its shared module object for every test
// that reaches it (this project's existing no-framework mocking convention), and where
// the REAL client function is exercised, global.fetch is replaced with a counting stub
// so that a transport attempt would be caught rather than performed. global.fetch is
// restored and asserted untouched elsewhere.
//
// Every brand, phrase, identity, credential, blog id and reference below is an invented
// placeholder. No real credential is read or needed to run this file, and no real store
// or blog id appears in it.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const shopifyClient = require('../../integrations/adapters/shopifyClient');
const {
  PLATFORM,
  DESTINATION,
  articleFieldsFromGeneratedContent,
  publishAuthorizedArticleToShopifyBlog,
} = require('../../integrations/shopifyBlogPublishing');
const {
  requestApprovalForCheckedContent,
  decideComplianceGatedApproval,
} = require('../../approvals/complianceApprovalGate');
const { createApprovalRequest, decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const {
  validatePublishingAdapterShape,
  validateAdapterShape,
} = require('../../integrations/adapters/platformAdapterContract');
const { CREDENTIAL_KEYS } = require('../../configuration/businessRegistry');
const { createAuditTracker, getEventsByType } = require('../../audit/auditTrail');

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

const CONTENT_REFERENCE = '(placeholder) jacket-lifespan';
const OTHER_CONTENT_REFERENCE = '(placeholder) a-completely-different-page';

const BLOG_ID = 'gid://shopify/Blog/000000000 (placeholder)';
const AUTHOR = '(placeholder author)';

const PROVENANCE = {
  source: 'seo_content_generation',
  evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
};

const PASSING_CONTENT = 'A warm, water-resistant jacket made for cold, wet commutes.';
const REVIEW_CONTENT = 'This jacket lasts [VERIFY: typical lifespan] with normal use and care.';
const BLOCKED_CONTENT = 'Every design in our shop is guaranteed copyright-free, so use it however you like.';

// An agent/core/contentBriefModel.js generation result - the EXISTING shape, not a new
// one. competitor_gap_summary is present precisely so a test can prove it never reaches
// Shopify.
const GENERATED_CONTENT = {
  opportunity_reference: '(placeholder opportunity)',
  brief: {
    suggested_title: '(placeholder suggested title)',
    competitor_gap_summary: 'COMPETITOR-DERIVED-TEXT-MUST-NEVER-BE-PUBLISHED',
    recommended_outline: ['(placeholder outline entry)'],
  },
  generated_content: '<p>(placeholder generated body)</p>',
  content_type: 'blog article',
  target_question: '(placeholder question)',
  status: 'ready',
};

function complianceInput(content, contentReference = CONTENT_REFERENCE) {
  return { content, content_reference: contentReference, content_type: 'blog article', provenance: PROVENANCE };
}

// The real pipeline end to end, returning the SERVER-HELD requests array.
function pipeline(content = PASSING_CONTENT, { decision = 'approved', contentReference = CONTENT_REFERENCE } = {}) {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(content, contentReference),
  });
  if (gated.status !== 'pending_approval') return gated.requests;
  if (decision === 'pending') return gated.requests;
  return decideComplianceGatedApproval(gated.requests, 'apr-1', {
    decision,
    decidedBy: 'store-owner@example.com (placeholder)',
  }).requests;
}

// Replaces the client's mutation and counts every call. No configuration can reach a real
// Shopify endpoint, and global.fetch is asserted untouched throughout.
async function withMockedShopify({ result = null, throws = null }, fn) {
  const savedCreate = shopifyClient.createBlogArticle;
  const savedFetch = global.fetch;
  const calls = [];
  shopifyClient.createBlogArticle = async (request) => {
    calls.push(request);
    if (throws) throw new Error(throws);
    return (
      result || {
        id: 'gid://shopify/Article/000000001 (placeholder)',
        handle: 'placeholder-article',
        title: GENERATED_CONTENT.brief.suggested_title,
        isPublished: true,
        publishedAt: '2000-01-01T00:00:00Z',
        blog: { id: BLOG_ID },
      }
    );
  };
  try {
    return await fn(calls, () => assert.strictEqual(global.fetch, savedFetch, 'global.fetch must never be touched'));
  } finally {
    shopifyClient.createBlogArticle = savedCreate;
    global.fetch = savedFetch;
  }
}

function publish(requests, overrides = {}) {
  return publishAuthorizedArticleToShopifyBlog({
    requests,
    requestId: 'apr-1',
    contentReference: CONTENT_REFERENCE,
    content: GENERATED_CONTENT,
    blogId: BLOG_ID,
    authorName: AUTHOR,
    ...overrides,
  });
}

// Drives the REAL shopifyClient.createBlogArticle with a stubbed transport, so the scope
// preflight is exercised for real. `scopes` is what the store reports as granted.
// Returns { mutations, reads } counts so a test can assert zero MUTATIONS specifically -
// the preflight itself is a legitimate read.
async function withStubbedTransport({ scopes, articleResult = null, userErrors = [] }, fn) {
  const savedFetch = global.fetch;
  const counts = { reads: 0, mutations: 0, tokenRequests: 0, bodies: [] };

  // Everything is stubbed at the fetch layer, which is the ONLY place a real request could
  // leave this process. Reassigning an exported function would not work: the client calls
  // its own internal functions directly, so a swapped export is never consulted.
  //
  // The store's REAL .env credentials may be read to build the request, but no value ever
  // leaves - the OAuth token endpoint is answered here with a canary, so the token the
  // client actually sends is this file's placeholder, not a real one.
  global.fetch = async (url, options) => {
    if (String(url).includes('/admin/oauth/access_token')) {
      counts.tokenRequests += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'placeholder-token-CANARY-DO-NOT-LEAK', expires_in: 86399 }),
      };
    }
    const body = JSON.parse(options.body);
    counts.bodies.push(body);
    if (typeof body.query === 'string' && body.query.includes('articleCreate')) {
      counts.mutations += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            articleCreate: {
              article:
                userErrors.length > 0
                  ? null
                  : articleResult || {
                      id: 'gid://shopify/Article/000000002 (placeholder)',
                      handle: 'placeholder-article',
                      title: GENERATED_CONTENT.brief.suggested_title,
                      isPublished: true,
                      publishedAt: '2000-01-01T00:00:00Z',
                      blog: { id: BLOG_ID },
                    },
              userErrors,
            },
          },
        }),
      };
    }
    counts.reads += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } } }),
    };
  };

  // One stubbed scope answer must never leak into the next case.
  shopifyClient.clearAccessScopesCache();
  try {
    return await fn(counts);
  } finally {
    global.fetch = savedFetch;
    shopifyClient.clearAccessScopesCache();
  }
}

(async () => {
  // --- Configuration goes through the EXISTING architecture --------------------------

  test('the blog id and author are CONFIGURATION, through the existing credential architecture', () => {
    for (const key of ['SHOPIFY_BLOG_ID', 'SHOPIFY_ARTICLE_AUTHOR']) {
      assert.ok(CREDENTIAL_KEYS.includes(key), `${key} must be loadable per business`);
    }
    // Additive: every existing key is still there.
    for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_API_ACCESS_TOKEN', 'ETSY_SHOP_ID', 'ANTHROPIC_API_KEY']) {
      assert.ok(CREDENTIAL_KEYS.includes(key));
    }
    assert.strictEqual(typeof shopifyClient.getConfiguredBlogId, 'function');
    assert.strictEqual(typeof shopifyClient.getConfiguredArticleAuthor, 'function');
  });

  test('NO REAL STORE OR BLOG ID IS HARDCODED anywhere in the new code or this test', () => {
    for (const file of [
      'integrations/shopifyBlogPublishing.js',
      'integrations/adapters/shopifyClient.js',
      'verification/testing/shopifyBlogPublishing.test.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      assert.ok(!/[a-z0-9-]+\.myshopify\.com/i.test(source), `${file} must not hardcode a real store domain`);
      assert.ok(
        !/gid:\/\/shopify\/Blog\/\d+(?!\d*\s*\(placeholder)/.test(source.replace(/000000000/g, 'PLACEHOLDER')),
        `${file} must not hardcode a real blog id`
      );
    }
  });

  test('the READ adapter contract is unchanged, and Shopify is still not a publishing ADAPTER', () => {
    // The one mutation added here does not make shopifyClient a marketplace-listing
    // publishing adapter, and platformAdapterContract.js was deliberately not changed.
    assert.strictEqual(validateAdapterShape(shopifyClient).valid, true);
    assert.strictEqual(validatePublishingAdapterShape(shopifyClient).valid, false);
  });

  // --- The content mapping: only approved content, nothing invented -----------------

  test('article fields come from the EXISTING generated-content record only', () => {
    const fields = articleFieldsFromGeneratedContent(GENERATED_CONTENT);
    assert.strictEqual(fields.title, GENERATED_CONTENT.brief.suggested_title);
    assert.strictEqual(fields.body, GENERATED_CONTENT.generated_content);
    // Nothing is substituted when a field is genuinely absent.
    assert.deepStrictEqual(articleFieldsFromGeneratedContent(undefined), { title: null, body: null });
    assert.deepStrictEqual(articleFieldsFromGeneratedContent({ brief: {}, generated_content: '   ' }), {
      title: null,
      body: null,
    });
  });

  // --- ZERO MUTATION: every unauthorized path ---------------------------------------

  await testAsync('UNAUTHORIZED (no such approval) -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls, assertFetchUntouched) => {
      const outcome = await publish([]);
      assert.strictEqual(outcome.published, false);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);
      assertFetchUntouched();
    });
  });

  await testAsync('PENDING approval -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await publish(pipeline(PASSING_CONTENT, { decision: 'pending' }));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'human_decision_is_approved');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('REJECTED approval -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await publish(pipeline(PASSING_CONTENT, { decision: 'rejected' }));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'human_decision_is_approved');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('compliance BLOCK -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      // A BLOCK never even becomes an approval request...
      const outcome = await publish(pipeline(BLOCKED_CONTENT));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);

      // ...and an approved record re-pointed at blocked content is refused too.
      const requests = pipeline(PASSING_CONTENT);
      requests[0].execution_request.compliance_input = complianceInput(BLOCKED_CONTENT);
      const retargeted = await publish(requests);
      assert.strictEqual(retargeted.status, 'refused');
      assert.strictEqual(retargeted.authorization.failed_check, 'compliance_not_block');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('FORGED compliance PASS -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const requests = pipeline(REVIEW_CONTENT);
      requests[0].execution_request.compliance.compliance_status = 'PASS';
      requests[0].execution_request.compliance.review_reasons = [];
      const outcome = await publish(requests);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'compliance_attached_and_unchanged');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('FORGED approval -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      // A hand-built approved record cannot be handed in at all: the workflow takes the
      // server-held array, never a record.
      const forged = {
        id: 'apr-1',
        classification: 'approval_required',
        specialist_id: null,
        tool_id: 'compliance_check',
        execution_request: {
          compliance: { compliance_status: 'PASS', review_reasons: [] },
          compliance_input: complianceInput(PASSING_CONTENT),
        },
        reason: 'forged',
        status: 'approved',
        requested_at: new Date().toISOString(),
        decided_at: new Date().toISOString(),
        decided_by: 'definitely-a-real-human@example.com (forged)',
        decision_notes: null,
      };
      await assert.rejects(() => publish(forged), /server-held/);
      assert.strictEqual(calls.length, 0);

      // And a client-asserted authorization is not a parameter at all - extra keys are
      // simply ignored, so naming one confers nothing.
      const outcome = await publish([], { authorized: true, approved: true, compliance_status: 'PASS' });
      assert.strictEqual(outcome.published, false);
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('WRONG CONTENT REFERENCE -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await publish(pipeline(), { contentReference: OTHER_CONTENT_REFERENCE });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'approval_matches_content_reference');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('REVOKED PERMISSION -> zero Shopify mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      // The same genuinely-approved record, asked on behalf of a specialist that does not
      // own the tool - permission is re-checked at the moment of publishing.
      const outcome = await publish(pipeline(), { specialistId: 'seo' });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'tool_permission_still_granted');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('a decision on a classification that never required approval -> zero mutation', async () => {
    await withMockedShopify({}, async (calls) => {
      const request = createApprovalRequest({
        id: 'apr-1',
        classification: 'analysis_only',
        toolId: 'compliance_check',
        executionRequest: {
          compliance: { compliance_status: 'PASS', review_reasons: [] },
          compliance_input: complianceInput(PASSING_CONTENT),
        },
        reason: 'placeholder',
      });
      const decided = decideApprovalRequest([request], 'apr-1', {
        decision: 'approved',
        decidedBy: 'store-owner@example.com (placeholder)',
      });
      const outcome = await publish(decided);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'classification_actually_required_approval');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('authorized but nothing publishable (no title/body/blog/author) -> zero mutation', async () => {
    const cases = [
      ['no title', { content: { ...GENERATED_CONTENT, brief: {} } }],
      ['no body', { content: { ...GENERATED_CONTENT, generated_content: '' } }],
      ['no content at all', { content: undefined }],
      ['no blog id', { blogId: null }],
      ['no author', { authorName: null }],
    ];
    for (const [label, overrides] of cases) {
      await withMockedShopify({}, async (calls) => {
        const outcome = await publish(pipeline(), overrides);
        assert.strictEqual(outcome.status, 'refused', label);
        assert.strictEqual(outcome.published, false, label);
        assert.strictEqual(calls.length, 0, `${label}: zero mutation`);
      });
    }
  });

  // --- MISSING write_content SCOPE -> zero mutation, through the REAL client ---------

  await testAsync('MISSING write_content SCOPE -> zero Shopify mutation (real client, stubbed transport)', async () => {
    await withStubbedTransport({ scopes: ['read_products', 'read_orders'] }, async (counts) => {
      const outcome = await publish(pipeline(), { blogId: BLOG_ID, authorName: AUTHOR });
      assert.strictEqual(outcome.published, false);
      assert.strictEqual(outcome.status, 'failed', 'an authorized publish that the store refuses is a failure, not a success');
      assert.strictEqual(outcome.result, null);
      assert.ok(outcome.reason.includes('write_content'), 'the refusal must name the missing scope');
      assert.ok(outcome.reason.includes('No Shopify mutation was attempted.'));
      assert.strictEqual(counts.mutations, 0, 'ZERO mutation may be attempted without the scope');
      assert.ok(counts.reads >= 1, 'the scope preflight is a read, and it did happen');
    });
  });

  await testAsync('the client itself refuses without the scope, and reports it honestly', async () => {
    await withStubbedTransport({ scopes: ['read_products'] }, async (counts) => {
      assert.strictEqual(shopifyClient.REQUIRED_PUBLISH_SCOPE, 'write_content');
      assert.strictEqual(await shopifyClient.hasWriteContentScope({ refresh: true }), false);
      await assert.rejects(
        () => shopifyClient.createBlogArticle({ blogId: BLOG_ID, title: 't', body: 'b', authorName: AUTHOR }),
        /write_content/
      );
      assert.strictEqual(counts.mutations, 0);
    });
  });

  // --- The one authorized path, WITH the scope granted -------------------------------

  await testAsync('VALID AUTHORIZATION -> EXACTLY ONE Shopify mutation, with the approved content', async () => {
    await withMockedShopify({}, async (calls, assertFetchUntouched) => {
      const outcome = await publish(pipeline());
      assert.strictEqual(outcome.published, true);
      assert.strictEqual(outcome.status, 'published');
      assert.strictEqual(outcome.platform, PLATFORM);
      assert.strictEqual(outcome.destination, DESTINATION);
      assert.strictEqual(calls.length, 1, 'exactly one Shopify mutation');
      assert.strictEqual(calls[0].title, GENERATED_CONTENT.brief.suggested_title);
      assert.strictEqual(calls[0].body, GENERATED_CONTENT.generated_content);
      assert.strictEqual(calls[0].blogId, BLOG_ID);
      assert.strictEqual(calls[0].authorName, AUTHOR);
      assertFetchUntouched();
    });
  });

  await testAsync('NO COMPETITOR TEXT is ever sent to Shopify', async () => {
    await withMockedShopify({}, async (calls) => {
      await publish(pipeline());
      assert.strictEqual(calls.length, 1);
      const sent = JSON.stringify(calls[0]);
      assert.ok(
        !sent.includes('COMPETITOR-DERIVED-TEXT-MUST-NEVER-BE-PUBLISHED'),
        "the brief's competitor_gap_summary must never reach Shopify"
      );
      assert.ok(!sent.includes('recommended_outline'), 'no other brief field is published either');
    });
  });

  await testAsync('the real client sends the REAL articleCreate mutation, exactly once', async () => {
    await withStubbedTransport({ scopes: ['read_products', 'write_content'] }, async (counts) => {
      const outcome = await publish(pipeline());
      assert.strictEqual(outcome.published, true);
      assert.strictEqual(counts.mutations, 1, 'exactly one mutation');

      const mutationBody = counts.bodies.find((body) => body.query.includes('articleCreate'));
      // The real, schema-verified operation shape - content travels as GraphQL variables,
      // never interpolated into the query string.
      assert.ok(mutationBody.query.includes('$article: ArticleCreateInput!'));
      assert.ok(mutationBody.query.includes('userErrors'));
      assert.strictEqual(mutationBody.variables.article.title, GENERATED_CONTENT.brief.suggested_title);
      assert.strictEqual(mutationBody.variables.article.body, GENERATED_CONTENT.generated_content);
      assert.strictEqual(mutationBody.variables.article.blogId, BLOG_ID);
      assert.deepStrictEqual(mutationBody.variables.article.author, { name: AUTHOR });
      assert.ok(!mutationBody.query.includes(GENERATED_CONTENT.generated_content));
    });
  });

  await testAsync("Shopify's ACTUAL result is returned, never reshaped or invented", async () => {
    const platformResult = {
      id: 'gid://shopify/Article/000000009 (placeholder)',
      handle: 'placeholder-handle',
      title: '(placeholder)',
      isPublished: true,
      publishedAt: '2000-01-01T00:00:00Z',
      blog: { id: BLOG_ID },
    };
    await withMockedShopify({ result: platformResult }, async () => {
      const outcome = await publish(pipeline());
      assert.deepStrictEqual(outcome.result, platformResult, "the platform's own result must be relayed unchanged");
    });
  });

  await testAsync('an approved REVIEW publishes, and is still reported as REVIEW', async () => {
    await withMockedShopify({}, async (calls) => {
      const outcome = await publish(pipeline(REVIEW_CONTENT));
      assert.strictEqual(outcome.published, true);
      assert.strictEqual(calls.length, 1);
      // Approving a REVIEW never rewrites it to PASS.
      assert.strictEqual(outcome.authorization.compliance_status, 'REVIEW');
    });
  });

  // --- Failure handling ---------------------------------------------------------------

  await testAsync('a Shopify failure is handled safely - reported, never a fabricated success', async () => {
    await withMockedShopify({ throws: 'Shopify returned a placeholder error' }, async (calls) => {
      const outcome = await publish(pipeline());
      assert.strictEqual(outcome.published, false);
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(outcome.result, null, 'a failed publish must carry no result');
      assert.ok(outcome.reason.includes('placeholder error'));
      // It was attempted exactly once - a failure is not silently retried here.
      assert.strictEqual(calls.length, 1);
    });
  });

  await testAsync('Shopify userErrors are a FAILURE, never a fabricated article', async () => {
    await withStubbedTransport(
      {
        scopes: ['write_content'],
        userErrors: [{ field: ['article', 'blogId'], message: 'Blog does not exist (placeholder)', code: 'INVALID' }],
      },
      async (counts) => {
        const outcome = await publish(pipeline());
        assert.strictEqual(outcome.published, false);
        assert.strictEqual(outcome.status, 'failed');
        assert.strictEqual(outcome.result, null);
        assert.ok(outcome.reason.includes('Blog does not exist (placeholder)'));
        assert.strictEqual(counts.mutations, 1);
      }
    );
  });

  // --- Audit and credential safety ------------------------------------------------------

  await testAsync('AUDIT records the attempt AND the result', async () => {
    const tracker = createAuditTracker('run-shopify-blog-publish-1');
    await withMockedShopify({}, async () => {
      await publish(pipeline(), { auditTracker: tracker });
    });
    const attempts = getEventsByType(tracker, 'execution').filter((event) => event.status === 'attempted');
    const results = getEventsByType(tracker, 'result');
    assert.strictEqual(attempts.length, 1, 'the attempt must be recorded before the call');
    assert.strictEqual(results.length, 1, 'the result must be recorded after it');
    assert.ok(attempts[0].summary.includes('ATTEMPTED'));
    assert.ok(results[0].summary.includes('SUCCEEDED'));
  });

  await testAsync('AUDIT records a refusal, naming the failed check, with no call made', async () => {
    const tracker = createAuditTracker('run-shopify-blog-publish-2');
    await withMockedShopify({}, async (calls) => {
      await publish(pipeline(PASSING_CONTENT, { decision: 'rejected' }), { auditTracker: tracker });
      assert.strictEqual(calls.length, 0);
    });
    const refusals = getEventsByType(tracker, 'execution').filter((event) => event.status === 'refused');
    assert.strictEqual(refusals.length, 1);
    assert.ok(refusals[0].summary.includes('No Shopify call was made.'));
    assert.strictEqual(refusals[0].detail.failed_check, 'human_decision_is_approved');
  });

  await testAsync('AUDIT records a failed publish as failed', async () => {
    const tracker = createAuditTracker('run-shopify-blog-publish-3');
    await withMockedShopify({ throws: 'Shopify returned a placeholder error' }, async () => {
      await publish(pipeline(), { auditTracker: tracker });
    });
    const errors = getEventsByType(tracker, 'error');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].summary.includes('FAILED'));
    assert.strictEqual(getEventsByType(tracker, 'result').length, 0, 'a failure must not be recorded as a result');
  });

  await testAsync('CREDENTIALS ARE NEVER EXPOSED - not in errors, results, or the audit trail', async () => {
    const tracker = createAuditTracker('run-shopify-blog-publish-4');
    // withStubbedTransport supplies a canary access token through the real credential
    // path, and the real client then refuses for want of the scope.
    await withStubbedTransport({ scopes: ['read_products'] }, async () => {
      const outcome = await publish(pipeline(), { auditTracker: tracker });
      assert.strictEqual(outcome.status, 'failed');
      const everything = JSON.stringify(outcome) + JSON.stringify(tracker) + outcome.reason;
      assert.ok(!everything.includes('placeholder-token-CANARY-DO-NOT-LEAK'), 'a credential value leaked');
    });
  });

  // --- Structure: one call site, no AI, no other platform ---------------------------------

  test('THERE IS EXACTLY ONE MUTATION CALL SITE, past the authorization branch', () => {
    // Scan the CODE, not the header comment that explains the single-call-site rule.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'shopifyBlogPublishing.js'), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    const callSites = code.match(/shopifyClient\.createBlogArticle\(/g) || [];
    assert.strictEqual(callSites.length, 1, 'more than one call site would be more than one thing to audit');
    // The authorization check precedes it in the file, and there is no other gate.
    assert.ok(code.indexOf('authorizePublishing(') < code.indexOf('shopifyClient.createBlogArticle('));
  });

  test('NO AI CALL is involved in publishing', () => {
    for (const file of ['integrations/shopifyBlogPublishing.js', 'integrations/adapters/shopifyClient.js']) {
      const code = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of ['aiReasoningCompletion', 'claudeClient', 'geminiClient', 'aiProviderSelector']) {
        assert.ok(!code.includes(forbidden), `${file} must not reference ${forbidden}`);
      }
    }
  });

  test('NO OTHER MARKETPLACE OR SOCIAL PLATFORM was implemented', () => {
    const source = fs
      .readFileSync(path.join(__dirname, '..', '..', 'integrations', 'shopifyBlogPublishing.js'), 'utf8')
      .toLowerCase();
    for (const forbidden of ['amazon', 'ebay', 'woocommerce', 'instagram', 'pinterest', 'tiktok']) {
      assert.ok(!source.includes(forbidden), `must not reference ${forbidden}`);
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('shopifyBlogPublishing.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
