# documents/

Customer-facing documents the system generates and hands to the business owner. This is a
**presentation layer**: nothing here executes a workflow, reads a store, or holds state. It
turns definitions that already exist elsewhere into a document a customer can read.

[`workflowDocument.js`](workflowDocument.js) composes **"AVENLY AI — How Your AI Sales
Operating System Works"**, the downloadable explanation of how the system handles a goal:
the Chief and the seven specialists, the Compliance and Human Approval gates, the platform
action boundary, the research → product → SEO → listing chain, and the marketing → social →
analytics loop. Every agent, responsibility, gate and verdict in it is read from
[`agent/core/workflowNarrative.js`](../agent/core/workflowNarrative.js) — the same
definitions the dashboard's workflow map renders — so the document and the product cannot
drift apart. It exports `buildWorkflowDocument()`, `REQUIRED_SECTIONS` (pinned by the test
suite) and `DOCUMENT_FILENAME`. It describes **capability, not a run**: it carries no
execution state and so can never claim that something happened.

[`pdfWriter.js`](pdfWriter.js) is the PDF primitive underneath it — pages, text with real
measured word-wrapping, rules and filled rectangles, and nothing more. It has **no
dependency**, deliberately: this project hand-rolls its external clients for the same reason
(see [`agent/core/claudeClient.js`](../agent/core/claudeClient.js), which says plainly that
no SDK is added for one HTTP call), and the whole runtime has two dependencies. It uses only
Helvetica and Helvetica-Bold — two of the 14 fonts every PDF reader must provide — so nothing
is embedded, and it carries their real character widths so wrapping is measured rather than
guessed. Text is sanitised to WinAnsi before encoding, so a stray typographic character can
never corrupt a content stream.

## What a document in this folder must never contain

These are customer-facing artefacts that leave the system, so the bar is the same one the
dashboard applies and it is enforced by
[`verification/testing/workflowDocumentation.test.js`](../verification/testing/workflowDocumentation.test.js),
which scans the produced bytes:

- **No credentials or secrets** — API keys, tokens, OAuth material, `Authorization` headers.
- **No private customer or store data** — store domains, shop names, shop ids, order or
  buyer information.
- **No run identifiers** — run ids, session ids, or anything tying the document to one
  execution.
- **No internal implementation detail** — filesystem paths, module names, endpoints, hosts,
  stack traces or debugging output.

A document that would need any of the above to make its point should say less instead. If a
figure cannot be stated honestly, the document says so — the same rule the rest of the
system follows: unavailable is an answer, and it is never rendered as zero.
