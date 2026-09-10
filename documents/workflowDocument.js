'use strict';

// The customer-facing PDF: "AVENLY AI - How Your AI Sales Operating System Works".
//
// COMPOSED FROM THE SAME DEFINITIONS THE DASHBOARD RENDERS. Every agent, responsibility,
// gate and verdict below is read from agent/core/workflowNarrative.js, and the agent list
// itself comes from agent/core/specialistRegistry.js. Rewording an agent updates the
// dashboard and this document together; neither can quietly go stale.
//
// CUSTOMER-FACING, AND NOTHING ELSE. No key, token, file path, store id, internal module
// name, endpoint, run id or stack trace is written into this file - see the assertions in
// verification/testing/workflowDocumentation.test.js, which scan the produced bytes.
//
// IT DESCRIBES CAPABILITY, NOT A RUN. This is documentation of how the system works, so it
// carries no execution state and cannot claim anything happened. Live status lives on the
// dashboard, where it is read from the real run.

const { createPdfDocument, wrapText, PAGE_WIDTH, PAGE_HEIGHT } = require('./pdfWriter');
const {
  PRODUCT_NAME,
  DOCUMENT_TITLE,
  STAGE_DEFINITIONS,
  PRIMARY_FLOW,
  GROWTH_LOOP,
  CONDITIONAL_NOTE,
  EVIDENCE_CHAIN,
  UNAVAILABLE_TEXT,
  NODE_STATES,
  getStage,
  getAgentStages,
} = require('../agent/core/workflowNarrative');

// The dashboard's own palette, converted to PDF colour space so the document and the product
// look like one thing. Printed on white, so the light-theme ink values are used.
const INK = [0.043, 0.071, 0.125];
const INK_SOFT = [0.278, 0.325, 0.42];
const INK_FAINT = [0.537, 0.576, 0.658];
const ACCENT = [0.976, 0.451, 0.086];
const BORDER = [0.886, 0.902, 0.929];
const PANEL = [0.973, 0.976, 0.984];
const OK = [0.114, 0.6, 0.31];
const WARN = [0.706, 0.478, 0.035];
const STOP = [0.792, 0.204, 0.204];

const MARGIN_X = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const TOP = 64;
const BOTTOM = PAGE_HEIGHT - 64;

// A tiny flow layout over pdfWriter: a cursor, automatic page breaks, and the handful of
// block types this document needs.
function createLayout(doc) {
  let y = TOP;
  let pageNumber = 0;

  function startPage() {
    doc.addPage();
    pageNumber += 1;
    y = TOP;
    if (pageNumber > 1) {
      doc.drawTextLine(PRODUCT_NAME, { x: MARGIN_X, y: 30, size: 8, font: 'bold', color: INK_FAINT });
      doc.line(MARGIN_X, 46, PAGE_WIDTH - MARGIN_X, 46, { color: BORDER, lineWidth: 0.5 });
    }
  }

  function footer() {
    if (pageNumber <= 1) return;
    doc.line(MARGIN_X, BOTTOM + 18, PAGE_WIDTH - MARGIN_X, BOTTOM + 18, { color: BORDER, lineWidth: 0.5 });
    doc.drawTextLine(`${pageNumber}`, { x: PAGE_WIDTH - MARGIN_X - 10, y: BOTTOM + 34, size: 8, color: INK_FAINT });
  }

  function ensure(space) {
    if (y + space > BOTTOM) {
      footer();
      startPage();
    }
  }

  function heading(text, { size = 17, space = 14 } = {}) {
    ensure(size + space + 20);
    doc.drawTextLine(text, { x: MARGIN_X, y, size, font: 'bold', color: INK });
    y += size + 6;
    doc.line(MARGIN_X, y, MARGIN_X + 44, y, { color: ACCENT, lineWidth: 2 });
    y += space;
  }

  function subheading(text) {
    ensure(30);
    doc.drawTextLine(text, { x: MARGIN_X, y, size: 11, font: 'bold', color: ACCENT });
    y += 18;
  }

  function paragraph(text, { size = 10, color = INK_SOFT, indent = 0, space = 10, font = 'regular' } = {}) {
    const width = CONTENT_WIDTH - indent;
    for (const line of wrapText(text, size, font, width)) {
      ensure(size + 5);
      doc.drawTextLine(line, { x: MARGIN_X + indent, y, size, font, color });
      y += size + 4.5;
    }
    y += space;
  }

  function bullets(items, { size = 10, color = INK_SOFT } = {}) {
    for (const item of items) {
      const lines = wrapText(item, size, 'regular', CONTENT_WIDTH - 16);
      lines.forEach((line, index) => {
        ensure(size + 5);
        if (index === 0) doc.drawTextLine('-', { x: MARGIN_X + 3, y, size, font: 'bold', color: ACCENT });
        doc.drawTextLine(line, { x: MARGIN_X + 16, y, size, color });
        y += size + 4.5;
      });
    }
    y += 8;
  }

  // A soft panel used for the "what this means" callouts.
  function panel(title, body, { tone = null } = {}) {
    const lines = wrapText(body, 10, 'regular', CONTENT_WIDTH - 28);
    const height = 30 + lines.length * 14.5;
    ensure(height + 12);
    doc.rect(MARGIN_X, y, CONTENT_WIDTH, height, { fill: PANEL });
    doc.rect(MARGIN_X, y, 3, height, { fill: tone || ACCENT });
    doc.drawTextLine(title, { x: MARGIN_X + 14, y: y + 12, size: 10, font: 'bold', color: INK });
    let inner = y + 30;
    for (const line of lines) {
      doc.drawTextLine(line, { x: MARGIN_X + 14, y: inner, size: 10, color: INK_SOFT });
      inner += 14.5;
    }
    y += height + 16;
  }

  return {
    startPage,
    footer,
    ensure,
    heading,
    subheading,
    paragraph,
    bullets,
    panel,
    get y() { return y; },
    set y(value) { y = value; },
    get pageNumber() { return pageNumber; },
  };
}

