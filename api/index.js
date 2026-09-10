'use strict';

// Vercel serverless entry point.
// Wraps the Express app from server.js (module.exports = { createApp }) as a
// serverless function. Requiring server.js here does not start app.listen()
// because that only runs when server.js is executed directly (see its
// require.main check at the bottom of the file). createApp() is called
// explicitly below instead.

const { createApp } = require('../server');

module.exports = createApp();

