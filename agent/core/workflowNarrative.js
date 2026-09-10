'use strict';

// The customer-facing description of how AVENLY AI works - ONE definition, read by both the
// dashboard workflow graph and the downloadable PDF, so the two can never drift apart.
//
// THIS IS A PRESENTATION LAYER, NOT AN ENGINE. It executes nothing, stores nothing and
// decides nothing. It holds the words a customer reads, plus a pure mapping from the
// EXISTING execution vocabulary (agent/core/stateModel.js's TASK_STATUSES,
// compliance/compliancePolicy.js's COMPLIANCE_STATUSES,
// approvals/approvalRequestModel.js's APPROVAL_REQUEST_STATUSES) onto the labels a customer
// sees. There is no second orchestrator, state engine, approval system or agent registry
// here - see deriveWorkflowState, which only READS a run record that already exists.
//
// THE AGENT LIST IS NOT RETYPED. The seven specialists come from
// agent/core/specialistRegistry.js, so an agent cannot appear here that the system does not
// actually have, and a renamed agent cannot go stale in the customer's documentation.
//
// STATUS IS NEVER FLATTERED. A node is "Completed" only when the run record says that step
// completed. With no run at all, everything is "Not Run" - never a demo state, never a
// hard-coded green.

const { getSpecialistRegistry } = require('./specialistRegistry');
const { TASK_STATUSES } = require('./stateModel');

const PRODUCT_NAME = 'AVENLY AI';
const DOCUMENT_TITLE = 'How Your AI Sales Operating System Works';

// What a customer sees. Deliberately a small, closed vocabulary - see NODE_STATES' own
// `meaning`, which is the sentence shown wherever the state needs explaining.
const NODE_STATES = {
  completed: { id: 'completed', label: 'Completed', tone: 'ok', meaning: 'This step ran and finished in the current run.' },
  running: { id: 'running', label: 'Running', tone: 'active', meaning: 'This step is executing right now.' },
  waiting: { id: 'waiting', label: 'Waiting', tone: 'warn', meaning: 'This step is waiting on a decision before it can continue.' },
  needs_information: { id: 'needs_information', label: 'Needs information', tone: 'warn', meaning: 'This step needs information nobody has supplied yet.' },
  blocked: { id: 'blocked', label: 'Blocked', tone: 'error', meaning: 'This step could not proceed. The reason is shown with the step.' },
  not_run: { id: 'not_run', label: 'Not run', tone: 'idle', meaning: 'This step has not run in the current run.' },
};

// The EXISTING execution vocabulary -> the customer-facing vocabulary. Every value of
// TASK_STATUSES is mapped explicitly; assertTaskStatusCoverage below fails loudly if the
// execution model ever gains a status this mapping does not know, rather than letting an
// unmapped status quietly render as "Not run".
const TASK_STATUS_TO_NODE_STATE = {
  complete: 'completed',
  in_progress: 'running',
  blocked: 'blocked',
  // A step that failed cannot proceed, which is what "Blocked" means to a customer. The
  // real reason always travels with it, so nothing is hidden by the shared label.
  failed: 'blocked',
  not_started: 'not_run',
};

function assertTaskStatusCoverage() {
  const unmapped = TASK_STATUSES.filter((status) => !TASK_STATUS_TO_NODE_STATE[status]);
  if (unmapped.length > 0) {
    throw new Error(
      `workflowNarrative.js does not map these execution statuses to a customer-facing state: ${unmapped.join(', ')}. ` +
        'Add them to TASK_STATUS_TO_NODE_STATE rather than letting them render as "Not run".'
    );
  }
  return true;
}

