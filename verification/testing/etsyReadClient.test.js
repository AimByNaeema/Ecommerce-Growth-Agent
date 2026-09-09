'use strict';

// integrations/adapters/etsyReadClient.js - the read-only Etsy Open API v3 client.
//
// Every Etsy response is mocked (global.fetch is substituted). No test here reaches Etsy.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');

// Load .env ONCE, here, before any test manipulates process.env.
//
// Credential resolution calls loadEnvOnce() lazily, and Node's process.loadEnvFile assigns
// straight into process.env. Without this line that lazy load would fire INSIDE the first
// withEnv() block - after it had deleted the ETSY_* keys - and put the operator's real
// values back, so this suite would pass or fail depending on how far through configuring
// Etsy the operator happened to be. Doing it up front makes withEnv() authoritative.
require('../../integrations/adapters/etsyClient').loadEnvOnce();

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

// Credentials are placeholders - they authorize nothing, and every response is mocked.
const ENV_KEYS = [
  'ETSY_API_KEYSTRING',
  // Must be listed here, not just supplied in CONFIGURED: withEnv() deletes exactly these
  // keys, so a key omitted from this list keeps the OPERATOR'S REAL VALUE from .env for
  // the whole run - which would make this suite pass on a configured machine and fail on a
  // clean checkout.
  'ETSY_SHARED_SECRET',
  'ETSY_SHOP_ID',
  'ETSY_OAUTH_REFRESH_TOKEN',
  'ETSY_OAUTH_ACCESS_TOKEN',
  'ETSY_QPS_LIMIT',
  'ETSY_CACHE_TTL_MS',
  'MAX_NETWORK_RETRY_ATTEMPTS',
  'NETWORK_RETRY_BASE_DELAY_MS',
];

async function withEnv(values, run) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  etsyReadClient.clearEtsyReadCaches();
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    etsyReadClient.clearEtsyReadCaches();
  }
}

