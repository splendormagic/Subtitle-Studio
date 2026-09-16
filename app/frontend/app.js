const TIMELINE_VIEW_SECONDS = 30;
const MIN_SUBTITLE_MS = 250;
const SNAP_THRESHOLD_MS = 120;
const state = { entries: [], selectedId: null, duration: 25, audioUrl: null, backend: null, waveform: [], pendingAudio: null, pendingSrt: null, history: [], textEditSnapshot: false };
const $ = (id) => document.getElementById(id);
const audio = $('audio');

function chooseBrowserFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.click();
  });
}

function timeLabel(ms, precise = false) {
  const totalSeconds = Math.max(0, ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const fraction = precise ? `.${String(Math.floor(ms % 1000)).padStart(3, '0')}` : '';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${fraction}`;
}

function asyncRequest(path, payload) {
  return fetch(`${state.backend}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Backend request failed');
    return result;
  });
}

function drawWaveform() {
  const canvas = $('waveform');
  const bounds = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = bounds.width * ratio; canvas.height = bounds.height * ratio;
  const context = canvas.getContext('2d'); context.scale(ratio, ratio);
  context.clearRect(0, 0, bounds.width, bounds.height);
  const center = bounds.height / 2;
  const peaks = state.waveform;
  $('waveform-message').textContent = peaks.length ? '' : 'Load audio to generate waveform';
  if (!peaks.length) {
    context.fillStyle = '#33473a';
    context.fillRect(0, center, bounds.width, 1);
    return;
  }
  context.fillStyle = '#87b66b';
  const barWidth = Math.max(1, bounds.width / peaks.length);
  peaks.forEach((peak, index) => {
    const height = Math.max(2, peak * (bounds.height * 0.82));
    context.fillRect(index * barWidth, center - height / 2, Math.max(1, barWidth - 1), height);
  });
}

async function decodeWaveform(buffer) {
  try {
    const audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(buffer.slice(0));
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const sampleCount = decoded.length;
    const bucketCount = Math.min(12000, Math.max(600, Math.floor(decoded.duration * 20)));
    const bucketSize = Math.max(1, Math.floor(sampleCount / bucketCount));
    state.waveform = Array.from({ length: bucketCount }, (_, index) => {
      let peak = 0;
      const start = index * bucketSize;
      const end = Math.min(sampleCount, start + bucketSize);
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        for (const channel of channels) peak = Math.max(peak, Math.abs(channel[sampleIndex]));
      }
      return peak;
    });
    if (!state.duration || state.duration === 25) state.duration = decoded.duration;
    await audioContext.close();
    drawWaveform();
  } catch (error) {
    state.waveform = [];
    $('backend-status').textContent = 'Audio loaded; waveform codec unavailable';
    drawWaveform();
  }
}

function updateTimelineWidth() {
  const shell = $('timeline-shell');
  const content = $('timeline-content');
  const visibleWidth = Math.max(1, shell.clientWidth - 2);
  content.style.width = `${Math.max(visibleWidth, visibleWidth * Math.max(1, state.duration / TIMELINE_VIEW_SECONDS))}px`;
}

function renderRuler() {
  const ruler = $('ruler');
  ruler.innerHTML = '';
  const step = 5;
  for (let seconds = 0; seconds <= state.duration; seconds += step) {
    const label = document.createElement('span');
    label.textContent = timeLabel(seconds * 1000).slice(3);
    ruler.appendChild(label);
  }
}

function renderTimeline() {
  updateTimelineWidth();
  renderRuler();
  const track = $('subtitle-track'); track.querySelectorAll('.subtitle-block').forEach((block) => block.remove());
  $('empty-state').style.display = state.entries.length ? 'none' : 'flex';
  $('subtitle-count').textContent = `${state.entries.length} subtitle${state.entries.length === 1 ? '' : 's'}`;
  const width = track.clientWidth;
  state.entries.forEach((entry) => {
    const block = document.createElement('div'); block.className = `subtitle-block${entry.id === state.selectedId ? ' selected' : ''}`;
    block.style.left = `${(entry.start / 1000 / state.duration) * width}px`;
    block.style.width = `${Math.max(20, ((entry.end - entry.start) / 1000 / state.duration) * width)}px`;
    block.innerHTML = `<span class="resize-handle resize-start" data-edge="start" title="Adjust start time"></span><div class="block-text"></div><span class="resize-handle resize-end" data-edge="end" title="Adjust end time"></span>`;
    block.querySelector('.block-text').textContent = entry.text.replaceAll('\n', ' / ');
    block.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('.resize-handle');
      if (handle && state.selectedId === entry.id) beginResize(event, entry, handle.dataset.edge, block);
      else if (handle) { event.preventDefault(); state.selectedId = entry.id; renderTimeline(); }
      else { state.selectedId = entry.id; renderTimeline(); }
    });
    track.appendChild(block);
  });
  const selected = state.entries.find((entry) => entry.id === state.selectedId);
  $('subtitle-editor').value = selected ? selected.text : '';
  $('selection-label').textContent = selected ? `#${selected.id} · ${timeLabel(selected.start)} - ${timeLabel(selected.end)}` : 'No selection';
  updateExportButton();
}