// Customer-facing copy for each stage. `specialistId` ties a stage to the real registry
// entry; a stage with no specialistId is a gate or a boundary, not an agent.
const STAGE_DEFINITIONS = [
  {
    key: 'goal',
    title: 'Your goal',
    kind: 'input',
    specialistId: null,
    purpose: 'Everything starts with what you actually want to achieve, in your own words.',
    does: 'You describe a business outcome - not a tool, not a setting. You never have to pick which AI agent should handle it.',
    inputs: ['The goal you type', 'Your connected stores and business configuration'],
    outputs: ['A stated objective the Chief can plan against'],
    nextStep: 'Chief / Orchestrator',
  },
  {
    key: 'chief',
    title: 'Chief / Orchestrator',
    kind: 'orchestrator',
    specialistId: null,
    purpose: 'One coordinator that understands your goal and decides how it should be handled.',
    does:
      'Reads your goal, works out which specialists it actually needs, and runs them in the right order. It enforces permissions and cost limits on every specialist\'s behalf, and keeps the work pointed at your objective.',
    inputs: ['Your stated goal', 'Prior results in this session', 'Your business configuration'],
    outputs: ['A plan of which specialists run, in which order', 'Coordinated results gathered back into one answer'],
    nextStep: 'Whichever specialists the goal actually needs',
  },
  {
    key: 'research',
    title: 'Research',
    kind: 'agent',
    specialistId: 'research',
    purpose: 'To find out what is really happening in your market, from real sources.',
    does:
      'Researches markets, competitors and trends, and collects the evidence behind each finding. It separates what it verified from what it simply could not establish, and it does not fill the gaps with invented market data.',
    inputs: ['Your market and catalogue context', 'Live web search results'],
    outputs: ['Findings, each carrying the source it came from', 'An explicit list of what could not be established'],
    nextStep: 'Product',
  },
  {
    key: 'product',
    title: 'Product',
    kind: 'agent',
    specialistId: 'product',
    purpose: 'To turn market research into product opportunities that suit your business specifically.',
    does:
      'Identifies opportunities, checks them against the evidence available, ranks them, and explains why each one was recommended. It never invents demand, sales, revenue or market-size figures.',
    inputs: ['Research findings and their sources', 'Your existing catalogue'],
    outputs: ['Ranked product opportunities', 'The reason each one fits your business'],
    nextStep: 'SEO',
  },
  {
    key: 'seo',
    title: 'SEO',
    kind: 'agent',
    specialistId: 'seo',
    purpose: 'To make sure the products you sell can actually be found.',
    does:
      'Works from the keyword evidence available, sets the search direction, and improves titles, descriptions and search relevance - without stepping outside what the evidence supports.',
    inputs: ['A validated product opportunity', 'Keyword and search evidence where available'],
    outputs: ['Search direction and keyword guidance', 'Suggested title and description improvements'],
    nextStep: 'Listing',
  },
  {
    key: 'listing',
    title: 'Listing',
    kind: 'agent',
    specialistId: 'listing',
    purpose: 'To write the listing a customer would actually read.',
    does:
      'Composes listing content from the product facts that genuinely exist. Where a fact has never been established - file formats, licence terms, delivery - it says so and asks, instead of writing something plausible.',
    inputs: ['The product opportunity', 'SEO direction', 'Established product facts'],
    outputs: ['A listing draft', 'A named list of any facts still missing'],
    nextStep: 'Compliance',
  },
  {
    key: 'marketing',
    title: 'Marketing',
    kind: 'agent',
    specialistId: 'marketing',
    purpose: 'To decide how a product should be taken to market.',
    does:
      'Develops the growth strategy - campaigns, positioning, offers and direction. It concentrates on strategy rather than carrying out every external action itself.',
    inputs: ['Product and listing context', 'Analytics recommendations from previous cycles'],
    outputs: ['Campaign and positioning strategy', 'Offers and marketing direction'],
    nextStep: 'Social & Advertising',
  },
  {
    key: 'social_advertising',
    title: 'Social & Advertising',
    kind: 'agent',
    specialistId: 'social_advertising',
    purpose: 'To turn marketing strategy into activity on real channels.',
    does:
      'Plans and, where it is permitted to, carries out social and advertising activity. It works inside the permissions it has been given, and anything consequential still waits for your approval.',
    inputs: ['Marketing strategy', 'Channel permissions'],
    outputs: ['Channel plans and content', 'Proposed advertising activity'],
    nextStep: 'Analytics & Optimization',
  },
  {
    key: 'analytics_optimization',
    title: 'Analytics & Optimization',
    kind: 'agent',
    specialistId: 'analytics_optimization',
    purpose: 'To learn from what actually happened and make the next cycle better.',
    does:
      'Analyses the performance data available, finds where things can improve, and produces optimization recommendations that feed back into future strategy.',
    inputs: ['Store performance data', 'Results of previous activity'],
    outputs: ['Performance analysis', 'Optimization recommendations for the next cycle'],
    nextStep: 'Back into Marketing strategy, as the next cycle begins',
    feedsBackTo: 'marketing',
  },
  {
    key: 'compliance',
    title: 'Compliance',
    kind: 'gate',
    specialistId: null,
    purpose: 'To catch policy, intellectual-property and content risk before anything reaches a person to approve.',
    does:
      'Checks content against policy and IP risk and returns one of three verdicts. It fails closed: an ambiguous intellectual-property or policy risk is never treated as safe, and content is never reworded simply to get past a check.',
    inputs: ['The prepared content', 'The evidence behind it'],
    outputs: ['A verdict of PASS, REVIEW or BLOCK', 'The specific reasons behind that verdict'],
    nextStep: 'Human approval - which is a separate decision',
    verdicts: [
      { id: 'PASS', label: 'PASS', meaning: 'No blocking risk was found. This alone does not authorise anything.' },
      { id: 'REVIEW', label: 'REVIEW', meaning: 'Something needs a person to look at it before it goes further.' },
      { id: 'BLOCK', label: 'BLOCK', meaning: 'This cannot proceed. Protected marks and prohibited content stop here.' },
    ],
  },
  {
    key: 'approval',
    title: 'Human approval',
    kind: 'gate',
    specialistId: null,
    purpose: 'To keep every consequential decision with you.',
    does:
      'Presents the proposed action, what it is based on, and anything still unknown - then waits. Compliance passing is not approval: they are two separate gates, and both must be satisfied.',
    inputs: ['The proposed action', 'Its compliance verdict', 'Any outstanding unknowns'],
    outputs: ['Your decision, recorded'],
    nextStep: 'Platform action, only once approved',
    verdicts: [
      { id: 'pending', label: 'Pending', meaning: 'Waiting for your decision. Nothing has happened yet.' },
      { id: 'approved', label: 'Approved', meaning: 'You approved it. It may proceed if every other gate is also satisfied.' },
      { id: 'rejected', label: 'Rejected', meaning: 'You declined. It cannot proceed.' },
    ],
  },
  {
    key: 'platform_action',
    title: 'Platform action',
    kind: 'boundary',
    specialistId: null,
    purpose: 'The line between planning and anything that touches your live store.',
    does:
      'Nothing crosses into your Shopify or Etsy store unless it is a permitted action that has cleared both gates. Etsy is connected for reading only - this system holds no ability to publish or change an Etsy listing.',
    inputs: ['An approved, compliant action'],
    outputs: ['A recorded action, within the permissions granted'],
    nextStep: 'Results return to Analytics & Optimization for the next cycle',
  },
];

