// Compatibility entry point; the implementation is independent of VS Code for CI engine tests.
export { spawnManaged, killAllManagedChildren } from './managed-process';
export type { SpawnManagedOptions, SpawnManagedResult } from './managed-process';
