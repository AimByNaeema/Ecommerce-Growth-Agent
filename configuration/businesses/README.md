# configuration/businesses/

Per-business configuration and credentials, so one running agent can serve more than
one e-commerce business without code changes (CLAUDE.md section 1's long-term goal).
Resolved by [`../businessRegistry.js`](../businessRegistry.js) - not read directly by
anything else.

Each business gets its own folder, named after its `businessId` (letters, digits,
hyphens, underscores only - validated by `businessRegistry.js`'s `isValidBusinessId`):

```
configuration/businesses/
  <businessId>/
    business.yaml   # same shape/validation as ../business.example.yaml
    .env            # same shape as ../../.env.example - git-ignored, never commit
```

`businessId` is optional everywhere it's accepted (`runOrchestratorContract`,
`shopifyClient`'s getters, `claudeClient.sendMessage`, ...). Omitting it reproduces
today's single-business behavior exactly: the root `.env` and `configuration/business.yaml`
outside this folder. Nothing here is required for the single-business case.
