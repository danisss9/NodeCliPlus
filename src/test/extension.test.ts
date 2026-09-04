import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  semverSatisfies,
  validateCustomCommand,
  toKebabCase,
  isPathInside,
  findMatchingProjects,
  findBestProjectForPath,
  expandWorkspacePattern,
  expandWorkspaces,
  parseNodeFilePath,
  getNodeSiblingPaths,
  parseBuildErrors,
  detectBrowserLikelihood,
  parsePortFromScript,
  pickScriptCandidates,
  extractJsonObject,
  extractJsonArray,
} from '../pure-utils';
import type { NodeWorkspaceProject } from '../types';
import { findMemoryLeaksInFile } from '../ast-utils';
import { parseLintOutput } from '../lint-issues';

// Use forward-slash paths and normalise to the OS separator for cross-platform tests
const SEP = path.sep;
function W(p: string): string {
  return p.replaceAll('/', SEP);
}

// ── semverSatisfies ───────────────────────────────────────────────────────────

suite('semverSatisfies', () => {
  // Wildcards / pass-through
  test('* range always passes', () => assert.strictEqual(semverSatisfies('1.2.3', '*'), true));
  test('empty range always passes', () => assert.strictEqual(semverSatisfies('1.2.3', ''), true));
  test('"latest" always passes', () =>
    assert.strictEqual(semverSatisfies('1.2.3', 'latest'), true));
  test('whitespace-only range treated as empty', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '   '), true));

  // Non-semver specifiers
  test('git+https: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'git+https://github.com/foo/bar'), true));
  test('file: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'file:../local-pkg'), true));
  test('workspace: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'workspace:^'), true));
  test('https: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'https://example.com/pkg.tgz'), true));
  test('github: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'github:owner/repo'), true));

  // Caret (^)
  test('^ patch upgrade satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.5', '^1.2.3'), true));
  test('^ minor upgrade satisfies', () =>
    assert.strictEqual(semverSatisfies('1.3.0', '^1.2.3'), true));
  test('^ exact match satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '^1.2.3'), true));
  test('^ major bump fails', () => assert.strictEqual(semverSatisfies('2.0.0', '^1.2.3'), false));
  test('^ older patch fails', () => assert.strictEqual(semverSatisfies('1.2.2', '^1.2.3'), false));
  test('^ zero major: same minor required', () =>
    assert.strictEqual(semverSatisfies('0.2.5', '^0.2.3'), true));
  test('^ zero major: different minor fails', () =>
    assert.strictEqual(semverSatisfies('0.3.0', '^0.2.3'), false));

  // Tilde (~)
  test('~ patch upgrade satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.5', '~1.2.3'), true));
  test('~ exact match satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '~1.2.3'), true));
  test('~ minor bump fails', () => assert.strictEqual(semverSatisfies('1.3.0', '~1.2.3'), false));

  // >= and >
  test('>= equal satisfies', () => assert.strictEqual(semverSatisfies('1.2.3', '>=1.2.3'), true));
  test('>= greater satisfies', () => assert.strictEqual(semverSatisfies('2.0.0', '>=1.2.3'), true));
  test('>= lesser fails', () => assert.strictEqual(semverSatisfies('1.0.0', '>=1.2.3'), false));
  test('> strictly greater satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.4', '>1.2.3'), true));
  test('> equal fails', () => assert.strictEqual(semverSatisfies('1.2.3', '>1.2.3'), false));

  // Hyphen range
  test('hyphen range — value inside satisfies', () =>
    assert.strictEqual(semverSatisfies('1.5.0', '1.0.0 - 2.0.0'), true));
  test('hyphen range — outside fails', () =>
    assert.strictEqual(semverSatisfies('3.0.0', '1.0.0 - 2.0.0'), false));

  // OR range (||)
  test('|| range — first alternative satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '^1.0.0 || ^2.0.0'), true));
  test('|| range — neither alternative fails', () =>
    assert.strictEqual(semverSatisfies('3.0.0', '^1.0.0 || ^2.0.0'), false));

  // Pre-release versions
  test('pre-release installed against non-pre-release range fails', () =>
    assert.strictEqual(semverSatisfies('1.0.0-beta', '^1.0.0'), false));
  test('pre-release installed satisfying matching pre-release range passes', () =>
    assert.strictEqual(semverSatisfies('18.1.0-rc.0', '^18.1.0-rc.0'), true));

  // v-prefix
  test('v-prefixed version satisfies range', () =>
    assert.strictEqual(semverSatisfies('v14.21.0', '>=14'), true));
  test('v-prefixed version fails range', () =>
    assert.strictEqual(semverSatisfies('v12.0.0', '>=14'), false));

  // Unparseable / garbage versions
  test('completely unparseable installed version returns true (safe default)', () =>
    assert.strictEqual(semverSatisfies('not-a-version', '^1.0.0'), true));
});

