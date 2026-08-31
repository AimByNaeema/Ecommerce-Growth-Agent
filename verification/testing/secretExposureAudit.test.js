'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sendMessage } = require('../../agent/core/claudeClient');
const { getShopInfo, getProducts, getClientCredentialsToken } = require('../../integrations/adapters/shopifyClient');

// This file is a regression guard, not a re-audit: a manual audit already confirmed
// agent/core/claudeClient.js and integrations/adapters/shopifyClient.js never log or
// throw a raw credential. These tests drive both clients through their real failure
// paths with a distinctive CANARY secret value and assert the canary never surfaces
// in a thrown error message or in console output - so a future edit that accidentally
// starts leaking the key/token fails this suite immediately. The second half is a
// static scan making the same "no hardcoded secret" check the audit ran by hand into
// a permanent, automated one. No real credential is ever read, written, or needed to
// run this file - it never makes a real network call (fetch is always mocked).

const CLAUDE_CANARY = 'sk-ant-CANARY-DO-NOT-LEAK-3f9a7c2e';
const SHOPIFY_CANARY = 'shpat_CANARY-DO-NOT-LEAK-3f9a7c2e';
const SHOPIFY_CLIENT_SECRET_CANARY = 'shcss_CANARY-DO-NOT-LEAK-3f9a7c2e';

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
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

function withCapturedConsole(fn) {
  const lines = [];
  const savedLog = console.log;
  const savedError = console.error;
  const savedWarn = console.warn;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(() => fn())
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.log = savedLog;
      console.error = savedError;
      console.warn = savedWarn;
    });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status text',
    json: async () => body,
  };
}

function assertNoCanaryAnywhere(canary, errorMessage, consoleLines) {
  assert.ok(
    !errorMessage || !errorMessage.includes(canary),
    `thrown error message must never contain the secret value, got: ${errorMessage}`
  );
  for (const line of consoleLines) {
    assert.ok(!line.includes(canary), `console output must never contain the secret value, got: ${line}`);
  }
}

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

