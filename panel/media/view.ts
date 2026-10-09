import type { MediaJobV1 } from '../../src/contract/media.ts';
import { mediaTerminal } from '../../src/contract/media.ts';
import { html, type Raw } from '../render/html.ts';
import type { MediaController } from './controller.ts';
import { jobOwnership, mediaJobKey, mediaJobView, orderedMediaJobs } from './present.ts';

const bar = (job: MediaJobV1, view: ReturnType<typeof mediaJobView>): Raw | string => view.terminal ? '' : html`<div class="media-progress" data-key="${job.phaseKey ?? job.phase}" data-fresh="${String(view.fresh)}" role="progressbar" aria-label="${view.phase} progress${view.fraction === null ? ' unavailable' : ' · this phase only'}"${view.fraction === null ? '' : html` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(view.fraction * 100)}" aria-valuetext="${view.counters} · ${view.phase} only"`}><span${view.fraction === null ? '' : html` style="width:${view.fraction * 100}%"`}></span></div>`;
const card = (job: MediaJobV1, model: MediaController, sessionId: string | null, now: number): Raw => {
  const key = mediaJobKey(job), view = mediaJobView(job, now, model.stale, model.cancelling.has(key)), source = model.snapshot?.sources.find(source => source.id === job.sourceId);
  return html`<article class="media-job" data-key="${key}" data-state="${job.state}" aria-label="${job.name}"><div class="media-job-head"><div><h3>${job.name}</h3><p class="media-meta">${job.kind === 'unknown' ? 'Media' : job.kind === 'video' ? 'Video' : 'Image'} · ${source?.label ?? 'Local source'} · ${jobOwnership(job, sessionId)}</p></div><span class="media-status" role="status">${view.status}</span></div>
  <div class="media-phase"><span>${view.phase}</span>${view.percent ? html`<span>${view.percent}<small> of phase</small></span>` : ''}</div>${bar(job, view)}<div class="media-job-foot"><span>${view.counters ?? (view.terminal ? 'Job ended' : view.fresh ? 'Progress not reported' : 'No fresh reading')}${view.elapsed ? ` · ${view.elapsed} elapsed` : ''}</span>${view.canCancel ? html`<button class="btn quiet" type="button" data-media-action="cancel" data-job="${key}">Cancel job</button>` : ''}</div>${view.detail ? html`<p class="coverage-note">${view.detail}</p>` : ''}
  ${model.confirm === key ? html`<div class="media-confirm" role="group" aria-label="Cancel ${job.name}"><p>Cancel this ${job.kind === 'unknown' ? 'media' : job.kind} job? Its backend will stop only this job.</p><div class="insight-actions"><button class="btn" type="button" data-media-action="confirm" data-job="${key}">Cancel this job</button><button class="btn quiet" type="button" data-media-action="dismiss" data-job="${key}">Keep running</button></div></div>` : ''}</article>`;
};
export const mediaMarkup = (model: MediaController, sessionId: string | null, now: number): Raw => {
  const jobs = orderedMediaJobs(model.snapshot, sessionId), active = jobs.filter(job => !mediaTerminal(job.state)), recent = jobs.filter(job => mediaTerminal(job.state));
  return html`<div class="media-view"><div class="section-heading"><div><h2>Media generation</h2><p class="coverage-note">Images and video from your local tools</p></div></div>
    ${model.actionError || model.error ? html`<p class="media-notice" role="status">${model.actionError ?? model.error}</p>` : ''}
    ${active.length ? html`<div class="media-jobs" aria-label="Active jobs">${active.map(job => card(job, model, sessionId, now))}</div>` : html`<div class="media-empty"><h3>${model.snapshot?.enabled === false ? 'Media monitoring is off' : model.snapshot ? 'No active media jobs' : 'Checking local media tools…'}</h3><p>${model.snapshot?.enabled === false ? 'Turn on Monitor media in Connections to see your local image and video jobs.' : model.snapshot?.sources.length ? 'Your next image or video job appears here. Scope observes work started by your tools.' : 'Scope finds supported local tools automatically. Check Connections to see what is available.'}</p></div>`}
    ${recent.length ? html`<details class="media-recent"><summary>Recent jobs · ${recent.length}</summary><div class="media-jobs">${recent.map(job => card(job, model, sessionId, now))}</div></details>` : ''}
    ${model.snapshot?.sources.some(source => source.state !== 'ready') ? html`<div class="media-sources">${model.snapshot.sources.filter(source => source.state !== 'ready').map(source => html`<p class="coverage-note">${source.label} · ${source.message ?? (source.state === 'disconnected' ? 'Not connected' : 'Telemetry unavailable')}</p>`)}</div>` : ''}
  </div>`;
};
/** One truthful job, plus a count. No inactive media decoration in the Session section. */
export const mediaGlanceMarkup = (model: MediaController, sessionId: string | null, now: number, status: boolean): Raw | string => {
  const jobs = orderedMediaJobs(model.snapshot, sessionId).filter(job => !mediaTerminal(job.state)), job = jobs[0];
  if (!job) return '';
  const view = mediaJobView(job, now, model.stale, model.cancelling.has(mediaJobKey(job)));
  return html`<section class="media-glance" aria-label="Media generation"><div class="media-glance-head"><strong>${job.kind === 'image' ? 'Image' : job.kind === 'video' ? 'Video' : 'Media'} · ${view.status}</strong><span>${jobOwnership(job, sessionId)}</span></div>${bar(job, view)}<div class="media-glance-foot"><span>${view.percent ? `${view.percent} of ${view.phase.toLowerCase()}` : view.elapsed ? `${view.elapsed} elapsed` : view.phase}</span>${jobs.length > 1 ? html`<span>+${jobs.length - 1} other${jobs.slice(1).some(other => !other.ownership.sessionKey) ? ' / unassigned' : ''}</span>` : ''}${!status ? html`<button class="btn quiet" type="button" data-action="open-media">View media</button>` : ''}</div></section>`;
};