// ── validateCustomCommand ─────────────────────────────────────────────────────

suite('validateCustomCommand', () => {
  // Valid commands
  test('npm install is valid', () =>
    assert.strictEqual(validateCustomCommand('npm install'), null));
  test('pnpm install is valid', () =>
    assert.strictEqual(validateCustomCommand('pnpm install'), null));
  test('yarn --frozen-lockfile is valid', () =>
    assert.strictEqual(validateCustomCommand('yarn install --frozen-lockfile'), null));
  test('bun install is valid', () =>
    assert.strictEqual(validateCustomCommand('bun install'), null));
  test('npm ci is valid', () => assert.strictEqual(validateCustomCommand('npm ci'), null));
  test('command with flags is valid', () =>
    assert.strictEqual(validateCustomCommand('npm install --prefer-offline'), null));
  test('npx serve with placeholders is valid', () =>
    assert.strictEqual(validateCustomCommand('npx serve "dist" -l 4173'), null));

  // Empty / whitespace
  test('empty string is invalid', () => assert.notStrictEqual(validateCustomCommand(''), null));
  test('whitespace-only is invalid', () =>
    assert.notStrictEqual(validateCustomCommand('   '), null));

  // Dangerous injection patterns
  test('; rm injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install; rm -rf /'), null));
  test('; del injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install; del /F /S /Q C:\\'), null));
  test('$() shell substitution is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install $(echo malicious)'), null));
  test('backtick shell substitution is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install `echo malicious`'), null));
  test('&& rm injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install && rm -rf /'), null));
  test('| rm injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install | rm -rf /'), null));

  // Must NOT be over-blocked
  test('"remove" word (not rm) is allowed', () =>
    assert.strictEqual(validateCustomCommand('npm remove lodash'), null));
  test('path containing "del" in name is allowed', () =>
    assert.strictEqual(validateCustomCommand('npm run delete-cache'), null));

  // Return type is a non-empty string when invalid
  test('error message is a non-empty string', () => {
    const result = validateCustomCommand('');
    assert.ok(typeof result === 'string' && result.length > 0);
  });
});

// ── toKebabCase ───────────────────────────────────────────────────────────────

suite('toKebabCase', () => {
  test('camelCase → kebab-case', () => assert.strictEqual(toKebabCase('skipTests'), 'skip-tests'));
  test('two words', () => assert.strictEqual(toKebabCase('inlineTemplate'), 'inline-template'));
  test('already kebab unchanged', () =>
    assert.strictEqual(toKebabCase('skip-tests'), 'skip-tests'));
  test('single word unchanged', () => assert.strictEqual(toKebabCase('flat'), 'flat'));
  test('number before capital', () =>
    assert.strictEqual(toKebabCase('form2Builder'), 'form2-builder'));
});

// ── isPathInside ──────────────────────────────────────────────────────────────