// The workflow diagram, drawn as vectors so it stays sharp in print - never a screenshot.
function drawWorkflowDiagram(doc, layout) {
  const boxW = CONTENT_WIDTH;
  const boxH = 30;
  const gap = 13;

  function node(title, subtitle, { tone = null, indent = 0 } = {}) {
    layout.ensure(boxH + gap + 8);
    const x = MARGIN_X + indent;
    const w = boxW - indent;
    doc.rect(x, layout.y, w, boxH, { fill: PANEL, stroke: BORDER, lineWidth: 0.7 });
    if (tone) doc.rect(x, layout.y, 3, boxH, { fill: tone });
    doc.drawTextLine(title, { x: x + 14, y: layout.y + 11, size: 10, font: 'bold', color: INK });
    if (subtitle) doc.drawTextLine(subtitle, { x: x + 150, y: layout.y + 11, size: 8.5, color: INK_FAINT });
    layout.y += boxH;
  }

  function arrow(label) {
    layout.ensure(gap + 8);
    const cx = MARGIN_X + 22;
    doc.line(cx, layout.y, cx, layout.y + gap, { color: BORDER, lineWidth: 1.2 });
    if (label) doc.drawTextLine(label, { x: cx + 12, y: layout.y + gap - 2, size: 7.5, color: INK_FAINT });
    layout.y += gap;
  }

  for (let i = 0; i < PRIMARY_FLOW.length; i += 1) {
    const stage = getStage(PRIMARY_FLOW[i]);
    const tone = stage.kind === 'gate' ? WARN : stage.kind === 'boundary' ? STOP : stage.kind === 'agent' ? ACCENT : null;
    node(stage.title, stage.kind === 'agent' ? 'specialist agent' : stage.kind, { tone });
    if (i < PRIMARY_FLOW.length - 1) {
      const next = getStage(PRIMARY_FLOW[i + 1]);
      arrow(next.kind === 'gate' ? 'must pass this gate' : '');
    }
  }

  layout.y += 18;
  layout.subheading('The growth loop');
  for (let i = 0; i < GROWTH_LOOP.length; i += 1) {
    node(getStage(GROWTH_LOOP[i]).title, 'specialist agent', { tone: ACCENT, indent: 12 });
    if (i < GROWTH_LOOP.length - 1) arrow('');
  }
  layout.ensure(24);
  doc.drawTextLine('(loops back to Marketing, so the next cycle starts from what actually happened)', {
    x: MARGIN_X + 34,
    y: layout.y + 12,
    size: 8.5,
    color: INK_FAINT,
  });
  layout.y += 26;
}

