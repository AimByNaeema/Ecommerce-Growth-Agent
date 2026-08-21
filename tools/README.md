# tools/

Definitions for the tools/functions the agent can call to take action or fetch data.

[`configValidator.js`](configValidator.js) validates a business configuration file
against the required fields and reports what's missing. Run directly with
`node tools/configValidator.js [path]` (default `configuration/business.yaml`).