suite('isPathInside', () => {
  test('direct child is inside', () =>
    assert.strictEqual(isPathInside(W('C:/proj'), W('C:/proj/src')), true));
  test('nested descendant is inside', () =>
    assert.strictEqual(isPathInside(W('C:/proj'), W('C:/proj/a/b/c.ts')), true));
  test('same path is inside', () =>
    assert.strictEqual(isPathInside(W('C:/proj'), W('C:/proj')), true));
  test('sibling with same prefix is NOT inside', () =>
    assert.strictEqual(isPathInside(W('C:/proj'), W('C:/proj-other')), false));
  test('parent is NOT inside child', () =>
    assert.strictEqual(isPathInside(W('C:/proj/src'), W('C:/proj')), false));
});

// ── workspace project matching ─────────────────────────────────────────────────

function makeProjects(): NodeWorkspaceProject[] {
  return [
    { name: 'root', dir: W('C:/ws'), relativeDir: '', scripts: {}, allDependencies: {}, isRoot: true },
    {
      name: '@acme/api',
      dir: W('C:/ws/packages/api'),
      relativeDir: 'packages/api',
      scripts: {},
      allDependencies: {},
      isRoot: false,
    },
    {
      name: '@acme/api-tests',
      dir: W('C:/ws/packages/api-tests'),
      relativeDir: 'packages/api-tests',
      scripts: {},
      allDependencies: {},
      isRoot: false,
    },
  ];
}

suite('findBestProjectForPath', () => {
  test('returns the most specific (longest) project dir', () => {
    const best = findBestProjectForPath(W('C:/ws/packages/api/src/index.ts'), makeProjects());
    assert.strictEqual(best, '@acme/api');
  });
  test('file in api-tests does not match api', () => {
    const best = findBestProjectForPath(
      W('C:/ws/packages/api-tests/src/a.test.ts'),
      makeProjects(),
    );
    assert.strictEqual(best, '@acme/api-tests');
  });
  test('file outside every package falls back to the root project', () => {
    const best = findBestProjectForPath(W('C:/ws/scripts/deploy.js'), makeProjects());
    assert.strictEqual(best, 'root');
  });
  test('returns null when nothing contains the file', () => {
    const best = findBestProjectForPath(W('C:/other/main.ts'), makeProjects());
    assert.strictEqual(best, null);
  });
});

suite('findMatchingProjects', () => {
  test('matches folders inside a project (root included)', () => {
    const matches = findMatchingProjects(W('C:/ws/packages/api/src'), makeProjects());
    assert.deepStrictEqual(matches, ['root', '@acme/api']);
  });
  test('matches the project dir itself (root included)', () => {
    const matches = findMatchingProjects(W('C:/ws/packages/api'), makeProjects());
    assert.deepStrictEqual(matches, ['root', '@acme/api']);
  });
  test('sibling with same prefix does not match', () => {
    const matches = findMatchingProjects(W('C:/ws/packages/api-tests'), makeProjects());
    assert.deepStrictEqual(matches, ['root', '@acme/api-tests']);
  });
});

// ── expandWorkspaces ────────────────────────────────────────────────────────────

