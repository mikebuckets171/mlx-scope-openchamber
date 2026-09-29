import { captureMarkup } from '../capture-view.ts';
import { connectionsMarkup } from '../connections-view.ts';
import { savedMarkup } from '../saved-view.ts';

// The static shell, mounted once. Polls patch its text and geometry, never its controls.
export const scopeMarkup = `
<main class="scope" aria-labelledby="scope-title">
  <header class="masthead">
    <div class="brand"><svg class="scope-mark" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="11"/><path d="M3 14h6l3-5 4 10 3-5h6"/></svg><h1 id="scope-title">MLX <span>Scope</span></h1></div>
    <div class="status-pill"><span class="connection-dot" aria-hidden="true"></span><span id="phase" class="phase">Connecting</span><span class="status-sep" aria-hidden="true">·</span><span id="connection" role="status">Connecting to local runtime</span></div>
    <div class="monitor-controls">
      <button id="pause" type="button" aria-pressed="false" title="Pause this monitor, not inference"><svg viewBox="0 0 20 20" aria-hidden="true"><path id="pause-symbol" d="M7 5v10M13 5v10"/></svg><span id="pause-label" class="sr-only">Pause</span></button>
      <details class="monitor-menu" id="monitor-menu"><summary aria-label="More options" title="More options"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/></svg></summary>
        <div class="monitor-menu-content">
          <button id="refresh" type="button" title="Refresh readings" disabled><span class="menu-check" aria-hidden="true"></span>Refresh readings</button>
          <button id="compact" type="button" aria-pressed="false"><span class="menu-check" aria-hidden="true"></span>Compact view</button>
          <button id="efficiency" type="button" aria-pressed="false" title="Reduce monitoring refresh frequency"><span class="menu-check" aria-hidden="true"></span>Energy-saving updates</button>
          <button id="save-snapshot" type="button" title="Keep the 12 newest observations; the oldest is replaced when full" disabled><span class="menu-check" aria-hidden="true"></span>Save snapshot</button>
          <div id="share-actions" class="share-actions" aria-label="Share readings"></div>
          <button id="connection-change" type="button" aria-expanded="false" aria-controls="connection-setup"><span class="menu-check" aria-hidden="true"></span>Change connection</button>
          <p class="menu-about"><span id="cadence">Adaptive updates</span><span>Local · read-only · server-wide observations</span></p>
        </div>
      </details>
    </div>
  </header>
  ${connectionsMarkup}
  <div id="connection-diagnosis" class="connection-diagnosis" hidden><p id="connection-message"></p><button id="connection-configure" type="button">Choose connection</button></div>
  <p id="action-status" class="action-status" role="status" hidden></p>
  <p id="notice" class="notice" role="status" hidden></p>
  <nav class="workspace-nav" aria-label="Scope workspaces"><div role="tablist" aria-label="Scope workspaces">
    <button id="tab-live" role="tab" type="button" data-view="live" aria-controls="view-live" aria-selected="true">Live</button>
    <button id="tab-server" role="tab" type="button" data-view="server" aria-controls="view-server" aria-selected="false" tabindex="-1">Server</button>
    <button id="tab-compare" role="tab" type="button" data-view="compare" aria-controls="view-compare" aria-selected="false" tabindex="-1">Compare</button>
    <button id="tab-saved" role="tab" type="button" data-view="saved" aria-controls="view-saved" aria-selected="false" tabindex="-1">Saved</button>
  </div></nav>
  <div id="view-live" role="tabpanel" aria-labelledby="tab-live" tabindex="0">
  <section id="instrument" class="instrument" aria-label="Inference activity">
    <span id="activity-label" class="sr-only">MODEL ACTIVITY</span>
    <div class="hero-card">
    <h2 id="model" translate="no">Your local model</h2>
    <p id="splash-model-detail" class="splash-model-detail" hidden></p>
    <p id="coverage-note" class="coverage-note" hidden></p>
    <section id="prefill-progress" class="prefill-progress" aria-label="Prefill progress" hidden>
      <div class="prefill-values"><strong id="prefill-remaining">—</strong><span id="prefill-completed">—</span></div>
      <div id="prefill-track" class="progress-track" role="progressbar" aria-label="Prefill stage completed" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <div class="prefill-heading"><span id="prefill-counts" class="prefill-counts"></span><span id="prefill-state">Live reading</span></div>
      <div id="prefill-estimate" class="prefill-estimate" hidden><span>Reported stage estimate</span><strong id="prefill-eta">—</strong><small id="estimate-source">Runtime estimate · may change</small></div>
    </section>
    <div class="hero-row">
      <div class="readout"><span id="rate" class="rate">—</span><span id="unit" class="unit">Waiting for readings</span></div>
      <figure id="signal" class="signal" aria-label="No observed throughput yet">
        <div class="chart-top"><span id="chart-title">Request throughput</span><span id="ceiling">tok/s</span></div>
        <div id="history-inspector" class="plot" role="slider" tabindex="-1" aria-orientation="horizontal" aria-describedby="history-reading" aria-label="Inspect throughput history" aria-valuemin="0" aria-valuemax="0" aria-disabled="true"><svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="trace-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0"/><stop offset="1"/></linearGradient></defs><path class="grid" d="M4 4H596 M4 60H596 M4 116H596"/><g id="trace-area"></g><g id="trace"></g><circle id="cursor" r="3" hidden/><line id="inspect-line" y1="4" y2="116" hidden/><circle id="inspect-dot" r="4" hidden/></svg><span id="chart-empty">The next request starts here.</span></div>
        <figcaption><span>−90s</span><span id="chart-state">Observed samples only</span><span id="chart-end">now</span></figcaption>
        <p id="history-reading" class="history-reading">History appears as readings arrive</p>
      </figure>
    </div>
    <p id="activity" class="activity">Connecting through OpenChamber.</p>
    <div id="recent-speed" class="recent-speed" hidden><strong id="window-speed">—</strong><span id="window-span">Recent generation speed</span></div>
    <p id="request-output" class="request-output" hidden></p>
    <div id="context-headroom" class="context-headroom" hidden title="Reported prompt plus output against the model context limit. This is not OpenCode's compaction threshold or reserved output budget."><div class="context-line"><span>Context used</span><span><strong id="context-remaining">—</strong><small class="context-accounted"> · <span id="context-accounted">Not reported</span></small></span></div><div class="meter" aria-hidden="true"><i id="context-used-bar"></i></div></div>
    </div>
    <section id="catalog-section" class="catalog-section" aria-labelledby="catalog-title" hidden><div class="section-heading"><h3 id="catalog-title">Model inventory</h3><span id="catalog-count"></span></div><ul id="catalog-list" class="catalog-list"></ul><p id="catalog-note" class="insight-note"></p></section>
    <div class="metrics" aria-label="Current request">
      <div><span class="metric-label">Output</span><strong id="output">—</strong></div>
      <div><span class="metric-label">Elapsed</span><strong id="elapsed">—</strong></div>
      <div><span class="metric-label">Input reused</span><strong id="reuse">—</strong><span id="reuse-detail" class="metric-detail">Not reported</span><div class="meter" aria-hidden="true"><i id="reuse-bar"></i></div></div>
      <div><span class="metric-label">Requests</span><strong id="requests">—</strong><span id="queue" class="metric-detail">Waiting for runtime</span></div>
    </div>
  </section>
  <section id="machine" class="machine" aria-labelledby="machine-title" hidden>
    <h2 id="machine-title" class="machine-title">Host resources</h2>
    <div class="machine-line"><div><span class="machine-label">CPU</span><strong id="cpu">—</strong><div class="meter" aria-hidden="true"><i id="cpu-bar"></i></div></div><div title="Physical memory minus OS-reported free memory. Includes reclaimable pages; not Activity Monitor’s Memory Used or memory pressure."><span class="machine-label">RAM</span><strong id="ram">—</strong><div class="meter" aria-hidden="true"><i id="ram-bar"></i></div></div><div><span class="machine-label">Swap</span><strong id="swap">—</strong></div></div>
    <details id="host-details" class="host-details"><summary>Mac details</summary>
      <p id="hardware" class="hardware"></p>
      <figure class="resource-trace" role="img" aria-label="CPU and non-free memory over the last 90 seconds, on a fixed zero to 100 percent scale">
        <div class="chart-top"><span><i class="legend-cpu"></i>CPU <i class="legend-ram"></i>RAM</span><span>0–100%</span></div>
        <svg viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M2 2H298 M2 30H298 M2 58H298"/><path id="cpu-history"/><path id="ram-history"/></svg>
        <figcaption><span>−90s</span><span id="resource-state">Whole-host observations</span></figcaption>
      </figure>
      <div id="mac-memory" class="mac-memory" hidden><dl class="native-values"><div><dt>Wired</dt><dd id="wired">—</dd></div><div><dt>Compressed</dt><dd id="compressed">—</dd></div></dl></div>
      <p class="machine-explanation"><span id="machine-freshness">Waiting for a sample</span> · <span id="native-freshness">Native readings · every 10s</span>. Whole host, not the inference runtime alone. Non-free RAM includes reclaimable pages; it is not Activity Monitor’s Memory Used.</p>
    </details>
  </section>
  </div>
  <div id="view-server" role="tabpanel" aria-labelledby="tab-server" tabindex="0" hidden>
  <section id="runtime-memory" class="insight-section runtime-memory" aria-labelledby="runtime-memory-title" hidden>
    <div class="section-heading"><h2 id="runtime-memory-title">Runtime memory</h2><span id="runtime-memory-source">Server-wide</span></div>
    <div class="runtime-memory-values"><div><span id="process-label">Runtime process footprint</span><strong id="process-memory">—</strong></div><div><span id="model-label">Model allocation</span><strong id="model-memory">—</strong></div></div>
    <p id="runtime-memory-note" class="insight-note">Reported totals can overlap; they are not per-chat memory.</p>
  </section>
  <section id="cache-lens" class="insight-section" aria-labelledby="cache-title">
    <div class="section-heading"><h2 id="cache-title">Cache &amp; input</h2><span id="cache-scope">Current request</span></div>
    <p id="cache-request-state" class="insight-note">Waiting for cache readings</p>
    <div class="cache-input-values"><div><span>Reused tokens</span><strong id="cache-reuse-count">—</strong></div><div><span>Not reused</span><strong id="cache-new-count">—</strong></div></div>
    <div id="cache-input-bar" class="cache-input-bar" role="img" aria-label="Input cache reuse"><span id="cache-reused-fill"></span></div>
    <div class="cache-tier-values"><div><span>RAM cache</span><strong id="cache-ram-size">—</strong></div><div><span>SSD cache</span><strong id="cache-ssd-size">—</strong></div><div><span class="metric-label" title="Input tokens as a share of the model context limit">Input context</span><strong id="context">—</strong><span id="context-detail" class="metric-detail">Not reported</span><div class="meter" aria-hidden="true"><i id="context-bar"></i></div></div></div>
    <p id="cache-bank-state" class="insight-note">Server cache totals</p>
    <p class="insight-note">Unreused input is not necessarily the size of a prefill stage.</p>
  </section>
  <section id="resident-section" class="insight-section" aria-labelledby="resident-title" hidden>
    <div class="section-heading"><h2 id="resident-title">Loaded models</h2><span id="resident-count"></span></div>
    <ul id="resident-list" class="resident-list"></ul><p id="resident-note" class="insight-note"></p>
  </section>
  <p id="runtime-advisory" class="runtime-advisory" role="status" hidden></p>
  <section id="session-stats" class="session insight-section" aria-labelledby="session-title"><div class="section-heading"><h2 id="session-title">Server session</h2><span id="uptime">Since start / reset</span></div><div class="session-values"><div><span id="stats-label-one">Decode average</span><strong id="average-decode">—</strong></div><div><span id="stats-label-two">Prefill average</span><strong id="average-prefill">—</strong></div><div><span id="stats-label-three">Cache efficiency</span><strong id="average-cache">—</strong></div></div><p id="session-stats-state" class="native-note">Completed requests across all models</p></section>
  <details class="details" id="runtime-details"><summary>Runtime details</summary><dl>
    <div><dt>Prefix cache · SSD</dt><dd id="ssd-cache">—</dd></div>
    <div><dt>Runtime memory guard</dt><dd id="pressure">—</dd></div>
    <div><dt>Last cache lookup</dt><dd id="cache-lookup">—</dd></div>
  </dl><p class="explanation">Generation uses the reported request average when available. Otherwise, recent output speed is clearly labelled and measured from token counts. Prefill uses reported progress speed. Session averages cover completed work across models. Runtime memory guard is not macOS memory pressure. Memory uses GiB (1,024³ bytes). Compressed is physical compressor storage. Missing measurements stay unavailable.</p></details>
  </div>
  <section id="view-compare" role="tabpanel" aria-labelledby="tab-compare" tabindex="0" hidden>
    ${captureMarkup}
    <section id="recent-generations" class="insight-section" aria-labelledby="recent-title">
      <div class="section-heading"><h2 id="recent-title">Recent generations</h2><span id="recent-count">0 / 8</span></div>
      <p class="insight-note">Last observed readings · not completion records</p>
      <ol id="recent-list" class="recent-list"><li class="insight-note">Your next generation will appear here when it leaves the active view.</li></ol>
      <div class="insight-actions"><button id="copy-recent" type="button" disabled>Copy recent</button><button id="clear-recent" type="button" disabled title="Clear this view’s observation history, not runtime statistics">Clear history</button></div>
      <p class="insight-note">Kept only while this view is open. A request leaving the view does not confirm completion.</p>
    </section>
  </section>
  ${savedMarkup}
  <details class="connection-help" id="connection-help"><summary>Connection help</summary><p id="connection-result" role="status">Check whether OpenChamber has started the extension service. This does not change your configuration.</p><div class="insight-actions"><button id="check-connection" type="button">Check extension service</button><button id="connection-guide" type="button">Setup guide</button></div></details>
  <footer><span>MLX Scope <span id="scope-version"></span></span><span id="freshness">Waiting for first sample</span></footer>
</main>`;