// The primary path, plus the loop. Rendered as a graph, never as a promise that every goal
// runs every stage - see CONDITIONAL_NOTE.
const PRIMARY_FLOW = ['goal', 'chief', 'research', 'product', 'seo', 'listing', 'compliance', 'approval', 'platform_action'];
const GROWTH_LOOP = ['marketing', 'social_advertising', 'analytics_optimization'];

const CONDITIONAL_NOTE =
  'The Chief runs only the specialists your goal actually needs. A pricing question does not run the Listing agent; a listing question does not run Advertising. The map below shows every stage that can run - the status on each one shows what really ran for you.';

const EVIDENCE_CHAIN = [
  { key: 'research_evidence', title: 'Research evidence', description: 'The sources found for this opportunity, each a real page the search returned.' },
  { key: 'customer_fit', title: 'Fit with your catalogue', description: 'Why this belongs alongside what you already sell.' },
  { key: 'opportunity_evaluation', title: 'Opportunity evaluation', description: 'What the research established about demand, competition, trend and commercials - and what it could not.' },
  { key: 'compliance', title: 'Compliance', description: 'The policy and IP verdict for this opportunity.' },
  { key: 'preparation', title: 'SEO and listing preparation', description: 'What has been prepared so far, and what is still missing.' },
];

// The exact sentence shown wherever a figure does not exist. One constant, so the promise is
// identical everywhere a customer might look.
const UNAVAILABLE_TEXT = 'Not available from the connected research sources.';
const UNAVAILABLE_FOR_RUN_TEXT = 'Unavailable for this run.';