suite('expandWorkspaces', () => {
  let tmpDir: string;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecliplus-ws-'));
    // packages/* layout
    fs.mkdirSync(path.join(tmpDir, 'packages', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'packages', 'alpha', 'package.json'), '{"name":"alpha"}');
    fs.mkdirSync(path.join(tmpDir, 'packages', 'beta'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'packages', 'beta', 'package.json'), '{"name":"beta"}');
    // a dir without package.json — should be skipped
    fs.mkdirSync(path.join(tmpDir, 'packages', 'no-pkg'), { recursive: true });
    // nested workspace under ** pattern
    fs.mkdirSync(path.join(tmpDir, 'libs', 'deep', 'gamma'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'libs', 'deep', 'gamma', 'package.json'), '{"name":"gamma"}');
    // node_modules that must never match
    fs.mkdirSync(path.join(tmpDir, 'packages', 'node_modules', 'evil'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'packages', 'node_modules', 'evil', 'package.json'),
      '{"name":"evil"}',
    );
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('expands single-star patterns to dirs with package.json', () => {
    const dirs = expandWorkspaces(tmpDir, ['packages/*']);
    assert.deepStrictEqual(dirs, ['packages/alpha', 'packages/beta']);
  });

  test('skips dirs without package.json', () => {
    const dirs = expandWorkspaces(tmpDir, ['packages/*']);
    assert.ok(!dirs.includes('packages/no-pkg'));
  });

  test('never descends into node_modules', () => {
    const dirs = expandWorkspaces(tmpDir, ['packages/*', 'packages/**']);
    assert.ok(!dirs.some((d) => d.includes('node_modules')));
  });

  test('double-star matches at any depth', () => {
    const dirs = expandWorkspaces(tmpDir, ['libs/**']);
    assert.deepStrictEqual(dirs, ['libs/deep/gamma']);
  });

  test('plain directory pattern matches exactly that dir', () => {
    const dirs = expandWorkspaces(tmpDir, ['packages/alpha']);
    assert.deepStrictEqual(dirs, ['packages/alpha']);
  });

  test('deduplicates overlapping patterns', () => {
    const dirs = expandWorkspaces(tmpDir, ['packages/*', 'packages/alpha']);
    assert.deepStrictEqual(dirs, ['packages/alpha', 'packages/beta']);
  });

  test('handles { packages: [...] } object form', () => {
    const dirs = expandWorkspaces(tmpDir, { packages: ['packages/*'] });
    assert.deepStrictEqual(dirs, ['packages/alpha', 'packages/beta']);
  });

  test('undefined workspaces returns empty', () => {
    assert.deepStrictEqual(expandWorkspaces(tmpDir, undefined), []);
  });

  test('missing dir yields nothing', () => {
    assert.deepStrictEqual(expandWorkspacePattern(tmpDir, 'does/not/exist'), []);
  });
});

// ── parseNodeFilePath / getNodeSiblingPaths ─────────────────────────────────────

suite('parseNodeFilePath', () => {
  test('parses a .test.ts file', () => {
    const parsed = parseNodeFilePath(W('C:/proj/src/foo.test.ts'));
    assert.ok(parsed);
    assert.strictEqual(parsed!.isTest, true);
    assert.strictEqual(parsed!.suffix, '.test.ts');
    assert.strictEqual(parsed!.basePath, W('C:/proj/src/foo'));
  });
  test('parses a .spec.js file', () => {
    const parsed = parseNodeFilePath('src/foo.spec.js');
    assert.ok(parsed);
    assert.strictEqual(parsed!.isTest, true);
    assert.strictEqual(parsed!.suffix, '.spec.js');
  });
  test('parses a plain .ts source file', () => {
    const parsed = parseNodeFilePath('src/foo.ts');
    assert.ok(parsed);
    assert.strictEqual(parsed!.isTest, false);
    assert.strictEqual(parsed!.suffix, '.ts');
  });
  test('.test.ts wins over .ts (longest suffix first)', () => {
    const parsed = parseNodeFilePath('foo.test.ts');
    assert.strictEqual(parsed!.suffix, '.test.ts');
  });
  test('uppercase suffix recognised', () => {
    const parsed = parseNodeFilePath('foo.TEST.TS');
    assert.strictEqual(parsed!.suffix, '.test.ts');
  });
  test('returns null for non-source files', () => {
    assert.strictEqual(parseNodeFilePath('foo.json'), null);
    assert.strictEqual(parseNodeFilePath('foo.md'), null);
    assert.strictEqual(parseNodeFilePath('README'), null);
  });
});

suite('getNodeSiblingPaths', () => {
  test('includes both source and test variants', () => {
    const siblings = getNodeSiblingPaths('src/foo');
    assert.ok(siblings.includes('src/foo.ts'));
    assert.ok(siblings.includes('src/foo.js'));
    assert.ok(siblings.includes('src/foo.test.ts'));
    assert.ok(siblings.includes('src/foo.spec.js'));
  });
});

