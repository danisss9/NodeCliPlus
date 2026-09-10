const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/graph',
  testMatch: '*.spec.cjs',
  workers: 1,
  timeout: 30000,
  outputDir: './.graph-test-results',
  use: { headless: true, viewport: { width: 1280, height: 800 } },
});
