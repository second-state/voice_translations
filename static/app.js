'use strict';

const ALL_LANGS = [
  'English', 'Korean', 'Chinese', 'Japanese', 'Spanish', 'French', 'German',
  'Italian', 'Portuguese', 'Russian', 'Arabic', 'Hindi', 'Vietnamese', 'Thai',
];

// ISO 639-1 codes (plus common country-code slips) -> display names, so
// config values and ASR results always collapse onto the chip names above.
const LANG_CODES = {
  en: 'English', ko: 'Korean', kr: 'Korean', zh: 'Chinese', cn: 'Chinese',
  ja: 'Japanese', jp: 'Japanese', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
  vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', nl: 'Dutch', tr: 'Turkish',
  pl: 'Polish', uk: 'Ukrainian', sv: 'Swedish',
};

function langName(value) {
  if (!value) return '';
  const key = value.trim().toLowerCase();
  if (LANG_CODES[key]) return LANG_CODES[key];
  const known = ALL_LANGS.find((l) => l.toLowerCase() === key);
  return known || key.charAt(0).toUpperCase() + key.slice(1);
}

const state = {
  cfg: null,
  targets: new Set(),
  messages: [],
  running: false,
  sessionStart: null,
};
let msgCounter = 0;

const $ = (id) => document.getElementById(id);

init().catch((err) => setStatus('error', 'Config load failed: ' + err.message));

async function init() {
  const resp = await fetch('/api/config');
  if (!resp.ok) throw new Error(await resp.text());
  state.cfg = await resp.json();
  state.cfg.default_source = langName(state.cfg.default_source);
  for (const lang of state.cfg.default_targets) state.targets.add(langName(lang));
  renderLangChips();
  refreshSrtTracks();
  $('micBtn').addEventListener('click', toggleMic);
  $('exportBtn').addEventListener('click', exportSrt);
  $('clearBtn').addEventListener('click', clearAll);
}

/* ---------- Language selection ---------- */

function renderLangChips() {
  const wrap = $('langChips');
  wrap.innerHTML = '';
  for (const lang of ALL_LANGS) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.targets.has(lang) ? ' on' : '');
    chip.textContent = lang;
    chip.addEventListener('click', () => {
      if (state.targets.has(lang)) state.targets.delete(lang);
      else state.targets.add(lang);
      chip.classList.toggle('on');
      refreshSrtTracks();
    });
    wrap.appendChild(chip);
  }
}