// ── parseBuildErrors ────────────────────────────────────────────────────────────

suite('parseBuildErrors', () => {
  test('parses tsc diagnostics', () => {
    const output = [
      'src/index.ts(12,5): error TS2322: Type \'number\' is not assignable to type \'string\'.',
      'src/other.ts(1,1): error TS1005: \'{\' expected.',
    ].join('\n');
    const errors = parseBuildErrors(output);
    assert.strictEqual(errors.length, 2);
    assert.strictEqual(errors[0].file, 'src/index.ts');
    assert.strictEqual(errors[0].line, 12);
    assert.strictEqual(errors[0].col, 5);
    assert.strictEqual(errors[0].code, 'TS2322');
    assert.strictEqual(errors[0].severity, 'error');
  });

  test('parses generic file:line:col - error format', () => {
    const output = 'src/app.ts:4:10 - error TS7006: Parameter implicitly has an any type.';
    const errors = parseBuildErrors(output);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].file, 'src/app.ts');
    assert.strictEqual(errors[0].line, 4);
    assert.strictEqual(errors[0].code, 'TS7006');
  });

  test('parses esbuild-style errors with a following location line', () => {
    const output = ['X [ERROR] Could not resolve "./missing"', '', '  src/index.ts:3:7:', ''].join(
      '\n',
    );
    const errors = parseBuildErrors(output);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].file, 'src/index.ts');
    assert.strictEqual(errors[0].line, 3);
    assert.ok(errors[0].message.includes('Could not resolve'));
  });

  test('strips ANSI codes before parsing', () => {
    const output =
      '\x1b[31msrc/index.ts(1,1): error TS2304: Cannot find name.\x1b[0m';
    const errors = parseBuildErrors(output);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].file, 'src/index.ts');
    assert.strictEqual(errors[0].code, 'TS2304');
  });

  test('continuation lines are appended to the message', () => {
    const output = [
      'src/a.ts(1,1): error TS2322: Type error start',
      '  continued detail line.',
    ].join('\n');
    const errors = parseBuildErrors(output);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('continued detail line.'));
  });

  test('deduplicates identical file:line:code errors', () => {
    const line = 'src/a.ts(1,1): error TS2322: Same error.';
    const errors = parseBuildErrors([line, line].join('\n'));
    assert.strictEqual(errors.length, 1);
  });

  test('windows drive-letter paths parse', () => {
    const output = 'C:\\proj\\src\\a.ts(1,1): error TS2322: Nope.';
    const errors = parseBuildErrors(output);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].file, 'C:\\proj\\src\\a.ts');
  });

  test('warnings keep their severity', () => {
    const output = 'src/a.ts(1,1): warning TS6133: Unused variable.';
    const errors = parseBuildErrors(output);
    assert.strictEqual(errors[0].severity, 'warning');
  });

  test('no errors in successful build output', () => {
    assert.deepStrictEqual(parseBuildErrors('Build succeeded.\nDone.'), []);
  });
});

// ── detectBrowserLikelihood ─────────────────────────────────────────────────────

suite('detectBrowserLikelihood', () => {
  test('express implies browser debugging', () =>
    assert.strictEqual(detectBrowserLikelihood({ allDependencies: { express: '^4' } }), true));
  test('@nestjs/core implies browser debugging', () =>
    assert.strictEqual(
      detectBrowserLikelihood({ allDependencies: { '@nestjs/core': '^10' } }),
      true,
    ));
  test('vite implies browser debugging', () =>
    assert.strictEqual(detectBrowserLikelihood({ allDependencies: { vite: '^5' } }), true));
  test('plain CLI package implies node debugging', () =>
    assert.strictEqual(
      detectBrowserLikelihood({ allDependencies: { commander: '^12', lodash: '^4' } }),
      false,
    ));
  test('dev-only express also counts', () =>
    assert.strictEqual(
      detectBrowserLikelihood({ allDependencies: { express: 'dev' } }),
      true,
    ));
  test('empty dependencies imply node debugging', () =>
    assert.strictEqual(detectBrowserLikelihood({ allDependencies: {} }), false));
});

