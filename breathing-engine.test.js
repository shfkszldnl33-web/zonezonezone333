/*
 * Node entry point: `node tests/breathing-engine.test.js`
 * The actual test bodies live in breathing-engine.tests.core.js so the same tests can also run
 * in a browser via tests/run-tests.html (useful in environments with no Node installed).
 */
'use strict';

const path = require('path');
const BreathingEngine = require(path.join(__dirname, '..', 'breathing-engine.js'));
const BreathingEngineTests = require(path.join(__dirname, 'breathing-engine.tests.core.js'));

const result = BreathingEngineTests.runAll(BreathingEngine, function (line) { console.log(line); });
if (result.failed > 0) process.exit(1);
