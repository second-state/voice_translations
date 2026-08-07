'use strict';

const ALL_LANGS = ['English', 'Chinese', 'Korean', 'Japanese'];

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

// Display name -> ISO 639-1 code (first code listed for each name wins).
const NAME_TO_CODE = {};
for (const [code, name] of Object.entries(LANG_CODES)) {
  if (!(name in NAME_TO_CODE)) NAME_TO_CODE[name] = code;
}

const state = {
  cfg: null,
  targets: new Set(),
  sourceOverride: 'auto',
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
  renderSourceSelect();
  $('micBtn').addEventListener('click', toggleMic);
  $('exportBtn').addEventListener('click', exportSrt);
  $('clearBtn').addEventListener('click', clearAll);
  $('settingsToggle').addEventListener('click', () => {
    const collapsed = $('settings').classList.toggle('collapsed');
    const toggle = $('settingsToggle');
    toggle.textContent = collapsed ? 'Options ▸' : 'Options ▾';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
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
    });
    wrap.appendChild(chip);
  }
}

function renderSourceSelect() {
  const sel = $('sourceLang');
  sel.innerHTML = '';
  const options = [['auto', 'Auto-detect']].concat(ALL_LANGS.map((l) => [l, l]));
  for (const [value, label] of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.value = 'auto';
  sel.addEventListener('change', () => {
    state.sourceOverride = sel.value;
  });
}

function sameLang(a, b) {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ---------- Microphone + Silero VAD (@ricky0123/vad-web, local assets) ----------
   The Silero neural VAD decides what is human speech: audio is only sent to
   the server when the model detects a speech segment, so keyboard noise,
   music, and background hum never trigger transcription. */

let vadInstance = null;
let utterStart = 0;
let maxTimer = null;

async function toggleMic() {
  if (state.running) {
    await stopMic();
  } else {
    try {
      await startMic();
    } catch (err) {
      setStatus('error', 'Mic error: ' + err.message);
    }
  }
}

async function startMic() {
  if (!vadInstance) {
    setStatus('listening', 'Loading VAD model…');
    vadInstance = await vad.MicVAD.new({
      model: 'v5',
      baseAssetPath: '/vendor/',
      onnxWASMBasePath: '/vendor/',
      positiveSpeechThreshold: state.cfg.vad_positive_threshold,
      negativeSpeechThreshold: state.cfg.vad_negative_threshold,
      redemptionMs: state.cfg.sentence_break_ms,
      minSpeechMs: state.cfg.min_speech_ms,
      preSpeechPadMs: state.cfg.pre_speech_pad_ms,
      submitUserSpeechOnPause: true,
      onFrameProcessed: (probs, frame) => {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const rms = Math.sqrt(sum / frame.length);
        $('meterFill').style.width = Math.min(100, Math.round(rms * 600)) + '%';
      },
      onSpeechStart: () => {
        utterStart = Date.now() - state.cfg.pre_speech_pad_ms;
        setStatus('speaking');
        clearTimeout(maxTimer);
        maxTimer = setTimeout(forceBreak, state.cfg.max_utterance_ms);
      },
      onVADMisfire: () => {
        // Detected sound was shorter than min_speech_ms: not speech.
        clearTimeout(maxTimer);
        if (state.running) setStatus('listening');
      },
      onSpeechEnd: (audio) => {
        clearTimeout(maxTimer);
        if (state.running) setStatus('listening');
        // `audio` is Float32Array PCM at 16 kHz containing exactly the
        // detected speech segment (plus pre-speech padding).
        handleUtterance(encodeWav(audio, 16000), utterStart || Date.now(), Date.now());
      },
    });
  }
  vadInstance.start();
  state.running = true;
  state.sessionStart ??= Date.now();
  $('micBtn').textContent = 'Stop listening';
  $('micBtn').classList.add('live');
  setStatus('listening');
}

async function stopMic() {
  state.running = false;
  clearTimeout(maxTimer);
  if (vadInstance) {
    const inst = vadInstance;
    vadInstance = null;
    await inst.pause();   // submits any in-progress speech, releases the mic
    await inst.destroy();
  }
  $('micBtn').textContent = 'Start listening';
  $('micBtn').classList.remove('live');
  $('meterFill').style.width = '0%';
  setStatus('idle');
}

// Long monologue: force a sentence break so translation stays live; the VAD
// submits the audio captured so far and keeps listening.
async function forceBreak() {
  if (!state.running || !vadInstance) return;
  await vadInstance.pause();
  if (state.running && vadInstance) vadInstance.start();
}

// Float32 PCM -> 16-bit mono WAV blob.
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
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
  form.append('audio', blob, `utterance-${msg.id}.wav`);
  const override = state.sourceOverride !== 'auto' ? state.sourceOverride : null;
  if (override) form.append('language', NAME_TO_CODE[override] || override);
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
    msg.sourceLang = override || langName(data.language) || state.cfg.default_source;
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
            // The server sends the sanitized full text with `done`; use it as
            // the authoritative version of the translation.
            if (typeof ev.text === 'string' && ev.text) {
              entry.text = ev.text;
              blobText.textContent = entry.text;
            }
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

// One .srt file per track: the source as spoken, plus each selected language.
function exportSrt() {
  const msgs = state.messages.filter((m) => m.sourceText);
  if (!msgs.length) {
    setStatus('error', 'Nothing to export yet');
    return;
  }
  const tracks = [['source', (m) => m.sourceText]]
    .concat([...state.targets].map((lang) => [lang, (m) => m.translations[lang]?.text || '']));
  let exported = 0;
  for (const [track, textOf] of tracks) {
    const base = state.sessionStart ?? msgs[0].start;
    let n = 0;
    let out = '';
    for (const m of msgs) {
      const text = (textOf(m) || '').trim();
      if (!text) continue;
      n++;
      out += `${n}\n${fmtSrt(m.start - base)} --> ${fmtSrt(m.end - base)}\n${text}\n\n`;
    }
    if (!n) continue;
    downloadFile(`transcript-${track.toLowerCase()}.srt`, out);
    exported++;
  }
  if (!exported) setStatus('error', 'Nothing to export yet');
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
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
