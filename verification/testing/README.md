# verification/testing/

Test cases and test results for the agent's capabilities. No test framework chosen yet.

[`controlledAgentTest.js`](controlledAgentTest.js) is a controlled test of the ONE
agent against the owner's real business configuration
(`configuration/business.yaml`). For each of 10 capability areas (business context,
product context, customer/market research, competitor research, product opportunity
analysis, keyword/SEO work, marketing opportunity, growth opportunity, evidence and
verification, memory/state handling), it checks two things separately: whether the
existing schema/workflow module for that area works structurally (`createEmpty*` +
`validate*` succeed), and whether real business data actually exists to populate it -
never guessing or inventing data to fill a gap. Run with
`npm run verify:controlled-agent-test`. It exits non-zero and reports the missing
fields whenever `configuration/business.yaml` is missing or incomplete - by design, not
included in the main `npm test` chain, since its result depends on real business
configuration state rather than fixed assertions.
