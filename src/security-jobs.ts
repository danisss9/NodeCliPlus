import type { SecurityReviewReport } from './security-types';

export type ReviewMode = 'manual' | 'automatic';
interface JobState {
  generation: number; installing: number; pending?: ReviewMode; running?: Promise<void>; mode?: ReviewMode;
  controller?: AbortController; outcome?: 'success' | 'failed';
}
/** Serializes reviews per workspace and discards results invalidated by an install. */
export class SecurityReviewJobs {
  private readonly states = new Map<string, JobState>();
  private disposed = false;
  constructor(private readonly run: (root: string, signal: AbortSignal, outcome?: 'success' | 'failed') => Promise<SecurityReviewReport>,
    private readonly publish: (root: string, report: SecurityReviewReport, mode: ReviewMode) => void,
    private readonly onError: (root: string, error: unknown) => void) {}
  private state(root: string): JobState {
    let state = this.states.get(root);
    if (!state) { state = { generation: 0, installing: 0 }; this.states.set(root, state); }
    return state;
  }
  request(root: string, mode: ReviewMode): void {
    if (this.disposed) { return; }
    const state = this.state(root);
    if (state.running && !state.installing && !state.controller?.signal.aborted) { if (mode === 'manual') { state.mode = 'manual'; } return; }
    state.pending = state.pending === 'manual' ? 'manual' : mode;
    this.pump(root, state);
  }
  beginInstall(root: string): void {
    const state = this.state(root); state.installing++; state.generation++;
    if (state.mode === 'manual') { state.pending = 'manual'; }
    state.controller?.abort();
  }
  endInstall(root: string, outcome: 'success' | 'failed' | undefined, automatic: boolean): void {
    const state = this.state(root); state.installing = Math.max(0, state.installing - 1); state.outcome = outcome;
    if (outcome && automatic && !state.pending) { state.pending = 'automatic'; }
    this.pump(root, state);
  }
  cancel(root: string): void { const state = this.states.get(root); if (state) { state.pending = undefined; state.controller?.abort(); } }
  busy(root: string): boolean { const state = this.states.get(root); return Boolean(state?.running || state?.pending || state?.installing); }
  async settled(root: string): Promise<void> { while (this.states.get(root)?.running) { await this.states.get(root)!.running; } }
  dispose(): void { this.disposed = true; for (const root of this.states.keys()) { this.cancel(root); } }
  private pump(root: string, state: JobState): void {
    if (this.disposed || state.running || state.installing || !state.pending) { return; }
    state.mode = state.pending; state.pending = undefined;
    const generation = state.generation;
    const controller = new AbortController(); state.controller = controller;
    state.running = Promise.resolve().then(() => this.run(root, controller.signal, state.outcome)).then(report => {
      if (!this.disposed && generation === state.generation) { this.publish(root, report, state.mode!); }
    }).catch(error => this.onError(root, error)).finally(() => {
      state.running = undefined; state.controller = undefined; state.mode = undefined;
      this.pump(root, state);
    });
  }
}