function refreshSrtTracks() {
  const sel = $('srtTrack');
  const prev = sel.value;
  sel.innerHTML = '';
  const options = [['source', 'Source (as spoken)']]
    .concat([...state.targets].map((l) => [l, l]));
  for (const [value, label] of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = 'SRT: ' + label;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function sameLang(a, b) {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ---------- Microphone + voice activity detection ---------- */

let mediaStream = null;
let audioCtx = null;
let analyser = null;
let recorder = null;
let tickTimer = null;
let mimeType = '';
let fileExt = 'webm';
let speechDetected = false;
let lastVoiceAt = 0;
let utterStart = 0;
let recStartedAt = 0;

async function toggleMic() {
  if (state.running) {
    stopMic();
  } else {
    try {
      await startMic();
    } catch (err) {
      setStatus('error', 'Mic error: ' + err.message);
    }
  }
}

async function startMic() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    mimeType = 'audio/webm;codecs=opus'; fileExt = 'webm';
  } else if (MediaRecorder.isTypeSupported('audio/webm')) {
    mimeType = 'audio/webm'; fileExt = 'webm';
  } else {
    mimeType = 'audio/mp4'; fileExt = 'mp4';   // Safari
  }

  state.running = true;
  state.sessionStart ??= Date.now();
  startRecorder();
  tickTimer = setInterval(tick, 20);
  $('micBtn').textContent = 'Stop listening';
  $('micBtn').classList.add('live');
  setStatus('listening');
}

function stopMic() {
  state.running = false;
  clearInterval(tickTimer);
  if (recorder && recorder.state !== 'inactive') finishRecorder(speechDetected);
  mediaStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  mediaStream = audioCtx = analyser = recorder = null;
  $('micBtn').textContent = 'Start listening';
  $('micBtn').classList.remove('live');
  $('meterFill').style.width = '0%';
  setStatus('idle');
}

function startRecorder() {
  const chunks = [];
  recorder = new MediaRecorder(mediaStream, { mimeType });
  recorder.chunks = chunks;
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start(100);
  recStartedAt = Date.now();
  speechDetected = false;
}

function tick() {
  if (!analyser) return;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  $('meterFill').style.width = Math.min(100, Math.round(rms * 600)) + '%';

  const now = Date.now();
  if (rms > state.cfg.silence_threshold) {
    if (!speechDetected) {
      speechDetected = true;
      utterStart = now;
      setStatus('speaking');
    }
    lastVoiceAt = now;
  }

  if (speechDetected) {
    const brokeOff = now - lastVoiceAt >= state.cfg.sentence_break_ms;
    const tooLong = now - utterStart >= state.cfg.max_utterance_ms;
    if (brokeOff || tooLong) {
      finishRecorder(true);
      if (state.running) startRecorder();
      setStatus('listening');
    }
  } else if (now - recStartedAt > 5000) {
    // Nothing but silence so far: restart to keep the eventual blob small.
    finishRecorder(false);
    if (state.running) startRecorder();
  }
}

function finishRecorder(send) {
  const rec = recorder;
  if (!rec || rec.state === 'inactive') return;
  const start = utterStart;
  const end = Date.now();
  const shouldSend = send && speechDetected && end - start >= state.cfg.min_speech_ms;
  rec.onstop = () => {
    if (shouldSend) {
      const blob = new Blob(rec.chunks, { type: mimeType });
      handleUtterance(blob, start, end);
    }
  };
  rec.stop();
  speechDetected = false;
}

/* ---------- Transcription + translation pipeline ---------- */

async function handleUtterance(blob, start, end) {
  const msg = {
    id: ++msgCounter,
    start,
    end,
    sourceLang: null,
    sourceText: '',
    translations: {},
    el: null,
  };
  state.messages.push(msg);
  renderMessage(msg);

  const form = new FormData();
  form.append('audio', blob, `utterance-${msg.id}.${fileExt}`);
  try {
    const resp = await fetch('/api/transcribe', { method: 'POST', body: form });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    const text = (data.text || '').trim();
    if (!text) {
      removeMessage(msg);
      return;
    }
    msg.sourceText = text;
    msg.sourceLang = langName(data.language) || state.cfg.default_source;
    updateSourceBlob(msg);

    // One request per target language, all streaming concurrently.
    for (const lang of [...state.targets]) {
      if (sameLang(lang, msg.sourceLang)) {
        msg.translations[lang] = { text, done: true, original: true };
        addTranslationBlob(msg, lang);
      } else {
        streamTranslation(msg, lang);
      }
    }
  } catch (err) {
    msg.el.classList.add('error');
    const blobText = msg.el.querySelector('.source .blob-text');
    blobText.classList.remove('pending');
    blobText.textContent = 'Transcription failed: ' + err.message;
  }
}

async function streamTranslation(msg, lang) {
  msg.translations[lang] = { text: '', done: false };
  addTranslationBlob(msg, lang);
  const blobText = msg.el.querySelector(`.blob[data-lang="${lang}"] .blob-text`);
  const entry = msg.translations[lang];
  try {
    const resp = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: msg.sourceText,
        source_lang: msg.sourceLang,
        target_lang: lang,
        context: buildContext(msg, lang),
      }),
    });
    if (!resp.ok || !resp.body) {
      throw new Error((await resp.text()) || `HTTP ${resp.status}`);
    }

    // SSE over POST: parse "data: ..." events from the response stream.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'delta') {
            entry.text += ev.text;
            blobText.textContent = entry.text;
            autoscroll();
          } else if (ev.type === 'error') {
            throw new Error(ev.message);
          } else if (ev.type === 'done') {
            entry.done = true;
          }
        }
      }
    }
    entry.done = true;
    blobText.classList.remove('streaming');
  } catch (err) {
    entry.done = true;
    blobText.classList.remove('streaming');
    blobText.textContent = (entry.text ? entry.text + ' ' : '') + '⚠ ' + err.message;
  }
}

