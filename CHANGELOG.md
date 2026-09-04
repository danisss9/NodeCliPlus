# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-04

Initial release.

### Added

- **Project model** — the workspace root `package.json` is always a project; every [npm workspace](https://docs.npmjs.com/cli/using-npm/workspaces) package becomes one too. Project pickers offer *Current project* (detected from the active editor file) and *Last used* entries, and remember the choice per command.
- **Keyboard shortcuts** — all commands bound under the `Ctrl+Shift+N` chord.
- **Run & debug commands**
  - `Node: Debug Application` (`Ctrl+Shift+N` `D`) — smart debug: attaches the browser debugger when the project depends on a web-server framework (express, fastify, nest, vite, ...), otherwise launches the script under the VS Code Node.js debugger.
  - `Node: Debug Build (Watch)` (`Ctrl+Shift+N` `H`) — runs the build-watch script, serves the output with a static server, and attaches the browser debugger.
  - `Node: Serve Application` (`Ctrl+Shift+N` `S`) — runs the dev/serve/start script in a managed terminal.
  - `Node: Restart Serve` (`Ctrl+Shift+N` `R`) — restarts a running serve/watch terminal and re-attaches its debug session.
  - `Node: Build Project` (`Ctrl+Shift+N` `B`) and `Node: Build Project (Watch)` (`Ctrl+Shift+N` `W`).
  - `Node: Test Project` (`Ctrl+Shift+N` `T`) — runs the test script, offers "current test file only" when a test file is open.
  - `Node: Lint Project` (`Ctrl+Shift+N` `L`) — runs ESLint directly and shows results in a webview (group by file/rule, filters, `eslint --fix` buttons).
  - `Node: Update Packages` (`Ctrl+Shift+N` `U`) — npm-check-updates webview: pick packages, update package.json + install.
  - `Node: Run npm Script` (`Ctrl+Shift+N` `N`) — QuickPick over every npm script of every project.
- **Analysis tools**
  - `Node: Check Build Errors` (`Ctrl+Shift+N` `E`) — runs the build, parses tsc/esbuild/generic diagnostics into a webview with clickable file:line links.
  - `Node: Check Memory Leaks` (`Ctrl+Shift+N` `K`) — AST scan for Node-flavoured leaks: uncleared intervals/timeouts, unremoved listeners, un-unsubscribed RxJS subscriptions, nested subscribes, retained DOM refs, incomplete `takeUntil` Subjects.
  - `Node: Switch Source/Test File` (`Ctrl+Shift+N` `Tab`) — jumps between `foo.ts` and `foo.test.ts` / `foo.spec.js` / ...
  - `Node: Manage JSON Configs` (`Ctrl+Shift+N` `J`) — webview editors for ESLint rules and tsconfig compiler options (comments preserved).
  - `Node: Setup .npmrc Auth Tokens` (`Ctrl+Shift+N` `A`) — copies registry auth tokens from the workspace `.npmrc` into the global `~/.npmrc`.
- **Housekeeping**
  - `npm: Install` / `npm: Clean Install` — `npm install`, with escalation prompts (clean → `--force`).
  - `Check Dependencies` — verifies `node_modules` matches package.json on startup and branch switch.
  - `Check Tool Versions` — verifies node/npm/yarn/pnpm against the `engines` field.
  - `Close Terminals` (`Ctrl+Shift+N` `C`) — multi-select close of extension-managed terminals.
- **Debug modes** — `nodeCliPlus.debug.mode` selects how Debug Application starts: `auto` (default), `browser` (waits for the port parsed from `PORT=`/`--port`/`-p` in the script, then launches Chrome/Edge/Firefox/Brave/Opera/Safari with DevTools attached), or `node` (launches `npm run <script>` under VS Code's built-in Node.js debugger).
- **AI auto-fix** — the Memory Leaks and Build Errors webviews show an **Auto Fix** button per issue and per file. It opens GitHub Copilot Chat or the Claude Code panel with a ready-made fix prompt (clipboard fallback). Configurable via `nodeCliPlus.ai.provider` (`copilot` (default) or `claude`) and `nodeCliPlus.ai.autoFixEnabled`.
- **Status bar** — a **Node CLI +** button that opens the command palette filtered to this extension.
- **Settings** — `nodeCliPlus.debug.*`, `nodeCliPlus.buildWatch.*`, `nodeCliPlus.test.watch`, `nodeCliPlus.checkDependencies.enabled`, `nodeCliPlus.checkToolVersions.enabled`, `nodeCliPlus.npm.installCommand`, `nodeCliPlus.npm.cleanInstallCommand`, and `nodeCliPlus.ai.*`.
- **Tests** — unit test suite via `@vscode/test-cli`.
- **CI/CD** — GitHub Actions release workflow: run tests, package the VSIX, and publish to the Visual Studio Marketplace.
