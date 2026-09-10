// The same pure tests run under VS Code's Mocha suite and the standalone Node runner.
const { describe, it } = require('node:test');
global.suite = describe;
global.test = it;
require('../../out/test/security.test.js');