function buildWorkflowDocument({ generatedAt = new Date() } = {}) {
  const doc = createPdfDocument({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
  const layout = createLayout(doc);

  // ---- 1. Cover -------------------------------------------------------------------
  layout.startPage();
  doc.rect(0, 0, PAGE_WIDTH, 250, { fill: INK });
  doc.rect(0, 246, PAGE_WIDTH, 4, { fill: ACCENT });
  doc.drawTextLine(PRODUCT_NAME, { x: MARGIN_X, y: 92, size: 34, font: 'bold', color: [1, 1, 1] });
  doc.drawTextLine(DOCUMENT_TITLE, { x: MARGIN_X, y: 140, size: 15, color: [0.78, 0.82, 0.89] });
  doc.drawTextLine('A guide to how your AI sales team works, what it decides, and where you stay in control.', {
    x: MARGIN_X,
    y: 176,
    size: 10,
    color: [0.6, 0.66, 0.76],
  });
  layout.y = 300;
  layout.paragraph(
    `${PRODUCT_NAME} is an AI sales operating system for your store. You give it a business goal in your own words; it works out which of its specialists are needed, runs them in the right order, checks the result against policy, and brings anything consequential back to you for a decision.`,
    { size: 11 }
  );
  layout.panel(
    'Two things this document will keep repeating',
    'Nothing reaches your store without your approval, and nothing is invented. Where a figure does not exist, this system says so instead of estimating one.'
  );
  layout.y = PAGE_HEIGHT - 130;
  doc.line(MARGIN_X, layout.y, PAGE_WIDTH - MARGIN_X, layout.y, { color: BORDER, lineWidth: 0.5 });
  doc.drawTextLine(`Prepared ${generatedAt.toISOString().slice(0, 10)}`, { x: MARGIN_X, y: layout.y + 20, size: 9, color: INK_FAINT });

  // ---- 2. What it does ------------------------------------------------------------
  layout.footer();
  layout.startPage();
  layout.heading('What AVENLY AI does');
  layout.paragraph(
    'Most tools give you another dashboard to operate. This one takes an objective and does the work behind it - research, product selection, search visibility, listing content, marketing strategy, channel activity and performance analysis - as one coordinated team rather than eight disconnected features.'
  );
  layout.subheading('What you do');
  layout.bullets([
    'State a goal in plain language. You never choose which agent should handle it.',
    'Review what comes back, with the evidence behind it.',
    'Approve, or decline, anything that would touch your live store.',
  ]);
  layout.subheading('What it does');
  layout.bullets([
    'Decides which specialists your goal actually needs, and runs only those.',
    'Gathers real evidence and keeps each finding attached to its source.',
    'Says plainly when something could not be established.',
    'Stops at every gate that requires a human decision.',
  ]);

  // ---- 3. High-level architecture -------------------------------------------------
  layout.heading('High-level architecture');
  layout.paragraph(
    'One coordinator, seven specialists, and two gates that everything consequential must pass through. The coordinator is the only entry point; the specialists never act around it, and neither gate can be skipped.'
  );
  const agents = getAgentStages();
  layout.bullets([
    'Chief / Orchestrator - understands the goal, plans the work, enforces permissions and cost limits.',
    ...agents.map((agent) => `${agent.title} - ${agent.purpose.replace(/^To /, '').replace(/\.$/, '')}.`),
    'Compliance - policy and intellectual-property checks, with a verdict of PASS, REVIEW or BLOCK.',
    'Human approval - your decision, recorded, and separate from compliance.',
  ]);

  // ---- 4. Complete workflow diagram -----------------------------------------------
  layout.footer();
  layout.startPage();
  layout.heading('The complete workflow');
  layout.paragraph(CONDITIONAL_NOTE);
  drawWorkflowDiagram(doc, layout);

  // ---- 5-15. Every stage, in order ------------------------------------------------
  const detailOrder = ['chief', 'research', 'product', 'seo', 'listing', 'marketing', 'social_advertising', 'analytics_optimization', 'compliance', 'approval', 'platform_action'];
  for (const key of detailOrder) {
    const stage = getStage(key);
    layout.footer();
    layout.startPage();
    layout.heading(stage.title);
    layout.subheading('Why it exists');
    layout.paragraph(stage.purpose);
    layout.subheading('What it does');
    layout.paragraph(stage.does);
    layout.subheading('What it receives');
    layout.bullets(stage.inputs);
    layout.subheading('What it produces');
    layout.bullets(stage.outputs);
    layout.subheading('What happens next');
    layout.paragraph(stage.nextStep);
    if (Array.isArray(stage.verdicts)) {
      layout.subheading('Possible outcomes');
      for (const verdict of stage.verdicts) {
        const tone = /BLOCK|rejected/i.test(verdict.id) ? STOP : /REVIEW|pending/i.test(verdict.id) ? WARN : OK;
        layout.panel(verdict.label, verdict.meaning, { tone });
      }
    }
  }

  // ---- 16. Research -> Product -> SEO -> Listing ----------------------------------
  layout.footer();
  layout.startPage();
  layout.heading('From research to a finished listing');
  layout.paragraph(
    'These four agents form the chain that turns a market observation into something you could actually sell. Each one hands the next a result plus the evidence behind it, so nothing further down the chain rests on an assumption made further up.'
  );
  layout.bullets([
    'Research finds what is happening, and keeps every source.',
    'Product decides which of those findings suit your catalogue, and why.',
    'SEO works out how the product would be found.',
    'Listing writes the content - and names any product fact nobody has established.',
  ]);
  layout.panel(
    'Where this chain stops',
    'It stops at a draft. A listing draft is a proposal: it goes through compliance, then to you. Nothing is published as part of this chain.'
  );

  // ---- 17. Marketing -> Social -> Analytics loop -----------------------------------
  layout.heading('The growth loop');
  layout.paragraph(
    'Marketing sets the strategy. Social & Advertising turns it into channel activity, within the permissions it has. What actually happens produces performance data, Analytics & Optimization reads it, and the recommendations feed the next cycle of strategy.'
  );
  layout.bullets([
    'Marketing strategy -> Social & Advertising execution',
    'Execution -> performance data',
    'Performance data -> Analytics & Optimization',
    'Recommendations -> back into Marketing strategy',
  ]);
  layout.panel(
    'What the loop will not claim',
    'A cycle only reports activity that the record says happened. Where nothing has run yet, the loop shows as not run rather than as a plan already in motion.'
  );

  // ---- 18. Evidence and transparency ----------------------------------------------
  layout.footer();
  layout.startPage();
  layout.heading('Evidence and transparency');
  layout.paragraph(
    'Every product recommendation can be opened up. Rather than a score you have to trust, you get the chain that produced it - and you can see exactly where it is thin.'
  );
  for (const link of EVIDENCE_CHAIN) {
    layout.subheading(link.title);
    layout.paragraph(link.description, { space: 6 });
  }
  layout.panel(
    'A source counts only if a search returned it',
    'A web address is treated as evidence because the search provider actually returned it - never because the AI mentioned it in a sentence. Anything that fails that check is dropped rather than kept with a caveat.'
  );

  // ---- 19. Unavailable information -------------------------------------------------
  layout.heading('When information is not available');
  layout.paragraph(
    'This system connects to no search-volume provider, trend API or marketplace-insights feed. So there are figures it genuinely cannot know, and it will not estimate them for you.'
  );
  layout.subheading('It will never invent');
  layout.bullets([
    'Search volume, market size or growth percentages',
    'Sales, revenue, profit or buyer counts',
    'Competitor sales or competition percentages',
  ]);
  layout.panel('What you will see instead', UNAVAILABLE_TEXT, { tone: WARN });
  layout.paragraph(
    'An unavailable figure is shown as unavailable - never as zero. Zero is a measurement, and reporting one where nothing was measured would be a false statement about your market. Where fewer opportunities are supported by evidence than you asked for, you are given the smaller number rather than a padded list.',
    { space: 6 }
  );

  // ---- 20. Multi-provider AI --------------------------------------------------------
  layout.footer();
  layout.startPage();
  layout.heading('The AI behind it');
  layout.paragraph(
    'AVENLY AI is not tied to a single AI provider. Two leading models are supported as first-class reasoning engines, and the system can be pointed at either without changing how it works.'
  );
  layout.bullets([
    'Claude - Anthropic\'s model family.',
    'Gemini - Google\'s model family.',
  ]);
  layout.paragraph(
    'This matters for you in two practical ways: your business is not dependent on one vendor\'s availability or pricing, and when one provider is unavailable the system reports that plainly rather than quietly switching and giving you a result you did not ask for.',
    { space: 6 }
  );

  // ---- 21. Search architecture ------------------------------------------------------
  layout.heading('How it searches the web');
  layout.paragraph(
    'Which AI reasons and which service searches are two separate choices, configured independently, so a limit on one never forces a change to the other.'
  );
  layout.bullets([
    'Tavily - a dedicated search service that retrieves real pages, which the AI then reasons over.',
    'Model-native search - where a provider offers its own search, that can be used instead.',
  ]);
  layout.panel(
    'Retrieval and reasoning stay separate',
    'The search service decides what the sources are. The AI reads them and forms an assessment. Keeping those two jobs apart is what makes it possible to prove where a claim came from.'
  );

  // ---- 22. Permissions, security and approval ---------------------------------------
  layout.footer();
  layout.startPage();
  layout.heading('Permissions, security and approval');
  layout.subheading('Least privilege');
  layout.paragraph('Each specialist is granted only the access its own work requires, and cannot reach beyond it.');
  layout.subheading('Read-only where it should be');
  layout.paragraph('Your Etsy shop is connected for reading only. The system holds no ability to create, change or publish an Etsy listing, and no such capability is present to be switched on by mistake.');
  layout.subheading('Credentials');
  layout.paragraph('Store and provider credentials are held server-side, are never shown in the dashboard, and never appear in a result, a report or this document.');
  layout.subheading('Two gates, not one');
  layout.paragraph('Compliance and human approval are independent. A compliance PASS means no blocking risk was found - it is not permission. Only your approval is permission, and it is asked for separately every time.');
  layout.subheading('A record of everything');
  layout.paragraph('Runs, decisions, approvals and compliance verdicts are recorded, so any result can be traced back to what produced it.');

  // ---- 23. Multi-business architecture -----------------------------------------------
  layout.heading('Built for more than one business');
  layout.paragraph(
    'The system is configured per business rather than built around one. A second store brings its own configuration, its own connected channels and its own credentials, and its data stays separate from every other business\'s.'
  );
  layout.bullets([
    'Business rules and thresholds are configuration, not code.',
    'One business\'s history, evidence and approvals never appear in another\'s.',
    'Adding a channel is a configuration change, not a rebuild.',
  ]);

  // ---- 24. Closing ---------------------------------------------------------------------
  layout.footer();
  layout.startPage();
  layout.heading('In summary');
  layout.paragraph(
    `${PRODUCT_NAME} gives you a coordinated AI sales team that starts from your goal rather than your tooling. It researches with real sources, recommends with stated reasons, prepares work you can review, and stops at every point where a person should decide.`
  );
  layout.bullets([
    'You state goals; it decides which specialists to use.',
    'Findings carry their sources; unknowns are named, not filled in.',
    'Compliance and your approval are two separate gates, and both must pass.',
    'Nothing reaches your store without your decision.',
  ]);
  layout.panel(
    'The status you see is the status that happened',
    'The workflow map in your dashboard shows the real state of your own run. A step reads as completed only because it completed. With nothing running, every step reads as not run.'
  );
  layout.footer();

  return doc.toBuffer();
}

// The sections a customer must find in the document. Exported so the test suite pins them
// rather than re-listing them in a second place.
const REQUIRED_SECTIONS = [
  PRODUCT_NAME,
  DOCUMENT_TITLE,
  'What AVENLY AI does',
  'High-level architecture',
  'The complete workflow',
  ...['chief', 'research', 'product', 'seo', 'listing', 'marketing', 'social_advertising', 'analytics_optimization', 'compliance', 'approval', 'platform_action'].map((key) => getStage(key).title),
  'From research to a finished listing',
  'The growth loop',
  'Evidence and transparency',
  'When information is not available',
  'The AI behind it',
  'How it searches the web',
  'Permissions, security and approval',
  'Built for more than one business',
  'In summary',
];

module.exports = {
  buildWorkflowDocument,
  REQUIRED_SECTIONS,
  DOCUMENT_FILENAME: 'AVENLY-AI-How-Your-AI-Sales-Operating-System-Works.pdf',
};

if (require.main === module) {
  const buffer = buildWorkflowDocument();
  process.stdout.write(`Generated ${buffer.length} bytes across the customer workflow document.\n`);
  process.stdout.write(`Required sections: ${REQUIRED_SECTIONS.length}\n`);
  process.stdout.write(`States documented: ${Object.values(NODE_STATES).map((s) => s.label).join(', ')}\n`);
}
