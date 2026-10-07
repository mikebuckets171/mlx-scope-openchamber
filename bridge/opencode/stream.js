const MAX_FRAME_BYTES = 65_536;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

export function parseProgress(value, previous) {
  if (!object(value) || !count(value.total) || value.total === 0 || !count(value.cache) || !count(value.processed)
    || value.cache > value.processed || value.processed > value.total
    || typeof value.time_ms !== 'number' || !Number.isFinite(value.time_ms) || value.time_ms < 0) return null;
  if (previous && (value.total !== previous.total || value.cache !== previous.cache
    || value.processed <= previous.processed || value.time_ms < previous.timeMs)) return null;
  return { total: value.total, cache: value.cache, processed: value.processed, timeMs: value.time_ms };
}

const outputStarted = body => {
  if (body.error || ['response.completed', 'response.failed', 'response.cancelled', 'message_stop', 'content_block_start', 'content_block_delta'].includes(body.type)) return true;
  if (typeof body.type === 'string' && (body.type.startsWith('response.output_') || body.type.startsWith('response.reasoning_'))) return true;
  return Array.isArray(body.choices) && body.choices.some(choice => object(choice) && (choice.finish_reason != null
    || (typeof choice.text === 'string' && choice.text.length > 0)
    || (object(choice.delta) && Object.entries(choice.delta).some(([name, value]) => name !== 'role' && value != null && value !== '' && (!Array.isArray(value) || value.length > 0)))));
};

// This parser sees bytes already requested by the downstream consumer. It never
// starts a second reader/tee, buffers a whole reply, or changes a response byte.
export function observeStream(response, { metadata, store, signal, onClose = () => {}, onObserver = () => {} }) {
  if (!response.body || !response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', frame = [], frameSize = 0, previous, responseModelKey, ended = false;
  const finish = () => {
    if (ended) return;
    ended = true; buffer = ''; frame = []; frameSize = 0;
    store.remove(metadata.requestID); signal?.removeEventListener('abort', finish); onClose();
  };
  const event = () => {
    if (ended || !frame.length) { frame = []; frameSize = 0; return; }
    const data = frame.join('\n'); frame = []; frameSize = 0;
    if (data === '[DONE]') { finish(); return; }
    let body;
    try { body = JSON.parse(data); } catch { finish(); return; }
    if (!object(body)) return;
    if (typeof body.model === 'string' && body.model.length > 0 && body.model.length <= 1024) {
      const model = key('model', body.model);
      if (responseModelKey && responseModelKey !== model) { finish(); return; }
      responseModelKey = model;
    }
    if (outputStarted(body)) { finish(); return; }
    if (!Object.hasOwn(body, 'prompt_progress')) return;
    const progress = parseProgress(body.prompt_progress, previous);
    if (!progress) { finish(); return; }
    previous = progress; store.update({ ...metadata, ...(responseModelKey ? { responseModelKey } : {}), ...progress });
  };
  const feed = bytes => {
    if (ended) return;
    if (bytes.byteLength > MAX_FRAME_BYTES) { finish(); return; }
    buffer += decoder.decode(bytes, { stream: true });
    // Process CRLF and LF, including a CR/LF pair split across byte chunks.
    let newline;
    while (!ended && (newline = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') { event(); continue; }
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).replace(/^ /, '');
      frameSize += value.length;
      if (frameSize > MAX_FRAME_BYTES) { finish(); return; }
      frame.push(value);
    }
    if (buffer.length + frameSize > MAX_FRAME_BYTES) finish();
  };
  onObserver(finish);
  signal?.addEventListener('abort', finish, { once: true });
  if (signal?.aborted) finish();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { finish(); controller.close(); reader.releaseLock(); return; }
        try { feed(result.value); } catch { finish(); }
        controller.enqueue(result.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { finish(); try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
import { key } from './store.js';
