'use strict';

// The ordered lifecycle stages of the ONE Smart E-Commerce Growth AI Agent.
// This defines WHAT the agent conceptually does, and in what order - not HOW.
// No stage here performs real work: no tool execution, no AI API calls, no
// autonomous looping. Those begin in later, explicitly-scoped prompts.
const AGENT_CONTRACT = [
  {
    id: 'understand_objective',
    title: "Understand the user's objective",
    description:
      'Parse and clarify what the user is asking the agent to accomplish before any work begins.',
  },
  {
    id: 'inspect_configuration',
    title: 'Inspect relevant configuration',
    description:
      'Read the business configuration (configuration/business.yaml) needed for the objective.',
  },
  {
    id: 'retrieve_context',
    title: 'Retrieve relevant context',
    description:
      'Gather supporting information the objective needs, e.g. from data/business/ or research/.',
  },
  {
    id: 'inspect_memory_state',
    title: 'Inspect memory/state',
    description:
      'Check persisted progress and prior context in memory/state/ relevant to this objective.',
  },
  {
    id: 'identify_required_work',
    title: 'Identify required work',
    description:
      'Determine the concrete steps needed to satisfy the objective, given configuration, context, and state.',
  },
  {
    id: 'select_tools',
    title: 'Select relevant tools',
    description: 'Choose which tool(s) in tools/ are needed to carry out the identified work.',
  },
  {
    id: 'execute_work',
    title: 'Execute work',
    description: 'Carry out the identified work using the selected tools.',
  },
  {
    id: 'verify_results',
    title: 'Verify results',
    description: 'Check that the work produced the expected, correct outcome.',
  },
  {
    id: 'handle_errors',
    title: 'Handle confirmed errors',
    description:
      'When verification finds a confirmed error, respond to it explicitly rather than proceeding silently or guessing.',
  },
  {
    id: 'save_state',
    title: 'Save relevant state',
    description: 'Persist anything the agent should remember for next time to memory/state/.',
  },
  {
    id: 'respond',
    title: 'Respond',
    description: 'Report the outcome back to the user.',
  },
];

function getContract() {
  return AGENT_CONTRACT;
}

module.exports = { AGENT_CONTRACT, getContract };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - core contract (conceptual only):\n');
  AGENT_CONTRACT.forEach((stage, index) => {
    console.log(`${index + 1}. [${stage.id}] ${stage.title}`);
    console.log(`   ${stage.description}`);
  });
}
