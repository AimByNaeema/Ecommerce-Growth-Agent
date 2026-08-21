# approvals/

Human-in-the-loop approval requests and records for actions the agent proposes but
should not take unilaterally.

[`approvalArchitecture.js`](approvalArchitecture.js) classifies future actions into 4
classes — analysis-only, recommendation, approval-required, externally executable —
and defines the policy governing them: external or potentially consequential actions
(approval-required, externally executable) require explicit approval before they
proceed, unless a later, explicitly-scoped configuration setting permits otherwise;
and the agent must never silently perform a consequential external action. Classification
+ policy only — no external service is connected, and no classification/execution
engine exists yet.
