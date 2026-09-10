# Node CLI Plus

npm script runner, debugger, and project tools for Node.js projects in VS Code — with AI-powered auto-fix support (GitHub Copilot & Claude Code).

Built for plain **package.json** workspaces: the root package is a project, and every [npm workspace](https://docs.npmjs.com/cli/using-npm/workspaces) package becomes one too. Commands that need a project auto-detect it from the active file.

## Keyboard shortcuts

All commands are bound under the `Ctrl+Shift+N` chord. Press `Ctrl+Shift+N`, release, then press the second key.

> **Note:** `Ctrl+Shift+N` is VS Code's default *New Window* binding. This extension's chord takes priority, so use the menu (File → New Window) to open a new window, or remove the chord in Keyboard Shortcuts if you prefer the default behaviour.

### Run & debug

| Command | Shortcut | What it does |
| --- | --- | --- |
| Node: Debug Application | `Ctrl+Shift+N` `D` | Smart debug: attaches the browser debugger when the project depends on a web-server framework (express, fastify, nest, vite, ...), otherwise launches the script under the VS Code Node.js debugger |
| Node: Debug Build (Watch) | `Ctrl+Shift+N` `H` | Runs the build-watch script, serves the output with a static server, and attaches the browser debugger |
| Node: Serve Application | `Ctrl+Shift+N` `S` | Runs the dev/serve/start script in a managed terminal |
| Node: Restart Serve | `Ctrl+Shift+N` `R` | Restarts a running serve/watch terminal and re-attaches its debug session |
| Node: Build Project | `Ctrl+Shift+N` `B` | Runs the build script |
| Node: Build Project (Watch) | `Ctrl+Shift+N` `W` | Runs the build-watch script |
| Node: Test Project | `Ctrl+Shift+N` `T` | Runs the test script — offers "current test file only" when a test file is open |
| Node: Lint Project | `Ctrl+Shift+N` `L` | Runs ESLint directly and shows results in a webview (group by file/rule, filters, `eslint --fix` buttons) |
| Node: Update Packages | `Ctrl+Shift+N` `U` | npm-check-updates webview: pick packages, update package.json + install |
| Node: Run npm Script | `Ctrl+Shift+N` `N` | QuickPick over every npm script of every project |

### Analysis tools

| Command | Shortcut | What it does |
| --- | --- | --- |
| Node: Check Build Errors | `Ctrl+Shift+N` `E` | Runs the build, parses tsc/esbuild/generic diagnostics into a webview with clickable file:line links |
| Node: Check Memory Leaks | `Ctrl+Shift+N` `K` | AST scan for Node-flavoured leaks: uncleared intervals/timeouts, unremoved listeners, un-unsubscribed RxJS subscriptions, nested subscribes, retained DOM refs, incomplete `takeUntil` Subjects |
| Node: Switch Source/Test File | `Ctrl+Shift+N` `Tab` | Jumps between `foo.ts` and `foo.test.ts` / `foo.spec.js` / … |
| Node: Manage JSON Configs | `Ctrl+Shift+N` `J` | Webview editors for ESLint rules and tsconfig compiler options (comments preserved) |
| Node: Setup .npmrc Auth Tokens | `Ctrl+Shift+N` `A` | Copies registry auth tokens from the workspace `.npmrc` into your global `~/.npmrc` |

### Housekeeping

| Command | Shortcut | What it does |
| --- | --- | --- |
| npm: Install / Clean Install | — | `npm install`, with escalation prompts (clean → `--force`) |
| Check Dependencies | — | Verifies `node_modules` matches package.json on startup and branch switch |
| Check Tool Versions | — | Verifies node/npm/yarn/pnpm against the `engines` field |
| Close Terminals | `Ctrl+Shift+N` `C` | Multi-select close of extension-managed terminals |

A **Node CLI +** status bar button opens the command palette filtered to this extension.

## npm Dependency Graph

Run **Node CLI Plus: npm: Show Dependency Graph** with `Ctrl+Shift+N F` (`Cmd+Shift+N F` on macOS). Explore installed dependencies, expand individual packages or **Expand all packages**, search, inspect package details, and find missing peer dependencies. Reset returns to direct dependencies; Refresh reloads the graph. Lockfiles and package declarations provide fallback views when installed data is unavailable.

Use **Security scan** in the graph toolbar to review that workspace.

## Package Security Review

Run **Node CLI Plus: npm: Review Package Security** with `Ctrl+Shift+N V` (`Cmd+Shift+N V` on macOS), from the Command Palette, or using the **Node CLI +** status-bar action. Select a workspace when multiple folders are open. The review also runs after installations started through the extension, including custom npm/Yarn/pnpm commands and failed installations that leave packages behind. Automatic reviews open the report when findings exist or coverage is incomplete; a completed review without findings offers **View Report** in a notification.

The report combines three separate checks:

- **Known malicious packages:** actual installed names and versions checked against a curated, dated catalog derived from easy-dep-graph and verified against linked advisories. It includes nested, scoped, aliased, development, optional, and extraneous installations. The initial catalog contains 11 package entries; it is not a comprehensive malware feed.
- **Vulnerabilities:** `npm audit --json --ignore-scripts`, including development, optional, and peer dependencies. This sends dependency metadata to the configured npm registry and requires an npm lockfile. Yarn/pnpm projects without an npm lockfile still receive local checks; the unavailable audit is reported explicitly.
- **Suspicious script patterns:** local YARA-X scanning of installation hooks, their resolvable local scripts/imports/executable mappings, and bounded encoded payloads. Rules cover entropy, decoding or decryption with dynamic evaluation, suspicious shell execution, download-and-execute commands, credential collection with network activity, and persistence indicators. Common installer capabilities alone receive low-confidence findings.

Use package search and category/severity filters to explore findings, expand evidence to see the lifecycle/reference chain, and use **Open File** to inspect the source. **Rescan**, **Cancel**, and **Save HTML** are available in the report. Exported HTML includes its styles and filtering code and works offline without VS Code.

**Setup:** on first use with script inputs, the extension downloads the official YARA-X **1.20.0** engine, verifies its pinned SHA-256 digest, and caches it in extension storage. Supported managed binaries are Windows x64 and macOS/Linux x64 and arm64 (Linux requires a compatible glibc environment). Remote workspaces use the extension host's platform. A failed download, unsupported platform, or scanner failure leaves an incomplete report with the other checks retained. Cached engines work offline; live npm audit needs network access. Rules and catalog updates ship with extension updates. Third-party notices are included in `resources/security/THIRD_PARTY_NOTICES.txt`.

| Setting                                              | Default | Purpose                                                                                      |
| ---------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `nodeCliPlus.securityReview.afterInstall.enabled` | `true`  | Review after extension-managed installations. Manual terminal installations are not watched. |
| `nodeCliPlus.securityReview.npmAudit.enabled`     | `true`  | Enable registry advisory requests; disable for local checks only.                            |

**Coverage:** reviews require a trusted filesystem workspace and inspect files present after installation. Lifecycle scripts may already have run, removed themselves, or downloaded other payloads. The scanner never executes package code, and it does not monitor processes or prevent installation. It focuses on installation references rather than all package files. Dynamic references, unsupported languages/native builds, external workspace links, missing files, and Yarn PnP layouts are reported as coverage gaps. Preparation hooks are inspected conservatively even when a particular package manager would not invoke them for that package.

Limits are two scanner threads, 120 seconds for YARA-X, 60 seconds for audit, 5 MiB per file, 250 MiB total input, 20,000 inputs/packages, and 32 reference levels. Literal Base64/hex decoding is limited to two layers and 1 MiB per decoded payload. Reaching limits produces an incomplete report. Findings describe indicators and advisory matches; **“No findings detected within the scanned scope”** does not certify a package or machine as safe. There are no automatic removals or fixes.

Security validation commands: `npm run test:security-unit`, `npm run test:security-engine`, and `npm run test:security-webview`. The engine suite downloads the pinned binary and uses inert fixtures plus the installed esbuild installer, without executing scanned scripts. Browser tests require Playwright Chromium (`npx playwright install chromium`).


## Project model

- The workspace root `package.json` is always a project (named after its `name` field, or `root`).
- When it declares `workspaces` (array or `{ packages: [...] }`), each workspace package with a `package.json` becomes an additional project.
- Project pickers offer *Current project* (detected from the active editor file) and *Last used* entries, and remember your choice per command.

## Debug modes

`nodeCliPlus.debug.mode` selects how **Node: Debug Application** starts:

- `auto` *(default)* — web-framework dependency detected → browser mode, otherwise Node inspector.
- `browser` — runs the dev script in a terminal, waits for the port (parsed from `PORT=`/`--port`/`-p` in the script, falling back to `nodeCliPlus.debug.port`), then launches Chrome/Edge/Firefox/Brave/Opera/Safari with DevTools attached.
- `node` — launches `npm run <script>` under VS Code's built-in Node.js debugger (`runtimeExecutable: npm`) — breakpoints work immediately, no port needed.

## AI auto-fix

The Memory Leaks and Build Errors webviews show an **Auto Fix** button per issue and per file. It opens GitHub Copilot Chat or the Claude Code panel with a ready-made fix prompt (clipboard fallback). Configure with:

- `nodeCliPlus.ai.provider` — `copilot` *(default)* or `claude`
- `nodeCliPlus.ai.autoFixEnabled` — show/hide the buttons

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nodeCliPlus.debug.mode` | `auto` | `auto`, `browser`, or `node` |
| `nodeCliPlus.debug.browser` | `chrome` | Browser used for browser-mode debugging |
| `nodeCliPlus.debug.browserExecutablePath` | `""` | Override browser executable detection |
| `nodeCliPlus.debug.port` | `3000` | Fallback port for browser-mode debugging |
| `nodeCliPlus.buildWatch.outDir` | `dist` | Directory served during debug build watch |
| `nodeCliPlus.buildWatch.servePort` | `4173` | Static server port for debug build watch |
| `nodeCliPlus.buildWatch.staticServerCommand` | `npx serve {outDir} -l {port}` | Static server command template |
| `nodeCliPlus.test.watch` | `false` | Prefer watch-style test scripts |
| `nodeCliPlus.checkDependencies.enabled` | `true` | Dependency check on startup / branch switch. Automatic checks are skipped for folders containing `angular.json` when Angular CLI Plus is installed. |
| `nodeCliPlus.checkToolVersions.enabled` | `true` | `engines` field check on startup |
| `nodeCliPlus.npm.installCommand` | `""` | Custom install command (e.g. `pnpm install`) |
| `nodeCliPlus.npm.cleanInstallCommand` | `""` | Custom clean-install command |
| `nodeCliPlus.ai.provider` | `copilot` | AI assistant used for auto-fix |
| `nodeCliPlus.ai.autoFixEnabled` | `true` | Show Auto Fix buttons in webviews |

## Development

```bash
npm install
npm run compile   # type-check + lint + bundle (dist/extension.js)
npm test          # unit tests via @vscode/test-cli
npm run test:graph-webview
npm run test:security-unit
npm run test:security-engine
npm run test:security-webview
```

Press `F5` to launch an Extension Development Host with the extension loaded.

## License

MIT
