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
| `nodeCliPlus.checkDependencies.enabled` | `true` | Dependency check on startup / branch switch |
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
```

Press `F5` to launch an Extension Development Host with the extension loaded.

## License

MIT
