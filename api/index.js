'use strict';

/**
 * Vercel entry point.
 *
 * Vercel runs the app as a serverless function rather than a long-lived server,
 * so this file exports the Express app instead of calling listen(). Every
 * incoming request is routed here by vercel.json.
 *
 * The database schema is created lazily on the first request after a cold start
 * (see the migrate middleware in src/app.js).
 */

const { validateConfig } = require('../src/config/env');
const { createApp } = require('../src/app');

validateConfig();

module.exports = createApp();