// ── parsePortFromScript ─────────────────────────────────────────────────────────

suite('parsePortFromScript', () => {
  test('PORT= env prefix', () =>
    assert.strictEqual(parsePortFromScript('PORT=4000 node server.js'), 4000));
  test('--port flag with space', () =>
    assert.strictEqual(parsePortFromScript('vite --port 5173'), 5173));
  test('--port= flag', () =>
    assert.strictEqual(parsePortFromScript('next dev --port=3005'), 3005));
  test('-p short flag', () => assert.strictEqual(parsePortFromScript('serve -p 1234'), 1234));
  test('no port returns 0', () => assert.strictEqual(parsePortFromScript('node index.js'), 0));
  test('rejects out-of-range ports', () =>
    assert.strictEqual(parsePortFromScript('PORT=99999 node server.js'), 0));
});

// ── pickScriptCandidates ────────────────────────────────────────────────────────

suite('pickScriptCandidates', () => {
  test('preferred aliases come first in alias order', () => {
    const scripts = { build: 'tsc', dev: 'nodemon', start: 'node dist' };
    assert.deepStrictEqual(pickScriptCandidates(scripts, ['dev', 'start']), ['dev', 'start', 'build']);
  });
  test('alias variants like build:watch follow the exact alias', () => {
    const scripts = { build: 'tsc', 'build:watch': 'tsc --watch', test: 'jest' };
    assert.deepStrictEqual(pickScriptCandidates(scripts, ['build']), [
      'build',
      'build:watch',
      'test',
    ]);
  });
  test('no alias match keeps declaration order', () => {
    const scripts = { lint: 'eslint .', format: 'prettier .' };
    assert.deepStrictEqual(pickScriptCandidates(scripts, ['dev']), ['lint', 'format']);
  });
  test('empty scripts returns empty', () => {
    assert.deepStrictEqual(pickScriptCandidates({}, ['dev']), []);
  });
});

// ── JSON extraction ─────────────────────────────────────────────────────────────

suite('extractJsonObject', () => {
  test('extracts plain object', () =>
    assert.strictEqual(extractJsonObject('{"a":1}'), '{"a":1}'));
  test('extracts from noisy output', () =>
    assert.strictEqual(extractJsonObject('log line\n{"a": 1}\nmore'), '{"a": 1}'));
  test('respects braces inside strings', () =>
    assert.strictEqual(extractJsonObject('{"msg":"a } b"}'), '{"msg":"a } b"}'));
  test('returns null when no object', () => assert.strictEqual(extractJsonObject('no json'), null));
});

suite('extractJsonArray', () => {
  test('extracts empty array', () => assert.strictEqual(extractJsonArray('[]'), '[]'));
  test('skips timestamp-style brackets', () =>
    assert.strictEqual(
      extractJsonArray('[12:00:00] starting\n[{"filePath":"a.ts","messages":[]}]'),
      '[{"filePath":"a.ts","messages":[]}]',
    ));
  test('returns null when no array', () =>
    assert.strictEqual(extractJsonArray('plain output'), null));
});

// ── parseLintOutput ─────────────────────────────────────────────────────────────

