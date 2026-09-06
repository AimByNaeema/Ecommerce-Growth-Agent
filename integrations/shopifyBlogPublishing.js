'use strict';

// The Shopify Blog Article publishing workflow - the last link in the chain, and the
// first destination in this project that a real store can actually reach:
//
//   SEO generated content -> Compliance -> Human Approval -> Publish Authorization
//     -> Shopify Blog Article
//
// ONE JOB: re-check server-side authorization IMMEDIATELY before the mutation, then call
// the client exactly once, then record what happened. It composes existing pieces and
// adds no second gate of its own: approvals/publishAuthorization.js decides authority,
// integrations/adapters/shopifyClient.js owns the transport and the one real mutation,
// audit/auditTrail.js records it. This is deliberately the same shape as
// integrations/etsyPublishing.js - the proven one, reused rather than reinvented.
//
// NOTHING CLIENT-SUPPLIED IS TRUSTED. There is no parameter here for an approval record,
// an approval status, a compliance verdict, or an authorization result - the same
// property approvals/publishAuthorization.js establishes, preserved by not re-opening it.
// A caller passes the SERVER-HELD requests array plus a lookup id and a content
// reference; authority is recomputed here, at the moment of publishing, not inherited
// from anything a caller asserts.
//
// WHY RE-CHECK WHEN THE CALLER MAY HAVE CHECKED ALREADY. Authorization is a statement
// about a moment: an approval can be rejected, content can be edited into a BLOCK, and a
// permission can be revoked between an earlier check and this call. Re-running it here
// is cheap (compliance is deterministic and offline, and no model is involved) and it is
// the only check whose result is still true when the mutation happens.
//
// FAIL CLOSED. The client's mutation is unreachable except through a passing
// authorization: there is exactly one call site for shopifyClient.createBlogArticle() in
// this file, and it sits after the authorization branch has already returned on every
// failure path. An unauthorized publish makes ZERO mutation calls - not a call that is
// later discarded. The client then applies its OWN fail-closed 'write_content' scope
// preflight before any mutation leaves the process, so a store whose app lacks the scope
// also reaches zero mutations.
//
// ONLY THE APPROVED CONTENT IS PUBLISHED, AND NOTHING IS INVENTED. The article's title
// and body come from the existing generated-content record
// (agent/core/contentBriefModel.js's CONTENT_GENERATION_RESULT_FIELDS): the brief's own
// suggested_title and the generated_content draft. No other brief field is sent - in
// particular competitor_gap_summary, which is a count-based statement ABOUT competitor
// coverage, is never published, and no competitor text reaches Shopify. A missing title
// or body is a refusal, never a substituted placeholder.
//
// THE BLOG AND THE BYLINE ARE CONFIGURATION, NOT CODE. Both come from the caller or from
// integrations/adapters/shopifyClient.js's existing per-business credential resolution
// (SHOPIFY_BLOG_ID / SHOPIFY_ARTICLE_AUTHOR). No real store or blog id appears anywhere
// in this project, and a missing one refuses rather than guessing.
//
// NO AI CALL. Publishing needs no model, so none is made and no token budget is touched.
//
// shopifyClient is required as a module object and called via property access so a test
// can substitute it without a mocking framework - this project's existing convention (see
// tools/aiReasoningCompletion.js's own header). That is also what lets the test suite
// assert an exact mutation call COUNT, which is the real security property.

const shopifyClient = require('./adapters/shopifyClient');
const { authorizePublishing } = require('../approvals/publishAuthorization');
const { appendAuditEvent } = require('../audit/auditTrail');

const PLATFORM = 'shopify';
const DESTINATION = 'blog_article';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// The two fields an article is built from, read out of the EXISTING generated-content
// record rather than any new shape. Returns nulls rather than substitutes when either is
// absent - the caller refuses on that, and never publishes invented copy.
function articleFieldsFromGeneratedContent(content) {
  if (!isPlainObject(content)) return { title: null, body: null };
  const brief = isPlainObject(content.brief) ? content.brief : {};
  return {
    title: isNonEmptyString(brief.suggested_title) ? brief.suggested_title.trim() : null,
    body: isNonEmptyString(content.generated_content) ? content.generated_content : null,
  };
}

