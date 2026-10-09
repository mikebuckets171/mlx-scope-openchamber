import type { MediaJobV1 } from '../../src/contract/media.ts';
import { mediaTerminal } from '../../src/contract/media.ts';
import { html, type Raw } from '../render/html.ts';
import type { MediaController } from './controller.ts';
import { jobOwnership, mediaJobKey, mediaJobView, orderedMediaJobs } from './present.ts';

/** The numeric center is an actual phase observation; only the stroke interpolates. */
const ring = (job: MediaJobV1, view: ReturnType<typeof mediaJobView>, sessionId: string | null): Raw | string => {
  if (view.terminal) return '';
  const mode = view.lastReported ? 'stale' : view.fraction !== null ? 'measured' : view.moving ? 'indeterminate' : 'static';
  const context = `${mediaJobKey(job)}/${sessionId ?? ''}/${job.phaseKey ?? job.phase}/${view.counterKey}/${mode}`;
  return html`<div class="media-ring" data-key="${context}" data-mode="${mode}" role="progressbar" aria-label="${view.phase}${view.lastReported ? ' last reported' : ''} progress${view.fraction === null ? ' unavailable' : ' · this phase only'}"${view.fraction === null ? '' : html` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(view.fraction * 100)}" aria-valuetext="${view.percent}${view.counterLabel ? ` · ${view.counterLabel}` : ''} · ${view.phase} only${view.lastReported ? ` · last reported ${view.reportedAge}` : ''}"`}>
    <svg class="media-ring-svg" viewBox="0 0 48 48" aria-hidden="true"><circle class="media-ring-track" cx="24" cy="24" r="21"/><circle class="media-ring-fill" cx="24" cy="24" r="21" pathLength="100" stroke-dasharray="100" style="stroke-dashoffset:${view.fraction === null ? mode === 'indeterminate' ? 76 : 100 : (1 - view.fraction) * 100}"/></svg>
    <span class="media-ring-value" aria-hidden="true">${view.percent ?? '—'}</span></div>`;
};
const phaseDetail = (view: ReturnType<typeof mediaJobView>): Raw => html`<div class="media-progress-copy"><p class="media-phase">${view.lastReported ? 'Last reported · ' : ''}${view.phase}${view.percent ? html`<small>phase progress</small>` : ''}</p>${view.counterLabel || !view.percent ? html`<p class="media-counters">${view.counterLabel ?? (view.terminal ? 'Job ended' : 'No progress report')}</p>` : ''}${view.lastReported ? html`<p class="media-timing">Updated ${view.reportedAge}${view.elapsed ? ` · ${view.elapsed} elapsed` : ''}</p>` : view.elapsed ? html`<p class="media-timing">${view.elapsed} elapsed</p>` : ''}</div>`;
const card = (job: MediaJobV1, model: MediaController, sessionId: string | null, now: number): Raw => {
  const key = mediaJobKey(job), view = mediaJobView(job, now, model.stale, model.cancelling.has(key)), source = model.snapshot?.sources.find(source => source.id === job.sourceId);
  return html`<article class="media-job" data-key="${key}" data-state="${job.state}" aria-label="${job.name}"><div class="media-job-head"><div><h3>${job.name}</h3><p class="media-meta">${job.kind === 'unknown' ? 'Media' : job.kind === 'video' ? 'Video' : 'Image'} · ${source?.label ?? 'Local source'} · ${jobOwnership(job, sessionId)}</p></div>${view.status !== view.phase ? html`<span class="media-status" role="status">${view.status}</span>` : ''}</div>
  <div class="media-job-progress">${ring(job, view, sessionId)}${phaseDetail(view)}${view.canCancel ? html`<button class="btn quiet" type="button" data-media-action="cancel" data-job="${key}">Cancel job</button>` : ''}</div>${view.detail ? html`<p class="coverage-note">${view.detail}</p>` : ''}
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
  return html`<section class="media-glance" aria-label="Media generation"><div class="media-glance-body">${ring(job, view, sessionId)}<div class="media-glance-copy"><div class="media-glance-head"><strong>${view.status}</strong><span>${jobOwnership(job, sessionId)}</span></div><p class="media-glance-phase">${job.kind === 'image' ? 'Image' : job.kind === 'video' ? 'Video' : 'Media'}${view.lastReported ? ` · ${view.phase} · last reported` : view.percent ? ' · phase progress' : view.moving ? ' · no progress report' : ''}</p><p class="media-glance-timing">${view.counterLabel ? html`<span>${view.counterLabel}</span>` : ''}${view.lastReported ? html`<span>Updated ${view.reportedAge}</span>` : ''}${view.elapsed ? html`<span>${view.elapsed} elapsed</span>` : ''}</p></div></div>${jobs.length > 1 || !status ? html`<div class="media-glance-foot">${jobs.length > 1 ? html`<span>+${jobs.length - 1} other${jobs.slice(1).some(other => !other.ownership.sessionKey) ? ' / unassigned' : ''}</span>` : ''}${!status ? html`<button class="btn quiet" type="button" data-action="open-media">View media</button>` : ''}</div>` : ''}</section>`;
};