suite('parseLintOutput', () => {
  test('parses ESLint JSON formatter output', () => {
    const output = JSON.stringify([
      {
        filePath: 'C:/proj/src/a.ts',
        messages: [
          {
            ruleId: 'semi',
            severity: 2,
            message: 'Missing semicolon.',
            line: 3,
            column: 21,
            fix: { range: [10, 10], text: ';' },
          },
          { ruleId: null, severity: 1, message: 'Parsing error.', line: 7, column: 1 },
        ],
      },
    ]);
    const issues = parseLintOutput(output);
    assert.strictEqual(issues!.length, 2);
    assert.strictEqual(issues![0].ruleId, 'semi');
    assert.strictEqual(issues![0].severity, 'error');
    assert.strictEqual(issues![0].fixable, true);
    assert.strictEqual(issues![1].ruleId, 'syntax');
    assert.strictEqual(issues![1].severity, 'warning');
  });

  test('strips ANSI codes around the JSON', () => {
    const output = `\x1b[36m${JSON.stringify([])}\x1b[0m`;
    assert.deepStrictEqual(parseLintOutput(output), []);
  });

  test('returns null for non-JSON output', () => {
    assert.strictEqual(parseLintOutput('eslint: command not found'), null);
  });
});

// ── findMemoryLeaksInFile (Node patterns) ───────────────────────────────────────