// Publishes one already-authorized piece of generated content as a Shopify blog article.
//
//   requests         - the SERVER-HELD approval requests array. Required.
//   requestId        - which approval to consult. A lookup key only.
//   contentReference - the content being published. Matched against the approval.
//   content          - an agent/core/contentBriefModel.js generation result.
//   blogId           - the approved blog's id; falls back to configuration.
//   authorName       - the byline; falls back to configuration.
//   isPublished      - whether the article goes live. Defaults to true.
//   specialistId     - optional, forwarded to the permission re-check.
//   businessId       - optional, selects that business's own Shopify credentials.
//   auditTracker     - optional; the attempt and its result are both recorded.
//
// Returns { published, status, reason, authorization, result, platform, destination }.
//   status 'refused'   - not authorized, or nothing valid to publish. NO mutation was made.
//   status 'failed'    - authorized, the client was called, and Shopify (or the client's
//                        own scope preflight) reported a failure. Reported honestly,
//                        never as a success.
//   status 'published' - authorized and Shopify returned a real article.
//
// Never throws for an unauthorized or failed publish - both are real, reportable
// outcomes. Throws only when `requests` is not a server-held array, which is a
// programming error at the call site rather than an outcome.
async function publishAuthorizedArticleToShopifyBlog({
  requests,
  requestId,
  contentReference,
  content,
  blogId = null,
  authorName = null,
  isPublished = true,
  specialistId,
  businessId = null,
  auditTracker = null,
} = {}) {
  if (!Array.isArray(requests)) {
    throw new Error(
      'publishAuthorizedArticleToShopifyBlog requires the server-held `requests` array. It never accepts an approval record, an approval status, or an authorization result from a caller.'
    );
  }

  // THE RE-CHECK, immediately before the mutation and after nothing else. Recomputed
  // from server-held state: the approval must exist, be genuinely approved by an
  // accountable human, be for THIS content, still carry an unchanged non-BLOCK
  // compliance verdict, and still hold its permission.
  const authorization = authorizePublishing({
    requests,
    requestId,
    contentReference,
    specialistId,
    auditTracker,
  });

  if (!authorization.authorized) {
    appendAuditEvent(auditTracker, {
      type: 'execution',
      toolId: null,
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'refused',
      summary: `Shopify blog publish REFUSED for '${contentReference || '(no content reference)'}' - not authorized (${authorization.failed_check}). No Shopify call was made.`,
      detail: { failed_check: authorization.failed_check, platform: PLATFORM, destination: DESTINATION },
    });
    return {
      published: false,
      status: 'refused',
      reason: authorization.reason,
      authorization,
      result: null,
      platform: PLATFORM,
      destination: DESTINATION,
    };
  }

  // Authorized, but there may still be nothing publishable. Each of these refuses BEFORE
  // the client rather than sending a malformed mutation or inventing a missing value.
  const { title, body } = articleFieldsFromGeneratedContent(content);
  const resolvedBlogId = isNonEmptyString(blogId) ? blogId.trim() : shopifyClient.getConfiguredBlogId({ businessId });
  const resolvedAuthor = isNonEmptyString(authorName)
    ? authorName.trim()
    : shopifyClient.getConfiguredArticleAuthor({ businessId });

  const missing = [];
  if (!title) missing.push("an article title (the brief's suggested_title)");
  if (!body) missing.push('article body content (generated_content)');
  if (!resolvedBlogId) missing.push('the approved blog id (pass blogId, or set SHOPIFY_BLOG_ID)');
  if (!resolvedAuthor) missing.push('an article author (pass authorName, or set SHOPIFY_ARTICLE_AUTHOR)');

  if (missing.length > 0) {
    const reason = `Nothing was published: ${missing.join('; ')}. Nothing here is substituted or invented.`;
    appendAuditEvent(auditTracker, {
      type: 'error',
      status: 'error',
      summary: `Shopify blog publish REFUSED for '${contentReference}' - ${reason} No Shopify call was made.`,
      detail: { platform: PLATFORM, destination: DESTINATION },
    });
    return {
      published: false,
      status: 'refused',
      reason,
      authorization,
      result: null,
      platform: PLATFORM,
      destination: DESTINATION,
    };
  }

  // The attempt is recorded BEFORE the call, so a crash mid-flight still leaves evidence
  // that a mutation was attempted - an attempt that vanishes is worse than a failed one.
  // The blog id is recorded because it names WHERE a publish was aimed, which is exactly
  // what an auditor needs; no credential value is ever recorded here.
  appendAuditEvent(auditTracker, {
    type: 'execution',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'attempted',
    summary: `Shopify blog publish ATTEMPTED for '${contentReference}' under approval '${requestId}' (compliance ${authorization.compliance_status}).`,
    detail: {
      platform: PLATFORM,
      destination: DESTINATION,
      approval_id: requestId,
      decided_by: authorization.approval.decided_by,
      compliance_status: authorization.compliance_status,
      title,
    },
  });

  let result;
  try {
    // The single mutation call site in this file, reached only past every check above.
    result = await shopifyClient.createBlogArticle({
      blogId: resolvedBlogId,
      title,
      body,
      authorName: resolvedAuthor,
      isPublished,
      businessId,
    });
  } catch (err) {
    // A missing credential, a missing 'write_content' scope, a network failure, or a
    // Shopify error - all surfaced as they are, never converted into a success and never
    // retried here (agent/core/networkRetry.js already owns bounded retries inside the
    // client). The error message is the client's own, which is written to name what is
    // missing without ever including a credential value.
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'failed',
      summary: `Shopify blog publish FAILED for '${contentReference}': ${err.message}`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
    });
    return {
      published: false,
      status: 'failed',
      reason: err.message,
      authorization,
      result: null,
      platform: PLATFORM,
      destination: DESTINATION,
    };
  }

  appendAuditEvent(auditTracker, {
    type: 'result',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'success',
    summary: `Shopify blog publish SUCCEEDED for '${contentReference}' under approval '${requestId}'.`,
    detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId, result },
  });

  return {
    published: true,
    status: 'published',
    reason: null,
    authorization,
    // Shopify's actual article result/reference, relayed exactly as the client returned
    // it - never reshaped into something this project invented.
    result,
    platform: PLATFORM,
    destination: DESTINATION,
  };
}