(async () => {
  // --- claudeClient.sendMessage --------------------------------------------------

  await testAsync('sendMessage never leaks ANTHROPIC_API_KEY when the network call fails', async () => {
    await withEnv({ ANTHROPIC_API_KEY: CLAUDE_CANARY }, () =>
      withMockedFetch(
        async () => {
          throw new Error('simulated DNS failure');
        },
        async () => {
          const { result, lines } = await withCapturedConsole(async () => {
            try {
              await sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
              return null;
            } catch (err) {
              return err.message;
            }
          });
          assertNoCanaryAnywhere(CLAUDE_CANARY, result, lines);
        }
      )
    );
  });

  await testAsync('sendMessage never leaks ANTHROPIC_API_KEY when the API returns a non-ok status', async () => {
    await withEnv({ ANTHROPIC_API_KEY: CLAUDE_CANARY }, () =>
      withMockedFetch(
        async () => jsonResponse(401, { error: { message: 'invalid x-api-key' } }),
        async () => {
          const { result, lines } = await withCapturedConsole(async () => {
            try {
              await sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
              return null;
            } catch (err) {
              return err.message;
            }
          });
          assertNoCanaryAnywhere(CLAUDE_CANARY, result, lines);
        }
      )
    );
  });

  // --- shopifyClient.getShopInfo / getProducts ------------------------------------

  await testAsync('getShopInfo never leaks SHOPIFY_ADMIN_API_ACCESS_TOKEN when the network call fails', async () => {
    await withEnv(
      { SHOPIFY_STORE_DOMAIN: 'test-store.myshopify.com', SHOPIFY_ADMIN_API_ACCESS_TOKEN: SHOPIFY_CANARY },
      () =>
        withMockedFetch(
          async () => {
            throw new Error('simulated DNS failure');
          },
          async () => {
            const { result, lines } = await withCapturedConsole(async () => {
              try {
                await getShopInfo();
                return null;
              } catch (err) {
                return err.message;
              }
            });
            assertNoCanaryAnywhere(SHOPIFY_CANARY, result, lines);
          }
        )
    );
  });

  await testAsync('getProducts never leaks SHOPIFY_ADMIN_API_ACCESS_TOKEN when the API returns a non-ok status', async () => {
    await withEnv(
      { SHOPIFY_STORE_DOMAIN: 'test-store.myshopify.com', SHOPIFY_ADMIN_API_ACCESS_TOKEN: SHOPIFY_CANARY },
      () =>
        withMockedFetch(
          async () => jsonResponse(401, { errors: [{ message: 'Invalid API key or access token' }] }),
          async () => {
            const { result, lines } = await withCapturedConsole(async () => {
              try {
                await getProducts();
                return null;
              } catch (err) {
                return err.message;
              }
            });
            assertNoCanaryAnywhere(SHOPIFY_CANARY, result, lines);
          }
        )
    );
  });

  await testAsync('getProducts never leaks SHOPIFY_ADMIN_API_ACCESS_TOKEN when the API returns GraphQL errors', async () => {
    await withEnv(
      { SHOPIFY_STORE_DOMAIN: 'test-store.myshopify.com', SHOPIFY_ADMIN_API_ACCESS_TOKEN: SHOPIFY_CANARY },
      () =>
        withMockedFetch(
          async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] }),
          async () => {
            const { result, lines } = await withCapturedConsole(async () => {
              try {
                await getProducts();
                return null;
              } catch (err) {
                return err.message;
              }
            });
            assertNoCanaryAnywhere(SHOPIFY_CANARY, result, lines);
          }
        )
    );
  });

  // --- shopifyClient.getClientCredentialsToken (OAuth Client Credentials secret) --

  await testAsync('getClientCredentialsToken never leaks SHOPIFY_CLIENT_SECRET when the network call fails', async () => {
    await withMockedFetch(
      async () => {
        throw new Error('simulated DNS failure');
      },
      async () => {
        const { result, lines } = await withCapturedConsole(async () => {
          try {
            await getClientCredentialsToken(
              'test-store.myshopify.com',
              'canary-client-id',
              SHOPIFY_CLIENT_SECRET_CANARY,
              'secret-audit-network-failure-key'
            );
            return null;
          } catch (err) {
            return err.message;
          }
        });
        assertNoCanaryAnywhere(SHOPIFY_CLIENT_SECRET_CANARY, result, lines);
      }
    );
  });

  await testAsync('getClientCredentialsToken never leaks SHOPIFY_CLIENT_SECRET when the token endpoint returns a non-ok status', async () => {
    await withMockedFetch(
      async () => jsonResponse(401, { error: 'invalid_client', error_description: 'Invalid client credentials' }),
      async () => {
        const { result, lines } = await withCapturedConsole(async () => {
          try {
            await getClientCredentialsToken(
              'test-store.myshopify.com',
              'canary-client-id',
              SHOPIFY_CLIENT_SECRET_CANARY,
              'secret-audit-bad-status-key'
            );
            return null;
          } catch (err) {
            return err.message;
          }
        });
        assertNoCanaryAnywhere(SHOPIFY_CLIENT_SECRET_CANARY, result, lines);
      }
    );
  });

  await testAsync('getShopInfo never leaks SHOPIFY_CLIENT_SECRET when the OAuth Client Credentials flow is configured and the token request fails', async () => {
    await withEnv(
      {
        SHOPIFY_STORE_DOMAIN: 'test-store.myshopify.com',
        SHOPIFY_CLIENT_ID: 'canary-client-id',
        SHOPIFY_CLIENT_SECRET: SHOPIFY_CLIENT_SECRET_CANARY,
      },
      () =>
        withEnv({ SHOPIFY_ADMIN_API_ACCESS_TOKEN: '' }, () =>
          withMockedFetch(
            async () => jsonResponse(401, { error: 'invalid_client', error_description: 'Invalid client credentials' }),
            async () => {
              const { result, lines } = await withCapturedConsole(async () => {
                try {
                  await getShopInfo();
                  return null;
                } catch (err) {
                  return err.message;
                }
              });
              assertNoCanaryAnywhere(SHOPIFY_CLIENT_SECRET_CANARY, result, lines);
            }
          )
        )
    );
  });

  // --- static repo-wide hardcoded-secret pattern scan -----------------------------

  const SECRET_PATTERNS = [
    { name: 'Anthropic API key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
    { name: 'Shopify Admin API access token', regex: /shpat_[A-Za-z0-9]{20,}/g },
    { name: 'AWS access key id', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'GitHub personal access token', regex: /ghp_[A-Za-z0-9]{36,}/g },
    { name: 'Slack token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  ];

  // Test fixtures intentionally use fake-but-plausible-looking tokens (suffixed
  // '-not-real' or this file's own CANARY strings) - excluded by directory, not by
  // string matching, so the scan stays honest about what it actually checked.
  const SCAN_ROOT = path.join(__dirname, '..', '..');
  const SCAN_DIRS = ['agent', 'tools', 'integrations', 'approvals', 'configuration', 'workflows', 'products'];
  const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'verification']);

  function walk(dir, files) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, files);
      } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        files.push(fullPath);
      }
    }
  }

  test('no hardcoded secret matching a real API key format exists in agent/tools/integrations/approvals/configuration/workflows/products', () => {
    const files = [];
    for (const dirName of SCAN_DIRS) {
      const dirPath = path.join(SCAN_ROOT, dirName);
      if (fs.existsSync(dirPath)) walk(dirPath, files);
    }
    assert.ok(files.length > 20, `expected to scan a substantial number of source files, only found ${files.length}`);

    const hits = [];
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const { name, regex } of SECRET_PATTERNS) {
        const matches = content.match(regex);
        if (matches) {
          hits.push(`${path.relative(SCAN_ROOT, filePath)}: ${name} (${matches.length} match(es))`);
        }
      }
    }
    assert.deepStrictEqual(hits, [], `hardcoded secret-shaped values found:\n${hits.join('\n')}`);
  });

  // Root-level .js files (outside the walked directories above), e.g. any future
  // top-level script - covers the "whole repo" scope the audit requested.
  test('no hardcoded secret in root-level .js files', () => {
    const hits = [];
    for (const entry of fs.readdirSync(SCAN_ROOT, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const content = fs.readFileSync(path.join(SCAN_ROOT, entry.name), 'utf8');
      for (const { name, regex } of SECRET_PATTERNS) {
        const matches = content.match(regex);
        if (matches) hits.push(`${entry.name}: ${name} (${matches.length} match(es))`);
      }
    }
    assert.deepStrictEqual(hits, [], `hardcoded secret-shaped values found:\n${hits.join('\n')}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
