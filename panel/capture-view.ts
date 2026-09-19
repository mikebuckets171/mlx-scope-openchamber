import type { TelemetrySnapshot } from '../src/telemetry.ts';
import { PerformanceCapture, capturedRate } from './capture.ts';

export const captureMarkup = `<section id="capture" class="capture-card" aria-labelledby="capture-title">
  <div class="section-heading"><h2 id="capture-title">Observation window</h2><span id="capture-state">On demand</span></div>
  <p class="insight-note">Record existing work, pin a reference, then observe another run.</p>
  <div class="capture-controls"><select id="capture-length" aria-label="Observation length"><option value="30">30 seconds</option><option value="60">60 seconds</option></select><button id="capture-start" type="button">Record window</button><button id="capture-stop" type="button" hidden>Stop</button></div>
  <div id="capture-progress" class="progress-track" role="progressbar" aria-label="Observation window" aria-valuemin="0" aria-valuemax="100" hidden><span></span></div>
  <div id="capture-results" hidden>
    <div class="capture-metrics"><div><span>Observed output</span><strong id="capture-speed">—</strong><small id="capture-coverage">Waiting for output</small></div><div><span>Window observed</span><strong id="capture-duration">—</strong><small id="capture-samples">No samples yet</small></div></div>
    <table class="capture-table" aria-label="Current and reference observations">
      <thead><tr><th scope="col">Sampled readings</th><th scope="col">Current</th><th scope="col" class="capture-reference-column" hidden>Reference</th></tr></thead>
      <tbody>
        <tr><th scope="row">Host CPU <small>mean / peak</small></th><td id="capture-cpu">—</td><td id="capture-reference-cpu" class="capture-reference-column" hidden>—</td></tr>
        <tr><th scope="row">Non-free RAM <small>mean / peak</small></th><td id="capture-host-memory">—</td><td id="capture-reference-host-memory" class="capture-reference-column" hidden>—</td></tr>
        <tr><th scope="row">oMLX footprint <small>peak</small></th><td id="capture-memory">—</td><td id="capture-reference-memory" class="capture-reference-column" hidden>—</td></tr>
        <tr><th scope="row">Request count <small>reported change</small></th><td id="capture-requests">—</td><td id="capture-reference-requests" class="capture-reference-column" hidden>—</td></tr>
      </tbody>
    </table>
    <p id="capture-resource-coverage" class="insight-note"></p>
    <p id="capture-note" class="insight-note"></p>
    <div id="capture-baseline" class="capture-baseline" hidden><span id="capture-reference">Pinned reference</span><strong id="capture-change">—</strong></div>
    <div class="insight-actions"><button id="capture-pin" type="button">Pin reference</button><button id="capture-copy" type="button">Copy capture</button><button id="capture-clear" type="button">Clear</button></div>
  </div>
  <p class="insight-note">Sample means are not time-weighted. Differences do not establish causality. Captures stay in memory unless you save them; no inference is started.</p>
</section>`;