suite('findMemoryLeaksInFile', () => {
  let tmpDir: string;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecliplus-leak-'));
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixture(name: string, content: string): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  }

  function kindsIn(file: string) {
    return findMemoryLeaksInFile(file).map((l) => l.kind);
  }

  test('uncleared setInterval is flagged', () => {
    const file = writeFixture(
      'interval.ts',
      [
        'class Ticker {',
        '  start() {',
        '    this.timer = setInterval(() => this.tick(), 1000);',
        '  }',
        '  tick() {}',
        '}',
      ].join('\n'),
    );
    assert.ok(kindsIn(file).includes('uncleared-interval'));
  });

  test('cleared setInterval is not flagged', () => {
    const file = writeFixture(
      'interval-ok.ts',
      [
        'class Ticker {',
        '  start() {',
        '    this.timer = setInterval(() => this.tick(), 1000);',
        '  }',
        '  stop() {',
        '    clearInterval(this.timer);',
        '  }',
        '  tick() {}',
        '}',
      ].join('\n'),
    );
    assert.ok(!kindsIn(file).includes('uncleared-interval'));
  });

  test('uncleared setTimeout (stored) is flagged; bare setTimeout is not', () => {
    const file = writeFixture(
      'timeout.ts',
      [
        'function run() {',
        '  const t = setTimeout(() => done(), 100);',
        '  setTimeout(() => other(), 100);',
        '}',
      ].join('\n'),
    );
    const kinds = kindsIn(file);
    assert.strictEqual(kinds.filter((k) => k === 'uncleared-timeout').length, 1);
  });

  test('cleared timeout via clearTimeout anywhere is not flagged', () => {
    const file = writeFixture(
      'timeout-ok.ts',
      [
        'let t;',
        'function run() {',
        '  t = setTimeout(() => done(), 100);',
        '}',
        'function cancel() {',
        '  clearTimeout(t);',
        '}',
      ].join('\n'),
    );
    assert.ok(!kindsIn(file).includes('uncleared-timeout'));
  });

  test('addEventListener without removal is flagged', () => {
    const file = writeFixture(
      'listener.ts',
      [
        'class Widget {',
        '  setup() {',
        '    document.addEventListener("click", this.onClick);',
        '  }',
        '  onClick() {}',
        '}',
      ].join('\n'),
    );
    assert.ok(kindsIn(file).includes('unremoved-event-listener'));
  });

  test('addEventListener with matching removeEventListener is not flagged', () => {
    const file = writeFixture(
      'listener-ok.ts',
      [
        'class Widget {',
        '  setup() {',
        '    document.addEventListener("click", this.onClick);',
        '  }',
        '  teardown() {',
        '    document.removeEventListener("click", this.onClick);',
        '  }',
        '  onClick() {}',
        '}',
      ].join('\n'),
    );
    assert.ok(!kindsIn(file).includes('unremoved-event-listener'));
  });

  test('emitter .on() without .off() is flagged', () => {
    const file = writeFixture(
      'emitter.ts',
      [
        'class Bus {',
        '  connect(emitter) {',
        '    emitter.on("data", this.handle);',
        '  }',
        '  handle(d) {}',
        '}',
      ].join('\n'),
    );
    assert.ok(kindsIn(file).includes('unremoved-event-listener'));
  });

  test('subscription stored on this without unsubscribe is flagged', () => {
    const file = writeFixture(
      'sub.ts',
      [
        'class Service {',
        '  init(obs) {',
        '    this.sub = obs.subscribe(v => this.handle(v));',
        '  }',
        '  handle(v) {}',
        '}',
      ].join('\n'),
    );
    assert.ok(kindsIn(file).includes('unremoved-subscription'));
  });

  test('subscription with unsubscribe is not flagged', () => {
    const file = writeFixture(
      'sub-ok.ts',
      [
        'class Service {',
        '  init(obs) {',
        '    this.sub = obs.subscribe(v => this.handle(v));',
        '  }',
        '  close() {',
        '    this.sub.unsubscribe();',
        '  }',
        '  handle(v) {}',
        '}',
      ].join('\n'),
    );
    assert.ok(!kindsIn(file).includes('unremoved-subscription'));
  });

  test('nested subscribe is flagged', () => {
    const file = writeFixture(
      'nested.ts',
      [
        'obs.subscribe(a => {',
        '  other.subscribe(b => use(a, b));',
        '});',
      ].join('\n'),
    );
    assert.ok(kindsIn(file).includes('nested-subscribe'));
  });

  test('retained DOM reference is flagged; nulled reference is not', () => {
    const file = writeFixture(
      'dom.ts',
      [
        'class Page {',
        '  load() {',
        '    this.el = document.getElementById("app");',
        '    this.other = document.querySelector(".thing");',
        '  }',
        '  release() {',
        '    this.other = null;',
        '  }',
        '}',
      ].join('\n'),
    );
    const leaks = findMemoryLeaksInFile(file).filter((l) => l.kind === 'retained-dom-reference');
    assert.strictEqual(leaks.length, 1);
    assert.ok(leaks[0].snippet.includes('getElementById'));
  });

  test('takeUntil Subject never completed is flagged', () => {
    const file = writeFixture(
      'subject.ts',
      [
        'import { Subject } from "rxjs";',
        'import { takeUntil } from "rxjs/operators";',
        'class Service {',
        '  private destroy$ = new Subject<void>();',
        '  init(obs) {',
        '    obs.pipe(takeUntil(this.destroy$)).subscribe(v => {});',
        '  }',
        '}',
      ].join('\n'),
    );
    assert.ok(kindsIn(file).includes('incomplete-takeuntil-subject'));
  });

  test('takeUntil Subject completed is not flagged', () => {
    const file = writeFixture(
      'subject-ok.ts',
      [
        'import { Subject } from "rxjs";',
        'import { takeUntil } from "rxjs/operators";',
        'class Service {',
        '  private destroy$ = new Subject<void>();',
        '  init(obs) {',
        '    obs.pipe(takeUntil(this.destroy$)).subscribe(v => {});',
        '  }',
        '  close() {',
        '    this.destroy$.next();',
        '    this.destroy$.complete();',
        '  }',
        '}',
      ].join('\n'),
    );
    assert.ok(!kindsIn(file).includes('incomplete-takeuntil-subject'));
  });

  test('results include line numbers and snippets', () => {
    const file = writeFixture(
      'meta.ts',
      ['class A {', '  go() {', '    this.t = setInterval(() => {}, 10);', '  }', '}'].join('\n'),
    );
    const leaks = findMemoryLeaksInFile(file);
    assert.ok(leaks.length >= 1);
    assert.strictEqual(leaks[0].line, 3);
    assert.ok(leaks[0].snippet.includes('setInterval'));
  });

  test('missing file returns empty', () => {
    assert.deepStrictEqual(findMemoryLeaksInFile(path.join(tmpDir, 'nope.ts')), []);
  });
});