function getStage(key) {
  return STAGE_DEFINITIONS.find((stage) => stage.key === key) || null;
}

// The seven specialists, as the system actually defines them. Throws rather than silently
// describing an agent this project does not have.
function getAgentStages() {
  const registry = getSpecialistRegistry();
  return STAGE_DEFINITIONS.filter((stage) => stage.kind === 'agent').map((stage) => {
    const specialist = registry.find((entry) => entry.id === stage.specialistId);
    if (!specialist) {
      throw new Error(`workflowNarrative.js describes an agent '${stage.specialistId}' that agent/core/specialistRegistry.js does not define.`);
    }
    return { ...stage, registryTitle: specialist.title, registryDescription: specialist.description };
  });
}

function nodeStateForTaskStatus(taskStatus) {
  return TASK_STATUS_TO_NODE_STATE[taskStatus] || 'not_run';
}

// The whole customer-facing definition, as one payload for the dashboard.
//
// It exists so server.js can serve this WITHOUT naming STAGE_DEFINITIONS - an identifier
// that also belongs to agent/core/growthWorkflowOrchestrator.js's real execution stages.
// verification/testing/workflowOrchestratorEndpoints.test.js guards server.js against
// shared execution identifiers precisely so nobody reimplements orchestration there, and
// that guard is worth more than the convenience of reading the property directly.
function getCustomerWorkflowDefinition() {
  return {
    stage_definitions: STAGE_DEFINITIONS,
    primary_flow: PRIMARY_FLOW,
    growth_loop: GROWTH_LOOP,
    conditional_note: CONDITIONAL_NOTE,
    evidence_chain: EVIDENCE_CHAIN,
    node_states: NODE_STATES,
    unavailable_text: UNAVAILABLE_TEXT,
  };
}

module.exports = {
  PRODUCT_NAME,
  DOCUMENT_TITLE,
  NODE_STATES,
  TASK_STATUS_TO_NODE_STATE,
  STAGE_DEFINITIONS,
  PRIMARY_FLOW,
  GROWTH_LOOP,
  CONDITIONAL_NOTE,
  EVIDENCE_CHAIN,
  UNAVAILABLE_TEXT,
  UNAVAILABLE_FOR_RUN_TEXT,
  getStage,
  getAgentStages,
  nodeStateForTaskStatus,
  getCustomerWorkflowDefinition,
  assertTaskStatusCoverage,
};

if (require.main === module) {
  assertTaskStatusCoverage();
  console.log(`${PRODUCT_NAME} - ${DOCUMENT_TITLE}\n`);
  console.log(`Primary flow: ${PRIMARY_FLOW.join(' -> ')}`);
  console.log(`Growth loop:  ${GROWTH_LOOP.join(' -> ')} -> back to marketing\n`);
  for (const stage of STAGE_DEFINITIONS) {
    console.log(`${stage.title} (${stage.kind})`);
    console.log(`  ${stage.purpose}`);
  }
  console.log(`\nCustomer-facing states: ${Object.values(NODE_STATES).map((s) => s.label).join(', ')}`);
  console.log('Every execution status is mapped:', assertTaskStatusCoverage());
}