export class CaptureView {
  readonly capture = new PerformanceCapture();
  private latest: TelemetrySnapshot | null = null;
  private paused = false;
  constructor(private readonly root: HTMLElement, private readonly copied: (text: string) => Promise<void>, private readonly status: (message: string) => void, private readonly version: string) {
    this.node('capture-start').addEventListener('click', () => {
      const length = (this.node('capture-length') as HTMLSelectElement).value === '60' ? 60 : 30;
      if (this.paused || !this.latest || !this.capture.start(this.latest, length)) {
        this.status('Start a single-model request in oMLX, then record its observations.'); return;
      }
      this.status('Recording observations only. No prompt or model setting was changed.'); this.render();
    });
    this.node('capture-stop').addEventListener('click', () => { this.capture.stop(); this.status('Capture stopped. Readings are retained as a partial observation.'); this.render(); });
    this.node('capture-pin').addEventListener('click', () => { if (this.capture.pin()) this.status('Reference pinned. Record another comparable workload to compare.'); this.render(); });
    this.node('capture-clear').addEventListener('click', () => { this.capture.clear(); this.status('Capture and reference cleared. oMLX statistics were not changed.'); this.render(); });
    this.node('capture-copy').addEventListener('click', async () => {
      const button = this.node('capture-copy') as HTMLButtonElement; button.disabled = true;
      try { await this.copied(this.capture.report(this.version)); this.status('Capture copied. No model names or chat content included.'); }
      catch { this.status('Could not confirm the clipboard operation.'); }
      finally { button.disabled = false; }
    });
  }
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>(`#${id}`)!; }
  private text(id: string, value: string): void { const node = this.node(id); if (node.textContent !== value) node.textContent = value; }
  update(snapshot: TelemetrySnapshot): void { this.latest = snapshot; this.paused = false; this.capture.observe(snapshot); this.render(); }
  suspend(): void { this.paused = true; this.capture.stop('Monitoring interrupted'); this.render(); }
  report(): string { return this.capture.current ? this.capture.report(this.version) : ''; }
  private render(): void {
    const c = this.capture.current, b = this.capture.baseline;
    const recording = this.capture.recording;
    this.node('capture').dataset.recording = String(recording);
    this.node('capture-stop').hidden = !recording;
    (this.node('capture-start') as HTMLButtonElement).disabled = this.paused || recording;
    (this.node('capture-length') as HTMLSelectElement).disabled = recording;
    this.node('capture-progress').hidden = !recording;
    this.node('capture-results').hidden = c === null;
    this.text('capture-state', c ? recording ? `${Math.floor(c.seconds)} / ${c.targetSeconds}s` : c.status === 'finished' ? 'Captured' : 'Partial capture' : 'On demand');
    if (!c) return;
    const percent = Math.min(100, c.seconds / c.targetSeconds * 100);
    this.node('capture-progress').setAttribute('aria-valuenow', String(Math.floor(percent)));
    (this.node('capture-progress').firstElementChild as HTMLElement).style.width = `${percent}%`;
    const r = capturedRate(c), ref = capturedRate(b);
    const memory = (value: number | null) => value === null ? '—' : `${(value * 1e9 / 1024 ** 3).toFixed(1)} GiB`;
    const meanPeak = (mean: number | null, peak: number | null, unit: '%' | 'GiB') => {
      const format = (value: number | null) => value === null ? '—' : (unit === '%' ? value : value * 1e9 / 1024 ** 3).toFixed(1);
      return mean === null && peak === null ? '—' : `${format(mean)} / ${format(peak)} ${unit}`;
    };
    this.text('capture-speed', r === null ? '—' : `${r.toFixed(1)} tok/s`);
    this.text('capture-coverage', `${c.decodeSeconds.toFixed(1)}s of fresh output intervals`);
    this.text('capture-duration', `${c.seconds.toFixed(1)}s`);
    this.text('capture-samples', `${c.samples} runtime samples · ${c.targetSeconds}s requested`);
    this.text('capture-memory', memory(c.peakProcessGB));
    this.text('capture-cpu', meanPeak(c.meanCPU, c.peakCPU, '%'));
    this.text('capture-host-memory', meanPeak(c.meanMemoryGB, c.peakMemoryGB, 'GiB'));
    this.text('capture-requests', c.requestCountChange === null ? '—' : String(c.requestCountChange));
    this.text('capture-resource-coverage', `${c.cpuSamples} CPU · ${c.memorySamples} RAM · ${c.processSamples} footprint samples`);
    this.text('capture-note', c.note);
    (this.node('capture-pin') as HTMLButtonElement).disabled = !this.capture.canPin;
    this.node('capture-baseline').hidden = b === null;
    this.root.querySelectorAll<HTMLElement>('.capture-reference-column').forEach(node => { node.hidden = b === null; });
    if (b) {
      this.text('capture-reference-cpu', meanPeak(b.meanCPU, b.peakCPU, '%'));
      this.text('capture-reference-host-memory', meanPeak(b.meanMemoryGB, b.peakMemoryGB, 'GiB'));
      this.text('capture-reference-memory', memory(b.peakProcessGB));
      this.text('capture-reference-requests', b.requestCountChange === null ? '—' : String(b.requestCountChange));
    }
    this.text('capture-reference', ref === null ? 'Pinned reference' : `Reference · ${ref.toFixed(1)} tok/s over ${b!.decodeSeconds.toFixed(1)}s`);
    const change = this.capture.comparison();
    this.text('capture-change', change === null ? b?.model !== c.model ? 'Different model' : 'Collect another window' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% observed`);
  }
}
