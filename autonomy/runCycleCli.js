'use strict';

// Command-line entry point for ONE autonomous cycle: npm run autonomy:cycle -- --business <id>
//
// For an owner-chosen external scheduler (an OS task scheduler, a hosting cron) to call.
// Every refusal and gate lives in autonomy/cycleTrigger.js; this file only parses arguments
// and prints the result. The printed result holds ids, outcomes and reason codes - never a
// credential. Exit codes: 0 a cycle ran, 2 it was refused, 1 it faulted.

const { triggerAutonomousCycle } = require('./cycleTrigger');

function parseArgs(argv) {
  const args = { businessId: null, errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--business') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.startsWith('--') || value.trim() === '') {
        args.errors.push('--business requires a business id.');
      } else {
        args.businessId = value.trim();
        index += 1;
      }
    } else {
      args.errors.push(`Unknown argument: ${argv[index]}`);
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    console.error(args.errors.join('\n'));
    console.error('Usage: npm run autonomy:cycle -- [--business <id>]');
    return 1;
  }
  try {
    const result = await triggerAutonomousCycle({ businessId: args.businessId });
    console.log(JSON.stringify(result, null, 2));
    return result.triggered ? 0 : 2;
  } catch (err) {
    // The underlying message is not printed - it can carry a path or a third-party detail.
    console.error('The autonomous cycle could not run.');
    return 1;
  }
}

module.exports = { parseArgs, main };

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