const CONFIGURED = {
  ETSY_API_KEYSTRING: '(placeholder-keystring)',
  ETSY_SHARED_SECRET: '(placeholder-secret)',
  ETSY_SHOP_ID: '99999999',
  ETSY_OAUTH_REFRESH_TOKEN: '(placeholder-refresh)',
  NETWORK_RETRY_BASE_DELAY_MS: '0',
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mocked',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

// Answers the token endpoint first, then hands every API request to `apiHandler`.
function mockedEtsy(apiHandler, { onCall = () => {} } = {}) {
  return async (url, options) => {
    onCall(url, options);
    if (String(url).includes('/public/oauth/token')) {
      return jsonResponse({ access_token: '99.access', refresh_token: '99.refresh', expires_in: 3600, scope: 'shops_r listings_r' });
    }
    return apiHandler(url, options);
  };
}

async function withMockedFetch(handler, run) {
  const saved = global.fetch;
  global.fetch = handler;
  try {
    return await run();
  } finally {
    global.fetch = saved;
  }
}

(async () => {
  // --- READ-ONLY BY CONSTRUCTION ----------------------------------------------------

  test('READ-ONLY: every declared endpoint is a GET', () => {
    assert.ok(etsyReadClient.ETSY_READ_ENDPOINTS.length > 0);
    for (const endpoint of etsyReadClient.ETSY_READ_ENDPOINTS) {
      assert.strictEqual(endpoint.method, 'GET', `${endpoint.id} must be a GET`);
    }
  });

  test('READ-ONLY: assertReadOnlyMethod refuses every mutating method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get', 'post', '']) {
      assert.throws(() => etsyReadClient.assertReadOnlyMethod(method, 'test'), /read-only/, `${method} must be refused`);
    }
    assert.strictEqual(etsyReadClient.assertReadOnlyMethod('GET', 'test'), 'GET');
  });

  test('READ-ONLY: no caller can supply a raw path or method - only a declared endpoint id', async () => {
    await assert.rejects(
      () => etsyReadClient.runEtsyRead({ endpointId: 'deleteListing' }),
      /Unknown Etsy read endpoint/
    );
    await assert.rejects(() => etsyReadClient.runEtsyRead({ endpointId: '/application/listings' }), /Unknown Etsy read endpoint/);
  });

  test('READ-ONLY: the source contains no mutating fetch and no publish reference', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'adapters', 'etsyReadClient.js'), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ["method: 'POST'", "method: 'PUT'", "method: 'PATCH'", "method: 'DELETE'"]) {
      assert.ok(!code.includes(forbidden), `the read client must not contain ${forbidden}`);
    }
    assert.ok(!code.includes('publishListing'), 'the read client must not reference the publish path');
  });

  // --- CONFIGURATION ----------------------------------------------------------------

  await testAsync('an unconfigured client reports the missing KEY NAMES and makes no request', async () => {
    await withEnv({}, async () => {
      let calls = 0;
      await withMockedFetch(
        async () => {
          calls += 1;
          return jsonResponse({});
        },
        async () => {
          assert.strictEqual(etsyReadClient.canRead(), false);
          // ETSY_SHOP_ID is deliberately absent from this list: it is derivable from
          // Etsy's getMe under the shops_r scope this phase already holds, so it is not a
          // credential the operator must supply. The keystring and a token source are.
          assert.deepStrictEqual(etsyReadClient.missingReadCredentials(), [
            'ETSY_API_KEYSTRING',
            // Etsy requires it inside the x-api-key header, so a read genuinely cannot
            // proceed without it - see buildApiKeyHeader.
            'ETSY_SHARED_SECRET',
            'ETSY_OAUTH_REFRESH_TOKEN',
          ]);
          await assert.rejects(() => etsyReadClient.getEtsyShop(), /not configured/);
        }
      );
      assert.strictEqual(calls, 0, 'an unconfigured read must not reach the network');
    });
  });

  // --- REQUESTS ---------------------------------------------------------------------

  await testAsync('getEtsyShop calls the documented endpoint with both required headers', async () => {
    await withEnv(CONFIGURED, async () => {
      let apiUrl = null;
      let apiHeaders = null;
      await withMockedFetch(
        mockedEtsy(async (url, options) => {
          apiUrl = String(url);
          apiHeaders = options.headers;
          return jsonResponse({ shop_id: 99999999, shop_name: 'PlaceholderShop', currency_code: 'GBP' });
        }),
        async () => {
          const shop = await etsyReadClient.getEtsyShop();
          assert.strictEqual(shop.shop_id, 99999999);
          assert.strictEqual(shop.channel, 'etsy');
        }
      );
      assert.strictEqual(apiUrl, 'https://api.etsy.com/v3/application/shops/99999999');
      // Etsy requires `keystring:shared_secret` here, not the bare keystring - sending only
      // the keystring is refused with "403: Shared secret is required in x-api-key header."
      assert.strictEqual(apiHeaders['x-api-key'], '(placeholder-keystring):(placeholder-secret)');
      assert.strictEqual(apiHeaders.authorization, 'Bearer 99.access');
    });
  });

  await testAsync('a listing is normalized, channel-stamped, and nothing absent is invented', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () =>
          jsonResponse({
            count: 1,
            results: [{ listing_id: 111, title: 'Placeholder', description: 'Text', tags: ['a'], listing_type: 'download' }],
          })
        ),
        async () => {
          const [listing] = await etsyReadClient.getEtsyListings();
          assert.strictEqual(listing.channel, 'etsy');
          assert.strictEqual(listing.listing_id, 111);
          assert.strictEqual(listing.is_digital_product, true, "listing_type 'download' establishes digital");
          // Fields Etsy did not return come back null - never a plausible default.
          assert.strictEqual(listing.price, null);
          assert.strictEqual(listing.taxonomy_id, null);
        }
      );
    });
  });

  await testAsync('product nature stays UNKNOWN when the listing data does not say', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () => jsonResponse({ count: 1, results: [{ listing_id: 222, title: 'No type given' }] })),
        async () => {
          const [listing] = await etsyReadClient.getEtsyListings();
          assert.strictEqual(listing.is_digital_product, null, 'an unknown product nature must not be guessed');
        }
      );
    });
  });

  await testAsync('an unexpected response shape is an error, never a silent empty result', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () => jsonResponse({ count: 0 })),
        async () => {
          await assert.rejects(() => etsyReadClient.getEtsyListings(), /unexpected shape/);
        }
      );
    });
  });

  // --- RATE LIMITS AND RETRIES ------------------------------------------------------

  await testAsync('429 honours retry-after and stops after the bounded attempts - no storm', async () => {
    await withEnv({ ...CONFIGURED, MAX_NETWORK_RETRY_ATTEMPTS: '3' }, async () => {
      let apiCalls = 0;
      await withMockedFetch(
        mockedEtsy(async () => {
          apiCalls += 1;
          return jsonResponse({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '0' } });
        }),
        async () => {
          await assert.rejects(() => etsyReadClient.getEtsyShop(), /429/);
        }
      );
      assert.strictEqual(apiCalls, 3, 'exactly the bounded number of attempts, then stop');
    });
  });

  await testAsync('a 5xx is retried; a 4xx is never retried', async () => {
    await withEnv({ ...CONFIGURED, MAX_NETWORK_RETRY_ATTEMPTS: '2' }, async () => {
      let serverErrorCalls = 0;
      await withMockedFetch(
        mockedEtsy(async () => {
          serverErrorCalls += 1;
          return jsonResponse({ error: 'boom' }, { status: 503 });
        }),
        async () => {
          await assert.rejects(() => etsyReadClient.getEtsyShop(), /503/);
        }
      );
      assert.strictEqual(serverErrorCalls, 2, 'a transient 5xx is retried up to the bound');
    });

    await withEnv({ ...CONFIGURED, MAX_NETWORK_RETRY_ATTEMPTS: '3' }, async () => {
      let clientErrorCalls = 0;
      await withMockedFetch(
        mockedEtsy(async () => {
          clientErrorCalls += 1;
          return jsonResponse({ error: 'insufficient scope' }, { status: 403 });
        }),
        async () => {
          await assert.rejects(() => etsyReadClient.getEtsyShop(), /403/);
        }
      );
      assert.strictEqual(clientErrorCalls, 1, 'a permission/config error must be attempted exactly once');
    });
  });

  await testAsync('a network failure is retried, then reported - never fabricated as empty', async () => {
    await withEnv({ ...CONFIGURED, MAX_NETWORK_RETRY_ATTEMPTS: '2' }, async () => {
      let calls = 0;
      await withMockedFetch(
        mockedEtsy(async () => {
          calls += 1;
          throw new Error('simulated network failure');
        }),
        async () => {
          await assert.rejects(() => etsyReadClient.getEtsyShop(), /Could not reach the Etsy API/);
        }
      );
      assert.strictEqual(calls, 2);
    });
  });

  await testAsync("Etsy's quota headers are recorded, and an exhausted daily quota STOPS the client", async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () =>
          jsonResponse(
            { shop_id: 1 },
            { headers: { 'x-limit-per-second': '10', 'x-remaining-this-second': '9', 'x-limit-per-day': '10000', 'x-remaining-today': '0' } }
          )
        ),
        async () => {
          await etsyReadClient.getEtsyShop();
          const state = etsyReadClient.getRateLimitState();
          assert.strictEqual(state.limitPerSecond, 10);
          assert.strictEqual(state.remainingToday, 0);
          // With no quota left, the next DIFFERENT read refuses rather than asking again.
          await assert.rejects(
            () => etsyReadClient.getEtsyListing({ listingId: 5 }),
            /no daily request quota remaining/
          );
        }
      );
    });
  });

  test('rate-limit numbers are never invented - unset means unset', () => {
    const savedQps = process.env.ETSY_QPS_LIMIT;
    const savedQpd = process.env.ETSY_QPD_LIMIT;
    delete process.env.ETSY_QPS_LIMIT;
    delete process.env.ETSY_QPD_LIMIT;
    try {
      assert.strictEqual(etsyReadClient.getConfiguredQpsLimit(), null);
      assert.strictEqual(etsyReadClient.getConfiguredQpdLimit(), null);
      process.env.ETSY_QPS_LIMIT = '10';
      assert.strictEqual(etsyReadClient.getConfiguredQpsLimit(), 10);
    } finally {
      if (savedQps === undefined) delete process.env.ETSY_QPS_LIMIT;
      else process.env.ETSY_QPS_LIMIT = savedQps;
      if (savedQpd === undefined) delete process.env.ETSY_QPD_LIMIT;
      else process.env.ETSY_QPD_LIMIT = savedQpd;
    }
  });

  // --- CACHING AND DEDUPLICATION ----------------------------------------------------

  await testAsync('CACHING: a repeated identical read costs one request, not two', async () => {
    await withEnv(CONFIGURED, async () => {
      let apiCalls = 0;
      await withMockedFetch(
        mockedEtsy(async () => {
          apiCalls += 1;
          return jsonResponse({ shop_id: 42 });
        }),
        async () => {
          await etsyReadClient.getEtsyShop();
          await etsyReadClient.getEtsyShop();
          await etsyReadClient.getEtsyShop();
        }
      );
      assert.strictEqual(apiCalls, 1, 'three identical reads must cost one request');
    });
  });

  await testAsync('DEDUPLICATION: concurrent identical reads share one in-flight request', async () => {
    await withEnv({ ...CONFIGURED, ETSY_CACHE_TTL_MS: '0' }, async () => {
      let apiCalls = 0;
      await withMockedFetch(
        mockedEtsy(async () => {
          apiCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return jsonResponse({ shop_id: 42 });
        }),
        async () => {
          // Cache TTL is 0, so only in-flight deduplication can prevent a second request.
          await Promise.all([etsyReadClient.getEtsyShop(), etsyReadClient.getEtsyShop(), etsyReadClient.getEtsyShop()]);
        }
      );
      assert.strictEqual(apiCalls, 1, 'three concurrent identical reads must share one request');
    });
  });

  await testAsync('CACHING: different reads are cached separately, never conflated', async () => {
    await withEnv(CONFIGURED, async () => {
      const requested = [];
      await withMockedFetch(
        mockedEtsy(async (url) => {
          requested.push(String(url));
          return jsonResponse({ listing_id: 1, title: 'x' });
        }),
        async () => {
          await etsyReadClient.getEtsyListing({ listingId: 1 });
          await etsyReadClient.getEtsyListing({ listingId: 2 });
          await etsyReadClient.getEtsyListing({ listingId: 1 });
        }
      );
      assert.strictEqual(requested.length, 2, 'two distinct listings, one repeat served from cache');
    });
  });

  // --- SCOPES -----------------------------------------------------------------------

  await testAsync('getGrantedEtsyScopes reports what Etsy granted', async () => {
    await withEnv(CONFIGURED, async () => {
      await withMockedFetch(
        mockedEtsy(async () => jsonResponse({})),
        async () => {
          assert.deepStrictEqual(await etsyReadClient.getGrantedEtsyScopes(), ['shops_r', 'listings_r']);
        }
      );
    });
  });

  await testAsync('UNKNOWN SCOPES THROW - [] never means "granted"', async () => {
    // A hand-pasted access token carries no scope information. That must be an error, not
    // an empty list a caller's `.includes()` check would silently read as "not granted".
    await withEnv(
      {
        ETSY_API_KEYSTRING: 'k',
        ETSY_SHARED_SECRET: 's',
        ETSY_SHOP_ID: '1',
        ETSY_OAUTH_ACCESS_TOKEN: '(placeholder)',
        NETWORK_RETRY_BASE_DELAY_MS: '0',
      },
      async () => {
        assert.strictEqual(etsyReadClient.canRead(), true, 'a pasted token is still usable for reads');
        await assert.rejects(() => etsyReadClient.getGrantedEtsyScopes(), /cannot be determined/);
      }
    );
  });

  // --- SECRETS ----------------------------------------------------------------------

  await testAsync('SECRETS: an error never carries the keystring or a token value', async () => {
    await withEnv(
      {
        ETSY_API_KEYSTRING: 'SECRET_KEYSTRING',
        ETSY_SHARED_SECRET: 'SECRET_SHARED',
        ETSY_SHOP_ID: '1',
        ETSY_OAUTH_REFRESH_TOKEN: 'SECRET_REFRESH',
        NETWORK_RETRY_BASE_DELAY_MS: '0',
      },
      async () => {
        await withMockedFetch(
          mockedEtsy(async () => jsonResponse({ error: 'nope' }, { status: 403 })),
          async () => {
            try {
              await etsyReadClient.getEtsyShop();
              assert.fail('should have thrown');
            } catch (err) {
              for (const secret of ['SECRET_KEYSTRING', 'SECRET_REFRESH', '99.access']) {
                assert.ok(!err.message.includes(secret), `the error leaked ${secret}`);
              }
            }
          }
        );
      }
    );
  });

  test('NO SECOND FRAMEWORK: the read client reuses the shared layers, adds no dependency', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'adapters', 'etsyReadClient.js'), 'utf8');
    assert.ok(source.includes("require('../../agent/core/networkRetry')"), 'must reuse the shared retry/timeout layer');
    assert.ok(source.includes("require('../../configuration/businessRegistry')"), 'must reuse per-business credentials');
    assert.ok(source.includes("require('./etsyClient')"), 'must reuse the existing Etsy credential resolution');
    const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    for (const dependency of requires) {
      assert.ok(dependency.startsWith('./') || dependency.startsWith('../'), `unexpected dependency: ${dependency}`);
    }
  });

  // --- THE x-api-key HEADER FORMAT ETSY ACTUALLY REQUIRES ---------------------------

  test('buildApiKeyHeader composes keystring:shared_secret, the format Etsy names', () => {
    assert.strictEqual(etsyReadClient.buildApiKeyHeader({ keystring: 'K', sharedSecret: 'S' }), 'K:S');
  });

  await testAsync('REGRESSION GUARD: a real read sends the composed x-api-key, not the keystring', async () => {
    // The live API refused every request sending the bare keystring:
    //   "403: Shared secret is required in x-api-key header."
    // Etsy's own securitySchemes entry states the same format. This asserts the OUTGOING
    // header, so the fix cannot silently regress to the keystring alone.
    await withEnv(CONFIGURED, async () => {
      const apiKeyHeaders = [];
      await withMockedFetch(
        async (url, options) => {
          if (!String(url).includes('/public/oauth/token')) apiKeyHeaders.push(options.headers['x-api-key']);
          return String(url).includes('/public/oauth/token')
            ? jsonResponse({ access_token: '99.access', refresh_token: 'r', expires_in: 3600, scope: 'shops_r listings_r' })
            : jsonResponse({ shop_id: 99999999, count: 0, results: [] });
        },
        async () => {
          await etsyReadClient.getEtsyShop();
          await etsyReadClient.getEtsyListings();
        }
      );
      assert.ok(apiKeyHeaders.length >= 2, 'both reads must really have been issued');
      for (const header of apiKeyHeaders) {
        assert.strictEqual(header, '(placeholder-keystring):(placeholder-secret)');
        assert.notStrictEqual(header, '(placeholder-keystring)', 'the bare keystring is what Etsy rejects');
      }
    });
  });

  await testAsync('a missing shared secret is named, and NO request is attempted', async () => {
    const { ETSY_SHARED_SECRET: _omitted, ...withoutSecret } = CONFIGURED;
    await withEnv(withoutSecret, async () => {
      let calls = 0;
      await withMockedFetch(
        async () => {
          calls += 1;
          return jsonResponse({});
        },
        async () => {
          assert.ok(etsyReadClient.missingReadCredentials().includes('ETSY_SHARED_SECRET'));
          assert.strictEqual(etsyReadClient.canRead(), false);
          await assert.rejects(() => etsyReadClient.getEtsyShop(), /ETSY_SHARED_SECRET/);
        }
      );
      assert.strictEqual(calls, 0, 'an unconfigured read must not reach the network');
    });
  });

  // --- SHOP IDENTITY: DERIVED FROM ETSY, NEVER GUESSED ------------------------------

  // Routes the identity endpoint and the shop endpoint separately, and counts each.
  function mockedIdentity({ me, shop = { shop_id: 99999999, shop_name: 'PlaceholderShop' }, counts }) {
    return mockedEtsy(async (url) => {
      if (String(url).includes('/application/users/me')) {
        counts.me += 1;
        return jsonResponse(me);
      }
      counts.shop += 1;
      counts.shopUrls.push(String(url));
      return jsonResponse(shop);
    });
  }

  test('the identity endpoint is a GET needing only a scope this phase already holds', () => {
    const getMe = etsyReadClient.ETSY_READ_ENDPOINTS.find((entry) => entry.id === 'getMe');
    assert.ok(getMe, 'getMe must be a declared read endpoint');
    assert.strictEqual(getMe.method, 'GET');
    assert.strictEqual(getMe.path, '/application/users/me');
    assert.strictEqual(getMe.requiresShopId, false, 'the identity call cannot need the id it exists to supply');
    // The whole point: reaching it widens nothing.
    const { ETSY_REQUIRED_SCOPES } = require('../../integrations/etsyOAuth');
    assert.ok(ETSY_REQUIRED_SCOPES.includes(getMe.scope), `getMe needs ${getMe.scope}, which must already be granted`);
  });

  test('every declared endpoint states whether it needs a shop id', () => {
    for (const endpoint of etsyReadClient.ETSY_READ_ENDPOINTS) {
      assert.strictEqual(typeof endpoint.requiresShopId, 'boolean', `${endpoint.id} must declare requiresShopId`);
    }
  });

  await testAsync('DERIVED: with no ETSY_SHOP_ID, the shop id comes from getMe and is used', async () => {
    const { ETSY_SHOP_ID: _omitted, ...withoutShopId } = CONFIGURED;
    await withEnv(withoutShopId, async () => {
      const counts = { me: 0, shop: 0, shopUrls: [] };
      await withMockedFetch(mockedIdentity({ me: { user_id: 12345678, shop_id: 87654321 }, counts }), async () => {
        assert.strictEqual(etsyReadClient.canRead(), true, 'a missing shop id must not block reading');
        const shop = await etsyReadClient.getEtsyShop();
        assert.strictEqual(counts.me, 1, 'the identity must be asked for exactly once');
        assert.strictEqual(shop.channel, 'etsy');
        assert.ok(
          counts.shopUrls[0].includes('/shops/87654321'),
          `the derived shop id must be the one requested, got ${counts.shopUrls[0]}`
        );
      });
    });
  });

  await testAsync('NO EXTRA QUOTA: a configured shop id triggers no identity request', async () => {
    await withEnv(CONFIGURED, async () => {
      const counts = { me: 0, shop: 0, shopUrls: [] };
      await withMockedFetch(mockedIdentity({ me: { user_id: 1, shop_id: 99999999 }, counts }), async () => {
        await etsyReadClient.getEtsyShop();
        assert.strictEqual(counts.me, 0, 'a configured shop id must not be re-verified on every read');
        assert.ok(counts.shopUrls[0].includes('/shops/99999999'));
      });
    });
  });

  await testAsync('DERIVED ONCE: the identity is not re-requested for every read', async () => {
    const { ETSY_SHOP_ID: _omitted, ...withoutShopId } = CONFIGURED;
    // Response caching off, so only the derived-id cache can prevent a second getMe.
    await withEnv({ ...withoutShopId, ETSY_CACHE_TTL_MS: '0' }, async () => {
      const counts = { me: 0, shop: 0, shopUrls: [] };
      await withMockedFetch(mockedIdentity({ me: { user_id: 1, shop_id: 87654321 }, counts }), async () => {
        await etsyReadClient.getEtsyShop();
        await etsyReadClient.getEtsyShop();
        assert.strictEqual(counts.shop, 2, 'both reads really happened');
        assert.strictEqual(counts.me, 1, 'the identity must be derived once per process, not once per read');
      });
    });
  });

  await testAsync('NEVER GUESSED: an account with no shop is reported, not defaulted', async () => {
    const { ETSY_SHOP_ID: _omitted, ...withoutShopId } = CONFIGURED;
    await withEnv(withoutShopId, async () => {
      const counts = { me: 0, shop: 0, shopUrls: [] };
      await withMockedFetch(mockedIdentity({ me: { user_id: 12345678, shop_id: null }, counts }), async () => {
        await assert.rejects(() => etsyReadClient.getEtsyShop(), /no shop id could be established/);
        assert.strictEqual(counts.shop, 0, 'no shop-scoped request may be made without a real shop id');
      });
    });
  });

  await testAsync('A PLACEHOLDER SHOP ID IS NOT A CONFIGURED ONE', async () => {
    // Found in the real .env during this work: ETSY_SHOP_ID was set to `...`. A plain
    // non-empty check treats that as configured and puts it straight into a URL path.
    for (const placeholder of ['...', 'TBD', '<your shop id>', 'shop_123', '0', '-1', '12.5']) {
      await withEnv({ ...CONFIGURED, ETSY_SHOP_ID: placeholder }, async () => {
        let calls = 0;
        await withMockedFetch(
          async () => {
            calls += 1;
            return jsonResponse({});
          },
          async () => {
            await assert.rejects(() => etsyReadClient.getEtsyShop(), /not a numeric Etsy shop id/);
          }
        );
        assert.strictEqual(calls, 0, `'${placeholder}' must never reach the network as a shop id`);
      });
    }
  });

  test('a real numeric shop id is accepted unchanged', () => {
    assert.strictEqual(etsyReadClient.assertNumericShopId('99999999'), '99999999');
    assert.strictEqual(etsyReadClient.assertNumericShopId('  87654321  '), '87654321');
  });

  await testAsync('FAILS CLOSED: a configured shop id Etsy disagrees with is refused', async () => {
    await withEnv(CONFIGURED, async () => {
      const counts = { me: 0, shop: 0, shopUrls: [] };
      // Etsy says this token owns a DIFFERENT shop than ETSY_SHOP_ID names.
      await withMockedFetch(mockedIdentity({ me: { user_id: 1, shop_id: 11111111 }, counts }), async () => {
        await assert.rejects(() => etsyReadClient.verifyEtsyShopId(), /is not the shop Etsy reports/);
        assert.strictEqual(counts.shop, 0, 'a mismatch must stop before any shop-scoped request');
      });
    });
  });

  await testAsync('verifyEtsyShopId confirms a matching configured shop id', async () => {
    await withEnv(CONFIGURED, async () => {
      const counts = { me: 0, shop: 0, shopUrls: [] };
      await withMockedFetch(mockedIdentity({ me: { user_id: 12345678, shop_id: 99999999 }, counts }), async () => {
        const report = await etsyReadClient.verifyEtsyShopId();
        assert.strictEqual(report.status, 'verified');
        assert.strictEqual(report.configured_shop_id, '99999999');
        assert.strictEqual(report.etsy_shop_id, '99999999');
      });
    });
  });

  await testAsync('verifyEtsyShopId reports a derived id when none is configured', async () => {
    const { ETSY_SHOP_ID: _omitted, ...withoutShopId } = CONFIGURED;
    await withEnv(withoutShopId, async () => {
      const counts = { me: 0, shop: 0, shopUrls: [] };
      await withMockedFetch(mockedIdentity({ me: { user_id: 12345678, shop_id: 87654321 }, counts }), async () => {
        const report = await etsyReadClient.verifyEtsyShopId();
        assert.strictEqual(report.status, 'derived');
        assert.strictEqual(report.configured_shop_id, null);
        assert.strictEqual(report.etsy_shop_id, '87654321');
      });
    });
  });

  await testAsync('THE TOKEN IS NOT MINED FOR THE ID: identity comes from the API', async () => {
    // Etsy documents that an access token is prefixed with the user id, so the id COULD be
    // scraped out of the credential. This client must not do that - splitting a live
    // secret to learn something Etsy states plainly is the wrong trade, and the token
    // prefix is the USER id, which is not the SHOP id.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'adapters', 'etsyReadClient.js'), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/accessToken\s*\.\s*split/.test(code), 'the access token must never be split apart');
    assert.ok(!/refreshToken\s*\.\s*split/.test(code), 'the refresh token must never be split apart');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('etsyReadClient.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