module.exports = {
  PLATFORM,
  DESTINATION,
  articleFieldsFromGeneratedContent,
  publishAuthorizedArticleToShopifyBlog,
};

if (require.main === module) {
  const {
    requestApprovalForCheckedContent,
    decideComplianceGatedApproval,
  } = require('../approvals/complianceApprovalGate');

  console.log('Smart E-Commerce Growth AI Agent - Shopify blog article publishing workflow:\n');

  const contentReference = '(placeholder) jacket-lifespan';
  const generatedContent = {
    brief: { suggested_title: '(placeholder title)' },
    generated_content: '<p>(placeholder body)</p>',
  };

  (async () => {
    const gated = requestApprovalForCheckedContent({
      id: 'apr-1',
      toolId: 'compliance_check',
      complianceInput: {
        content: 'How long an insulated jacket lasts depends on how often you wear it and how you store it.',
        content_reference: contentReference,
        provenance: {
          source: 'seo_content_generation',
          evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder)' }],
        },
      },
    });

    const beforeApproval = await publishAuthorizedArticleToShopifyBlog({
      requests: gated.requests,
      requestId: 'apr-1',
      contentReference,
      content: generatedContent,
      blogId: 'gid://shopify/Blog/000000000 (placeholder)',
      authorName: '(placeholder author)',
    });
    console.log(`--- pending approval  -> ${beforeApproval.status} (${beforeApproval.authorization.failed_check}) - zero Shopify calls`);

    const decided = decideComplianceGatedApproval(gated.requests, 'apr-1', {
      decision: 'approved',
      decidedBy: 'store-owner@example.com (caller-supplied placeholder)',
    });

    const afterApproval = await publishAuthorizedArticleToShopifyBlog({
      requests: decided.requests,
      requestId: 'apr-1',
      contentReference,
      content: generatedContent,
      blogId: 'gid://shopify/Blog/000000000 (placeholder)',
      authorName: '(placeholder author)',
    });
    console.log(`--- approved          -> ${afterApproval.status}`);
    console.log(`    reason: ${afterApproval.reason}`);

    console.log('\nAuthorized publishing reaches the Shopify client, which refuses honestly when the');
    console.log(`store's app lacks the '${shopifyClient.REQUIRED_PUBLISH_SCOPE}' scope rather than fabricating an article.`);
    console.log('Every value above is an invented placeholder.');
  })();
}