function updateExportButton() {
  const button = $('export-button');
  const hasLoadedSrt = state.entries.length > 0;
  button.disabled = !hasLoadedSrt;
  button.title = hasLoadedSrt ? 'Export the loaded SRT' : 'Load an SRT to enable export';
}

function saveUndoState() {
  state.history.push({ entries: structuredClone(state.entries), selectedId: state.selectedId });
  if (state.history.length > 100) state.history.shift();
}

function undoLastChange() {
  const previous = state.history.pop();
  if (!previous) {
    $('backend-status').textContent = 'Nothing to undo';
    return;
  }
  state.entries = previous.entries;
  state.selectedId = previous.selectedId;
  state.textEditSnapshot = false;
  renderTimeline();
  $('backend-status').textContent = 'Last SRT change undone';
}

function snapToPlayhead(time) {
  if (!audio.src) return time;
  const playheadTime = audio.currentTime * 1000;
  return Math.abs(time - playheadTime) <= SNAP_THRESHOLD_MS ? playheadTime : time;
}

function beginResize(event, entry, edge, block) {
  event.preventDefault();
  event.stopPropagation();
  saveUndoState();
  state.selectedId = entry.id;
  const startX = event.clientX;
  const originalStart = entry.start;
  const originalEnd = entry.end;
  const pixelsPerMs = $('subtitle-track').clientWidth / (state.duration * 1000);
  const orderedEntries = [...state.entries].sort((left, right) => left.start - right.start);
  const entryIndex = orderedEntries.findIndex((item) => item.id === entry.id);
  const previousEntry = orderedEntries[entryIndex - 1];
  const nextEntry = orderedEntries[entryIndex + 1];
  const minimumStart = previousEntry ? previousEntry.end : 0;
  const maximumEnd = nextEntry ? nextEntry.start : state.duration * 1000;
  const move = (moveEvent) => {
    const delta = (moveEvent.clientX - startX) / pixelsPerMs;
    let nextStart = originalStart;
    let nextEnd = originalEnd;
    if (edge === 'start') {
      const maximumStart = Math.min(originalEnd - MIN_SUBTITLE_MS, maximumEnd - MIN_SUBTITLE_MS);
      nextStart = snapToPlayhead(originalStart + delta);
      nextStart = Math.max(minimumStart, Math.min(maximumStart, nextStart));
    } else {
      const minimumEnd = Math.max(originalStart + MIN_SUBTITLE_MS, minimumStart + MIN_SUBTITLE_MS);
      nextEnd = snapToPlayhead(originalEnd + delta);
      nextEnd = Math.min(maximumEnd, Math.max(minimumEnd, nextEnd));
    }
    const width = $('subtitle-track').clientWidth;
    block.style.left = `${(nextStart / (state.duration * 1000)) * width}px`;
    block.style.width = `${Math.max(20, ((nextEnd - nextStart) / (state.duration * 1000)) * width)}px`;
    $('selection-label').textContent = `#${entry.id} · ${timeLabel(nextStart)} - ${timeLabel(nextEnd)}`;
  };
  const stop = (stopEvent) => {
    if (stopEvent.type !== 'pointercancel') {
      const delta = (stopEvent.clientX - startX) / pixelsPerMs;
      if (edge === 'start') {
        const maximumStart = Math.min(originalEnd - MIN_SUBTITLE_MS, maximumEnd - MIN_SUBTITLE_MS);
        entry.start = snapToPlayhead(originalStart + delta);
        entry.start = Math.max(minimumStart, Math.min(maximumStart, entry.start));
      } else {
        const minimumEnd = Math.max(originalStart + MIN_SUBTITLE_MS, minimumStart + MIN_SUBTITLE_MS);
        entry.end = snapToPlayhead(originalEnd + delta);
        entry.end = Math.min(maximumEnd, Math.max(minimumEnd, entry.end));
      }
    }
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    renderTimeline();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

function updatePlayhead(seconds) {
  const progress = Math.min(1, seconds / state.duration);
  const track = $('subtitle-track');
  $('playhead').style.left = `${track.offsetLeft + progress * track.clientWidth}px`;
  $('scrubber').value = progress * 100;
  $('current-time').textContent = timeLabel(seconds * 1000, true).slice(3);
  const activeEntry = state.entries.find((entry) => seconds * 1000 >= entry.start && seconds * 1000 <= entry.end);
  const activeId = activeEntry?.id || null;
  if (activeId !== state.selectedId) {
    state.selectedId = activeId;
    renderTimeline();
  }
}

function seekFromWaveform(event) {
  const track = event.currentTarget;
  const bounds = track.getBoundingClientRect();
  const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  audio.currentTime = position * state.duration;
  updatePlayhead(audio.currentTime);
}

async function chooseAudio() {
  const file = await chooseBrowserFile('.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.aiff');
  if (!file) return;
  const audioBuffer = await file.arrayBuffer();
  state.pendingAudio = { file, buffer: audioBuffer };
  $('audio-name').textContent = `${file.name} · ready`;
  $('backend-status').textContent = 'Audio selected; press Load timeline';
}

async function chooseSrt() {
  const file = await chooseBrowserFile('.srt'); if (!file) return;
  const text = await file.text();
  state.pendingSrt = { file, text };
  $('srt-name').textContent = `${file.name} · ready`;
  $('backend-status').textContent = 'SRT selected; press Load timeline';
}

async function loadTimeline() {
  if (!state.pendingAudio && !state.pendingSrt) return;
  if (state.pendingAudio) {
    const { file, buffer } = state.pendingAudio;
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    audio.src = state.audioUrl;
    state.waveform = [];
    $('audio-name').textContent = file.name;
    $('project-title').textContent = file.name.replace(/\.[^.]+$/, '');
    await decodeWaveform(buffer);
    state.pendingAudio = null;
  }
  if (state.pendingSrt) {
    const result = await asyncRequest('/parse-srt', { text: state.pendingSrt.text });
    state.entries = result.entries;
    state.selectedId = state.entries[0]?.id || null;
    state.history = [];
    state.textEditSnapshot = false;
    $('srt-name').textContent = state.pendingSrt.file.name;
    state.pendingSrt = null;
  }
  $('timeline-shell').scrollLeft = 0;
  $('audio-duration').textContent = timeLabel(state.duration * 1000);
  $('total-time').textContent = timeLabel(state.duration * 1000, true).slice(3);
  $('backend-status').textContent = `Timeline loaded · ${TIMELINE_VIEW_SECONDS} second view`;
  renderTimeline();
  drawWaveform();
  updatePlayhead(audio.currentTime || 0);
}

async function exportSrt() { if (!state.entries.length) return; const result = await asyncRequest('/render-srt', { entries: state.entries }); const name = `${$('project-title').textContent || 'edited'}.srt`; const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' })); link.download = name; link.click(); URL.revokeObjectURL(link.href); $('backend-status').textContent = 'SRT downloaded successfully'; }

function splitSelected() { const entry = state.entries.find((item) => item.id === state.selectedId); if (!entry) return; const splitTime = Math.round(audio.currentTime * 1000); if (splitTime < entry.start + MIN_SUBTITLE_MS || splitTime > entry.end - MIN_SUBTITLE_MS) { $('backend-status').textContent = 'Move the needle inside the subtitle before splitting'; return; } saveUndoState(); const words = entry.text.split(/\s+/); const split = Math.max(1, Math.floor(words.length / 2)); entry.text = words.slice(0, split).join(' '); const second = { id: Math.max(0, ...state.entries.map((item) => item.id)) + 1, start: splitTime, end: entry.end, text: words.slice(split).join(' ') }; entry.end = splitTime; state.entries.splice(state.entries.indexOf(entry) + 1, 0, second); state.selectedId = second.id; renderTimeline(); }
function deleteSelected() { const index = state.entries.findIndex((entry) => entry.id === state.selectedId); if (index < 0) return; saveUndoState(); state.entries.splice(index, 1); state.selectedId = state.entries[index]?.id || state.entries[index - 1]?.id || null; renderTimeline(); }

function resetProject() {
  if (!window.confirm('Reset the demo project? Your current audio, subtitles, and edits will be cleared.')) return;
  audio.pause();
  stopPlayheadAnimation();
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  audio.removeAttribute('src');
  audio.load();
  state.entries = [];
  state.selectedId = null;
  state.duration = 25;
  state.audioUrl = null;
  state.waveform = [];
  state.pendingAudio = null;
  state.pendingSrt = null;
  state.history = [];
  state.textEditSnapshot = false;
  $('audio-name').textContent = 'Choose audio';
  $('srt-name').textContent = 'Choose subtitles';
  $('project-title').textContent = 'Untitled session';
  $('audio-duration').textContent = '00:00:00';
  $('total-time').textContent = '00:00.000';
  $('current-time').textContent = '00:00.000';
  $('scrubber').value = 0;
  $('timeline-shell').scrollLeft = 0;
  $('backend-status').textContent = 'Demo project reset';
  setPlaybackButton(false);
  renderTimeline();
  drawWaveform();
  updatePlayhead(0);
}

let playheadFrame = null;
function animatePlayhead() {
  updatePlayhead(audio.currentTime);
  if (!audio.paused && !audio.ended) playheadFrame = requestAnimationFrame(animatePlayhead);
  else playheadFrame = null;
}
function startPlayheadAnimation() {
  if (playheadFrame === null) playheadFrame = requestAnimationFrame(animatePlayhead);
}
function stopPlayheadAnimation() {
  if (playheadFrame !== null) cancelAnimationFrame(playheadFrame);
  playheadFrame = null;
  updatePlayhead(audio.currentTime);
}

function setPlaybackButton(isPlaying, isLoading = false) {
  const button = $('play-button');
  button.classList.toggle('is-loading', isLoading);
  button.textContent = isLoading ? '...' : isPlaying ? 'Ⅱ' : '▶';
  button.setAttribute('aria-label', isLoading ? 'Loading audio' : isPlaying ? 'Pause audio' : 'Play audio');
  button.title = isLoading ? 'Loading audio' : isPlaying ? 'Pause audio' : 'Play audio';
}

async function togglePlayback() {
  if (!audio.src) {
    $('backend-status').textContent = 'Choose and load an audio file first';
    return;
  }
  if (!audio.paused && !audio.ended) {
    audio.pause();
    return;
  }
  if (audio.ended) audio.currentTime = 0;
  setPlaybackButton(false, true);
  try {
    await audio.play();
  } catch (error) {
    setPlaybackButton(false);
    $('backend-status').textContent = 'Audio could not be played';
    console.warn('Audio playback failed:', error);
  }
}

$('audio-button').addEventListener('click', chooseAudio); $('srt-button').addEventListener('click', chooseSrt); $('export-button').addEventListener('click', exportSrt); $('split-button').addEventListener('click', splitSelected); $('delete-button').addEventListener('click', deleteSelected); $('undo-button').addEventListener('click', undoLastChange); $('reset-button').addEventListener('click', resetProject); $('play-button').addEventListener('click', togglePlayback); $('subtitle-editor').addEventListener('focus', () => { if (!state.textEditSnapshot) { saveUndoState(); state.textEditSnapshot = true; } }); $('subtitle-editor').addEventListener('blur', () => { state.textEditSnapshot = false; }); $('subtitle-editor').addEventListener('input', (event) => { const entry = state.entries.find((item) => item.id === state.selectedId); if (entry) { entry.text = event.target.value; renderTimeline(); } }); $('scrubber').addEventListener('input', (event) => { audio.currentTime = (event.target.value / 100) * state.duration; });
$('load-button').addEventListener('click', loadTimeline);
audio.addEventListener('loadedmetadata', () => { if (audio.duration && Number.isFinite(audio.duration)) { state.duration = audio.duration; $('audio-duration').textContent = timeLabel(state.duration * 1000); $('total-time').textContent = timeLabel(state.duration * 1000, true).slice(3); renderTimeline(); updatePlayhead(audio.currentTime); } }); audio.addEventListener('timeupdate', () => updatePlayhead(audio.currentTime)); audio.addEventListener('play', () => { setPlaybackButton(true); startPlayheadAnimation(); }); audio.addEventListener('pause', () => { setPlaybackButton(false); stopPlayheadAnimation(); }); audio.addEventListener('ended', () => { setPlaybackButton(false); stopPlayheadAnimation(); }); audio.addEventListener('error', () => { setPlaybackButton(false); $('backend-status').textContent = 'Audio format could not be decoded'; }); window.addEventListener('resize', () => { drawWaveform(); updatePlayhead(audio.currentTime); });
$('waveform').parentElement.addEventListener('pointerdown', (event) => { event.currentTarget.setPointerCapture(event.pointerId); seekFromWaveform(event); }); $('waveform').parentElement.addEventListener('pointermove', (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromWaveform(event); }); $('waveform').parentElement.addEventListener('pointerup', (event) => { event.currentTarget.releasePointerCapture(event.pointerId); });
window.addEventListener('keydown', (event) => { if (event.target.matches('textarea')) return; if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoLastChange(); return; } if (event.code === 'Space') { event.preventDefault(); togglePlayback(); } if (event.key.toLowerCase() === 's') splitSelected(); if (event.key === 'Delete') deleteSelected(); if (event.ctrlKey && event.key.toLowerCase() === 'e') { event.preventDefault(); exportSrt(); } });
(async () => { state.backend = window.location.origin; const health = await fetch(`${state.backend}/health`).then((response) => response.json()); $('app-version').textContent = `v${health.version}`; drawWaveform(); renderTimeline(); updatePlayhead(0); })();
