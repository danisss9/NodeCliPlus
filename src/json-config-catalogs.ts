/**
 * Static catalog of well-known tsconfig options used by the tsconfig editor.
 * Each entry describes how to render and type a value; the editor still
 * surfaces any extra keys present in the file that aren't listed here, so
 * nothing is hidden.
 */

export type OptionType = 'boolean' | 'string' | 'enum' | 'number' | 'array' | 'readonly';

export interface OptionDef {
  key: string;
  type: OptionType;
  /** Allowed values for `enum` options. */
  enum?: string[];
  /** Short, one-line description shown under the option name. */
  doc?: string;
  /** Hint shown when the option is absent (e.g. the compiler default). */
  placeholder?: string;
}

// ── tsconfig.json ──────────────────────────────────────────────────────────────

const TS_COMPILER_OPTIONS: OptionDef[] = [
  { key: 'target', type: 'enum', enum: ['ES5', 'ES2015', 'ES2016', 'ES2017', 'ES2018', 'ES2019', 'ES2020', 'ES2021', 'ES2022', 'ES2023', 'ESNext'], doc: 'JS language version for emitted code.' },
  { key: 'module', type: 'enum', enum: ['CommonJS', 'ES2015', 'ES2020', 'ES2022', 'ESNext', 'Node16', 'NodeNext', 'Preserve'], doc: 'Module code generation.' },
  { key: 'moduleResolution', type: 'enum', enum: ['node', 'node10', 'node16', 'nodenext', 'bundler', 'classic'], doc: 'How modules are resolved.' },
  { key: 'lib', type: 'array', doc: 'Library declaration files to include.' },
  { key: 'strict', type: 'boolean', doc: 'Enable all strict type-checking options.' },
  { key: 'noImplicitAny', type: 'boolean', doc: 'Error on expressions with an implied "any" type.' },
  { key: 'strictNullChecks', type: 'boolean', doc: 'Account for null and undefined in type checking.' },
  { key: 'strictFunctionTypes', type: 'boolean', doc: 'Check function parameter types contravariantly.' },
  { key: 'strictBindCallApply', type: 'boolean', doc: 'Check bind/call/apply argument types.' },
  { key: 'strictPropertyInitialization', type: 'boolean', doc: 'Ensure class properties are initialized.' },
  { key: 'noImplicitThis', type: 'boolean', doc: 'Error on "this" with an implied "any" type.' },
  { key: 'alwaysStrict', type: 'boolean', doc: 'Emit "use strict" and parse in strict mode.' },
  { key: 'noUnusedLocals', type: 'boolean', doc: 'Report unused local variables.' },
  { key: 'noUnusedParameters', type: 'boolean', doc: 'Report unused function parameters.' },
  { key: 'noImplicitReturns', type: 'boolean', doc: 'Ensure all code paths return a value.' },
  { key: 'noFallthroughCasesInSwitch', type: 'boolean', doc: 'Report fallthrough cases in switch statements.' },
  { key: 'noImplicitOverride', type: 'boolean', doc: 'Require the "override" modifier on overrides.' },
  { key: 'noPropertyAccessFromIndexSignature', type: 'boolean', doc: 'Require indexed access for index signatures.' },
  { key: 'exactOptionalPropertyTypes', type: 'boolean', doc: 'Differentiate undefined from absent properties.' },
  { key: 'esModuleInterop', type: 'boolean', doc: 'Emit interop helpers for CommonJS modules.' },
  { key: 'allowSyntheticDefaultImports', type: 'boolean', doc: 'Allow default imports without a default export.' },
  { key: 'forceConsistentCasingInFileNames', type: 'boolean', doc: 'Disallow inconsistently-cased imports.' },
  { key: 'skipLibCheck', type: 'boolean', doc: 'Skip type checking of declaration files.' },
  { key: 'declaration', type: 'boolean', doc: 'Generate .d.ts declaration files.' },
  { key: 'declarationMap', type: 'boolean', doc: 'Generate source maps for declarations.' },
  { key: 'sourceMap', type: 'boolean', doc: 'Generate .map source map files.' },
  { key: 'experimentalDecorators', type: 'boolean', doc: 'Enable legacy decorator support.' },
  { key: 'emitDecoratorMetadata', type: 'boolean', doc: 'Emit design-type metadata for decorators.' },
  { key: 'useDefineForClassFields', type: 'boolean', doc: 'Emit class fields with "define" semantics.' },
  { key: 'importHelpers', type: 'boolean', doc: 'Import emit helpers from tslib.' },
  { key: 'downlevelIteration', type: 'boolean', doc: 'Emit compliant iteration for ES5/ES3.' },
  { key: 'resolveJsonModule', type: 'boolean', doc: 'Allow importing .json files.' },
  { key: 'isolatedModules', type: 'boolean', doc: 'Ensure each file can be transpiled alone.' },
  { key: 'allowJs', type: 'boolean', doc: 'Allow JavaScript files to be compiled.' },
  { key: 'checkJs', type: 'boolean', doc: 'Type-check JavaScript files.' },
  { key: 'outDir', type: 'string', doc: 'Output directory for emitted files.' },
  { key: 'rootDir', type: 'string', doc: 'Root directory of input files.' },
  { key: 'baseUrl', type: 'string', doc: 'Base directory for non-relative imports.' },
  { key: 'composite', type: 'boolean', doc: 'Enable project references.' },
  { key: 'incremental', type: 'boolean', doc: 'Save .tsbuildinfo for incremental builds.' },
  { key: 'removeComments', type: 'boolean', doc: 'Strip comments from emitted output.' },
  { key: 'skipDefaultLibCheck', type: 'boolean', doc: 'Skip checking the default library files.' },
];

export function getTsconfigCatalog(): {
  compilerOptions: OptionDef[];
} {
  return {
    compilerOptions: TS_COMPILER_OPTIONS,
  };
}