function buildContext(msg, lang) {
  const prior = state.messages.filter((m) => m !== msg && m.sourceText);
  return prior.slice(-state.cfg.context_messages).map((m) => ({
    source: m.sourceText,
    translation: m.translations[lang]?.text || '',
  }));
}

/* ---------- Rendering ---------- */

function renderMessage(msg) {
  $('empty')?.remove();
  const el = document.createElement('article');
  el.className = 'msg';
  el.innerHTML = `
    <div class="msg-head">
      <span class="msg-idx">#${msg.id}</span>
      <time>${fmtClock(msg.start)}</time>
      <span class="msg-dur">${((msg.end - msg.start) / 1000).toFixed(1)}s</span>
      <span class="lang-badge">detecting…</span>
    </div>
    <div class="blob source">
      <div class="blob-lang">Source</div>
      <div class="blob-text pending">Transcribing…</div>
    </div>
    <div class="blobs"></div>`;
  msg.el = el;
  $('messages').appendChild(el);
  autoscroll(true);
}

function updateSourceBlob(msg) {
  msg.el.querySelector('.lang-badge').textContent = msg.sourceLang;
  msg.el.querySelector('.source .blob-lang').textContent = msg.sourceLang + ' · source';
  const blobText = msg.el.querySelector('.source .blob-text');
  blobText.classList.remove('pending');
  blobText.textContent = msg.sourceText;
}

function addTranslationBlob(msg, lang) {
  const entry = msg.translations[lang];
  const div = document.createElement('div');
  div.className = 'blob translation';
  div.dataset.lang = lang;
  const label = document.createElement('div');
  label.className = 'blob-lang';
  label.textContent = lang + (entry.original ? ' · same as source' : '');
  const text = document.createElement('div');
  text.className = 'blob-text' + (entry.done ? '' : ' streaming');
  text.textContent = entry.text;
  div.append(label, text);
  msg.el.querySelector('.blobs').appendChild(div);
  autoscroll();
}

function removeMessage(msg) {
  msg.el?.remove();
  const idx = state.messages.indexOf(msg);
  if (idx >= 0) state.messages.splice(idx, 1);
}

function clearAll() {
  state.messages = [];
  msgCounter = 0;
  state.sessionStart = state.running ? Date.now() : null;
  const container = $('messages');
  container.innerHTML = '<div id="empty" class="empty">Press <strong>Start listening</strong> and speak.<br>' +
    'Each sentence is transcribed, then translated into every selected language in parallel.</div>';
}

function autoscroll(force) {
  const c = $('messages');
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 160;
  if (force || nearBottom) c.scrollTop = c.scrollHeight;
}

function setStatus(kind, detail) {
  const el = $('status');
  el.className = 'status ' + kind;
  el.textContent = detail ||
    ({ idle: 'Idle', listening: 'Listening', speaking: 'Speaking…', error: 'Error' }[kind] || kind);
  if (detail) console.warn(detail);
}

/* ---------- SRT export ---------- */

function exportSrt() {
  const track = $('srtTrack').value;
  const msgs = state.messages.filter((m) => m.sourceText);
  const base = state.sessionStart ?? msgs[0]?.start ?? 0;
  let n = 0;
  let out = '';
  for (const m of msgs) {
    const text = track === 'source' ? m.sourceText : m.translations[track]?.text || '';
    if (!text.trim()) continue;
    n++;
    out += `${n}\n${fmtSrt(m.start - base)} --> ${fmtSrt(m.end - base)}\n${text.trim()}\n\n`;
  }
  if (!n) {
    setStatus('error', 'Nothing to export for that track');
    return;
  }
  const blob = new Blob([out], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `transcript-${track.toLowerCase()}.srt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fmtSrt(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const frac = ms % 1000;
  const p = (v, l = 2) => String(v).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(frac, 3)}`;
}

function fmtClock(ts) {
  return new Date(ts).toTimeString().slice(0, 8);
}
