const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/security', testMatch: '*.spec.cjs', workers: 1, timeout: 30000,
  outputDir: './.security-test-results/browser',
  use: { headless: true, viewport: { width: 1280, height: 800 } },
});
