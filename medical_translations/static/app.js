'use strict';

// Server-side redirect handles proxies that set X-Forwarded-Proto; this
// catches any that don't. Local plain-HTTP development stays untouched.
if (location.protocol === 'http:'
    && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  location.replace('https://' + location.host + location.pathname + location.search);
}

/* Keep the screen awake while this tab is open: a live interpretation
   session must not end because the device locked itself. The lock is
   auto-released when the tab is hidden, so it is re-acquired on return,
   and on first tap for browsers that only grant it after a gesture. */
let wakeLock = null;

async function keepScreenAwake() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    console.warn('screen wake lock unavailable:', err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) keepScreenAwake();
});
document.addEventListener('click', () => { if (!wakeLock) keepScreenAwake(); }, { capture: true });
keepScreenAwake();

/* Medical Translator — browser side.
   The speech capture and VAD handling here is the upstream voice translator's,
   unchanged in substance; what differs is the pipeline downstream of a
   detected utterance. Instead of fanning one utterance out to a set of target
   languages, every turn belongs to one of two speakers — the clinician or the
   patient — and is interpreted into the other one's language. */

// Display name -> ISO 639-1 code, used to pin the recognizer's language when
// the user names who is speaking. Mirrors normalize_language() on the server.
const NAME_TO_CODE = {
  English: 'en', Spanish: 'es', Chinese: 'zh', Cantonese: 'yue', Vietnamese: 'vi',
  Tagalog: 'tl', Korean: 'ko', Arabic: 'ar', Russian: 'ru', 'Haitian Creole': 'ht',
  Portuguese: 'pt', French: 'fr', Hindi: 'hi', Bengali: 'bn', Urdu: 'ur',
  Persian: 'fa', Japanese: 'ja', Somali: 'so', Amharic: 'am', Nepali: 'ne',
  Burmese: 'my', Ukrainian: 'uk', Polish: 'pl', German: 'de', Italian: 'it',
  Dutch: 'nl', Turkish: 'tr', Thai: 'th', Indonesian: 'id', Swedish: 'sv',
  Norwegian: 'no', Icelandic: 'is', Hebrew: 'he', Punjabi: 'pa', Tamil: 'ta',
  Telugu: 'te', Gujarati: 'gu', Marathi: 'mr', Swahili: 'sw', Khmer: 'km',
  Lao: 'lo', Hmong: 'hmn', Romanian: 'ro', Greek: 'el', Hungarian: 'hu',
  Czech: 'cs', Danish: 'da', Finnish: 'fi',
};

const CODE_TO_NAME = {};
for (const [name, code] of Object.entries(NAME_TO_CODE)) {
  if (!(code in CODE_TO_NAME)) CODE_TO_NAME[code] = name;
}

function langName(value) {
  if (!value) return '';
  const key = value.trim();
  if (CODE_TO_NAME[key.toLowerCase()]) return CODE_TO_NAME[key.toLowerCase()];
  const known = Object.keys(NAME_TO_CODE).find((n) => n.toLowerCase() === key.toLowerCase());
  return known || key.charAt(0).toUpperCase() + key.slice(1);
}

function sameLang(a, b) {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

const state = {
  cfg: null,
  specialty: null,
  clinicianLang: 'English',
  patientLang: 'Spanish',
  messages: [],
  running: false,
  sessionStart: null,
};
let msgCounter = 0;
let emptyStateHtml = '';

const $ = (id) => document.getElementById(id);

init().catch((err) => setStatus('error', 'Config load failed: ' + err.message));

async function init() {
  emptyStateHtml = $('messages').innerHTML;
  const resp = await fetch('/api/config');
  if (!resp.ok) throw new Error(await resp.text());
  state.cfg = await resp.json();
  state.clinicianLang = langName(state.cfg.clinician_language);
  state.patientLang = langName(state.cfg.patient_language);

  renderSpecialties();
  renderLanguageSelects();
  restoreHistory();
  window.addEventListener('beforeunload', saveHistory);

  $('micBtn').addEventListener('click', toggleMic);
  $('exportBtn').addEventListener('click', exportSrt);
  $('clearBtn').addEventListener('click', clearAll);
  $('swapBtn').addEventListener('click', swapLanguages);
  $('settingsToggle').addEventListener('click', () => {
    const collapsed = $('settings').classList.toggle('collapsed');
    const toggle = $('settingsToggle');
    toggle.textContent = collapsed ? 'Encounter setup ▸' : 'Encounter setup ▾';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
}

/* ---------- Encounter setup ---------- */

function renderSpecialties() {
  const sel = $('specialty');
  sel.innerHTML = '';
  for (const spec of state.cfg.specialties) {
    const opt = document.createElement('option');
    opt.value = spec.id;
    opt.textContent = `${spec.icon}  ${spec.label}`;
    sel.appendChild(opt);
  }
  sel.value = state.cfg.default_specialty;
  sel.addEventListener('change', () => applySpecialty(sel.value));
  applySpecialty(sel.value);
}

function applySpecialty(id) {
  state.specialty = state.cfg.specialties.find((s) => s.id === id) || state.cfg.specialties[0];
  $('specialtyBlurb').textContent = state.specialty.blurb;
  $('specialtyTag').textContent = `${state.specialty.icon} ${state.specialty.label}`;
}

function renderLanguageSelects() {
  for (const [id, current] of [['clinicianLang', state.clinicianLang], ['patientLang', state.patientLang]]) {
    const sel = $(id);
    sel.innerHTML = '';
    for (const lang of state.cfg.languages) {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = lang;
      sel.appendChild(opt);
    }
    sel.value = current;
    sel.addEventListener('change', () => {
      if (id === 'clinicianLang') state.clinicianLang = sel.value;
      else state.patientLang = sel.value;
    });
  }
}

function swapLanguages() {
  [state.clinicianLang, state.patientLang] = [state.patientLang, state.clinicianLang];
  $('clinicianLang').value = state.clinicianLang;
  $('patientLang').value = state.patientLang;
}

function langFor(role) {
  return role === 'clinician' ? state.clinicianLang : state.patientLang;
}

// The server has already constrained the turn to one of the encounter's two
// languages, so this is a straight comparison: anything that is not the
// clinician's language is the patient speaking.
function roleFor(turnLang) {
  return sameLang(turnLang, state.clinicianLang) ? 'clinician' : 'patient';
}

function otherRole(role) {
  return role === 'clinician' ? 'patient' : 'clinician';
}

/* ---------- Microphone + Silero VAD (@ricky0123/vad-web, local assets) ----------
   The Silero neural VAD decides what is human speech: audio is only sent to
   the server when the model detects a speech segment, so keyboard noise,
   paper rustling, and room hum never trigger transcription. */

let vadInstance = null;
let utterStart = 0;
let maxTimer = null;
let lastSegment = { key: '', at: 0 };

// Fingerprint a speech segment cheaply (length plus a few probe samples).
// The VAD can deliver the same segment twice when a natural speech end races
// the max-utterance force-break; identical audio yields an identical key.
function segmentKey(audio) {
  const probe = (i) => (audio[i] || 0).toFixed(6);
  return [
    audio.length,
    probe(0),
    probe(audio.length >> 2),
    probe(audio.length >> 1),
    probe(audio.length - 1),
  ].join(':');
}

// Re-entrancy guard: a second tap while the VAD model is still loading must
// not create a second MicVAD instance (each would fire onSpeechEnd for every
// utterance, duplicating turns, and the first instance would leak).
let micBusy = false;

async function toggleMic() {
  if (micBusy) return;
  micBusy = true;
  $('micBtn').disabled = true;
  try {
    if (state.running) {
      await stopMic();
    } else {
      await startMic();
    }
  } catch (err) {
    setStatus('error', 'Mic error: ' + err.message);
    if (!state.running) {
      $('micBtn').textContent = 'Start listening';
      $('micBtn').classList.remove('live');
    }
  } finally {
    micBusy = false;
    $('micBtn').disabled = false;
  }
}

// Some Android WebViews only expose the legacy prefixed getUserMedia; bridge
// it onto navigator.mediaDevices so the VAD's stream request can use it.
function polyfillMediaDevices() {
  if (navigator.mediaDevices?.getUserMedia) return true;
  const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia
    || navigator.mozGetUserMedia;
  if (!legacy) return false;
  if (!navigator.mediaDevices) navigator.mediaDevices = {};
  navigator.mediaDevices.getUserMedia = (constraints) =>
    new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
  return true;
}

async function startMic() {
  // Diagnose a missing microphone API precisely: insecure origin, or a
  // browser/WebView that does not expose mediaDevices at all.
  if (!polyfillMediaDevices()) {
    console.warn('mediaDevices missing; secureContext=' + window.isSecureContext
      + ' ua=' + navigator.userAgent);
    if (!window.isSecureContext) {
      throw new Error(
        'microphone access needs HTTPS. Open this page via an https:// URL ' +
        '(e.g. a Cloudflare tunnel) or on localhost.'
      );
    }
    throw new Error(
      'this browser does not expose the microphone API. If you opened the ' +
      'link inside another app (chat app, QR scanner) or a privacy browser, ' +
      'open it in Chrome directly instead.'
    );
  }
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
        const key = segmentKey(audio);
        const now = Date.now();
        if (key === lastSegment.key && now - lastSegment.at < 3000) {
          console.warn('duplicate VAD segment dropped');
          return;
        }
        lastSegment = { key, at: now };
        // `audio` is Float32Array PCM at 16 kHz containing exactly the
        // detected speech segment (plus pre-speech padding). Quiet or distant
        // speakers — a patient across an exam room — are boosted to a healthy
        // level before transcription.
        handleUtterance(encodeWav(normalizePeak(audio), 16000), utterStart || now, now);
      },
    });
  }
  vadInstance.start();
  state.running = true;
  state.sessionStart ??= Date.now();
  // Only flip once fully started; the button stays grayed out until then.
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

// Long explanation: force a sentence break so interpreting stays live; the VAD
// submits the audio captured so far and keeps listening.
async function forceBreak() {
  if (!state.running || !vadInstance) return;
  await vadInstance.pause();
  if (state.running && vadInstance) vadInstance.start();
}

// Peak-normalize quiet recordings so distant speakers transcribe well.
// Runs after VAD detection, so it only affects what the ASR hears.
function normalizePeak(samples, target = 0.9, maxGain = 10) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return samples;          // effectively silence
  const gain = Math.min(maxGain, target / peak);
  if (gain <= 1) return samples;            // already loud enough
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
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

/* ---------- Transcription + interpreting pipeline ---------- */

async function handleUtterance(blob, start, end) {
  // The specialty and languages are captured per turn, so changing them
  // mid-encounter does not retroactively relabel what came before.
  const msg = {
    id: ++msgCounter,
    start,
    end,
    specialty: state.specialty.id,
    specialtyLabel: state.specialty.label,
    // Inferred from the detected language once transcription returns; the
    // per-turn Clinician/Patient toggle corrects a wrong guess.
    role: null,
    sourceLang: null,
    targetLang: null,
    sourceText: '',
    clean: null,
    translation: null,
    el: null,
  };
  state.messages.push(msg);
  renderMessage(msg);

  const form = new FormData();
  form.append('audio', blob, `turn-${msg.id}.wav`);
  // The encounter's two languages, so the server resolves the recognizer's
  // answer against what this visit is actually using rather than the
  // configured default.
  form.append('clinician_language', state.clinicianLang);
  form.append('patient_language', state.patientLang);

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
    // What the recognizer itself reported, kept for the deviation flag. When
    // the language was pinned, some services echo the pin; others report what
    // they actually heard, which is the interesting case.
    // The server constrains the recognizer's answer to the encounter's two
    // languages: `language` is what to treat the turn as, `detected` is what
    // the recognizer actually claimed, and they differ when it named a
    // language nobody here speaks.
    msg.sourceLang = langName(data.language) || state.clinicianLang;
    msg.heardLang = langName(data.detected) || null;
    msg.substituted = !!data.substituted;
    msg.role ??= roleFor(msg.sourceLang);
    msg.targetLang = langFor(otherRole(msg.role));
    updateMessageHead(msg);
    updateSourceBlob(msg);
    saveHistory();

    // The source blob streams a disfluency-free version of the raw transcript;
    // the interpretation streams in parallel into its own blob.
    msg.clean = { text: '', done: false };
    const jobs = [streamCleanSource(msg)];
    if (sameLang(msg.sourceLang, msg.targetLang)) {
      // Both parties are on the same language for this turn; nothing to
      // interpret, and saying so is more honest than echoing the text twice.
      addSameLangNote(msg);
    } else {
      msg.translation = { text: '', done: false };
      addTranslationBlob(msg);
      jobs.push(streamTranslation(msg));
    }
    await Promise.all(jobs);
    checkNumbers(msg);
    saveHistory();
  } catch (err) {
    msg.el.classList.add('error');
    const blobText = msg.el.querySelector('.source .blob-text');
    blobText.classList.remove('pending');
    blobText.textContent = 'Transcription failed: ' + err.message;
  }
}

function streamTranslation(msg) {
  const el = msg.el.querySelector('.translation .blob-text');
  return streamTurn(msg, msg.targetLang, translationContext(msg), msg.translation, [el], null);
}

// Same-language cleanup of the spoken text, streamed into the source blob.
// On failure the raw transcript stays on screen instead of an error.
function streamCleanSource(msg) {
  const el = msg.el.querySelector('.source .blob-text');
  el.classList.add('streaming');
  return streamTurn(msg, msg.sourceLang, cleanupContext(msg), msg.clean, [el], msg.sourceText);
}

// Shared SSE-over-POST reader: streams /api/translate output into `entry` and
// every element in `els`.
async function streamTurn(msg, targetLang, context, entry, els, fallbackText) {
  const show = (text) => { for (const el of els) el.textContent = text; };
  try {
    const resp = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: msg.sourceText,
        source_lang: msg.sourceLang,
        target_lang: targetLang,
        specialty: msg.specialty,
        speaker: msg.role,
        context,
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
            show(entry.text);
            autoscroll();
          } else if (ev.type === 'error') {
            throw new Error(ev.message);
          } else if (ev.type === 'done') {
            entry.done = true;
            // The server sends the sanitized full text with `done`; use it as
            // the authoritative version.
            if (typeof ev.text === 'string' && ev.text) {
              entry.text = ev.text;
              show(entry.text);
            }
          }
        }
      }
    }
    entry.done = true;
    for (const el of els) el.classList.remove('streaming');
  } catch (err) {
    entry.done = true;
    for (const el of els) el.classList.remove('streaming');
    if (fallbackText && !entry.text) {
      entry.text = fallbackText;
      show(fallbackText);
      console.warn('cleanup failed, keeping raw transcript:', err.message);
    } else {
      show((entry.text ? entry.text + ' ' : '') + '⚠ ' + err.message);
    }
  }
}

// Prior turns interpreted into the same language, so the model keeps
// terminology and pronouns consistent within one direction of the encounter.
function translationContext(msg) {
  return state.messages
    .filter((m) => m !== msg && m.sourceText && m.translation?.text
      && sameLang(m.targetLang, msg.targetLang))
    .slice(-state.cfg.context_messages)
    .map((m) => ({ source: m.sourceText, translation: m.translation.text }));
}

function cleanupContext(msg) {
  return state.messages
    .filter((m) => m !== msg && m.sourceText && m.clean?.text
      && sameLang(m.sourceLang, msg.sourceLang))
    .slice(-state.cfg.context_messages)
    .map((m) => ({ source: m.sourceText, translation: m.clean.text }));
}

/* ---------- Number safety check ----------
   Doses, times, and vitals are the content whose loss does the most harm, and
   a dropped figure is one of the few interpreting errors detectable without a
   second model. Advisory only: a target language that spells numbers out in
   words will trip it, so it prompts a look rather than declaring an error. */

// Digits from the scripts most likely to appear in an interpretation, mapped
// back to ASCII so "٥ مل" and "5 mL" compare equal.
const OTHER_DIGITS = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹०१२३४५६७८९০১২৩৪৫৬৭৮৯๐๑๒๓๔๕๖๗๘๙０１２３４５６７８９';
const OTHER_DIGITS_RE = new RegExp('[' + OTHER_DIGITS + ']', 'gu');

function toAsciiDigits(text) {
  return text.replace(OTHER_DIGITS_RE, (c) => String(OTHER_DIGITS.indexOf(c) % 10));
}

// Numeric tokens, with thousands separators removed so 1,000 matches 1000.
function numberTokens(text) {
  const normalized = toAsciiDigits(text).replace(/(\d),(?=\d{3}\b)/g, '$1');
  return normalized.match(/\d+(?:[.٫]\d+)?/g) || [];
}

function checkNumbers(msg) {
  if (!msg.translation?.text || !msg.clean?.text) return;
  const spoken = numberTokens(msg.clean.text);
  if (!spoken.length) return;
  const rendered = new Set(numberTokens(msg.translation.text));
  const missing = [...new Set(spoken.filter((n) => !rendered.has(n)))];
  if (!missing.length) return;

  const note = document.createElement('div');
  note.className = 'number-flag';
  note.innerHTML = '<span>⚠</span><span>Check the numbers: <b></b> '
    + 'appeared in the speech but not in the translation. '
    + 'Some languages write figures as words — confirm before acting on it.</span>';
  note.querySelector('b').textContent = missing.join(', ');
  msg.el.querySelector('.translation').appendChild(note);
  autoscroll();
}

/* ---------- Rendering ---------- */

function renderMessage(msg) {
  $('empty')?.remove();
  const el = document.createElement('article');
  el.className = 'msg';
  if (msg.role) el.dataset.role = msg.role;
  el.innerHTML = `
    <div class="msg-head">
      <span class="role-toggle" title="Who spoke this turn">
        <button type="button" data-set-role="clinician">Clinician</button>
        <button type="button" data-set-role="patient">Patient</button>
      </span>
      <span class="lang-warn" hidden></span>
      <time>${fmtClock(msg.start)}</time>
      <span class="msg-dur">${((msg.end - msg.start) / 1000).toFixed(1)}s</span>
      <span class="lang-badge"></span>
    </div>
    <div class="blob source">
      <div class="blob-lang"><span class="blob-label">Spoken</span></div>
      <div class="blob-text pending">Transcribing…</div>
    </div>`;
  for (const btn of el.querySelectorAll('[data-set-role]')) {
    btn.disabled = true;
    btn.addEventListener('click', () => reassignRole(msg, btn.dataset.setRole));
  }
  if (msg.role) {
    el.querySelector(`[data-set-role="${msg.role}"]`).classList.add('on');
  }
  if (state.cfg.tts_enabled) {
    el.querySelector('.source .blob-lang')
      .appendChild(makeSpeakBtn(() => msg.clean?.text || msg.sourceText, () => msg.role));
  }
  msg.el = el;
  $('messages').appendChild(el);
  autoscroll(true);
}

function updateMessageHead(msg) {
  msg.el.dataset.role = msg.role;
  for (const btn of msg.el.querySelectorAll('[data-set-role]')) {
    btn.disabled = !msg.sourceText;
    btn.classList.toggle('on', btn.dataset.setRole === msg.role);
    btn.title = btn.dataset.setRole === msg.role
      ? 'Speaker of this turn'
      : 'Reassign this turn and translate again';
  }
  msg.el.querySelector('.lang-badge').textContent = sameLang(msg.sourceLang, msg.targetLang)
    ? msg.sourceLang
    : `${msg.sourceLang} → ${msg.targetLang}`;

  // Flag a turn whose detected language is not what this speaker's preset
  // says it should be: either the wrong preset, or the wrong speaker.
  const warn = msg.el.querySelector('.lang-warn');
  const expected = langFor(msg.role);
  if (msg.substituted && msg.heardLang) {
    // The recognizer named a language this encounter does not involve.
    // The turn was kept in the patient's language rather than interpreted
    // toward a language nobody here speaks; say so, since the reassignment
    // buttons are the fix if the guess was wrong.
    warn.hidden = false;
    warn.textContent = `⚠ recognizer said ${msg.heardLang}; treated as ${msg.sourceLang}`;
  } else if (msg.heardLang && !sameLang(msg.heardLang, expected)) {
    warn.hidden = false;
    warn.textContent = `⚠ sounds like ${msg.heardLang}, expected ${expected}`;
  } else {
    warn.hidden = true;
  }
}

// Reassign a finished turn to the other speaker: the direction flips, so the
// interpretation is discarded and re-run toward the new listener's language.
function reassignRole(msg, role) {
  if (!msg.sourceText || msg.role === role) return;
  msg.role = role;
  msg.targetLang = langFor(otherRole(role));
  msg.el.querySelector('.translation')?.remove();
  msg.el.querySelector('.same-lang-note')?.remove();
  for (const n of msg.el.querySelectorAll('.number-flag')) n.remove();
  updateMessageHead(msg);
  if (sameLang(msg.sourceLang, msg.targetLang)) {
    addSameLangNote(msg);
    saveHistory();
    return;
  }
  msg.translation = { text: '', done: false };
  addTranslationBlob(msg);
  streamTranslation(msg).then(() => {
    checkNumbers(msg);
    saveHistory();
  });
}

function updateSourceBlob(msg) {
  msg.el.querySelector('.source .blob-label').textContent = `${msg.sourceLang} · as spoken`;
  const blobText = msg.el.querySelector('.source .blob-text');
  blobText.classList.remove('pending');
  blobText.textContent = msg.sourceText;
}

function addTranslationBlob(msg) {
  const div = document.createElement('div');
  div.className = 'blob translation';
  const label = document.createElement('div');
  label.className = 'blob-lang';
  const name = document.createElement('span');
  name.className = 'blob-label';
  name.textContent = `${msg.targetLang} · translated`;
  label.appendChild(name);
  if (state.cfg.tts_enabled) {
    label.appendChild(makeSpeakBtn(() => msg.translation?.text || '', () => msg.role));
  }
  const text = document.createElement('div');
  text.className = 'blob-text streaming';
  div.append(label, text);
  msg.el.appendChild(div);
  autoscroll();
}

function addSameLangNote(msg) {
  const note = document.createElement('div');
  note.className = 'same-lang-note';
  note.textContent = `Both parties are speaking ${msg.sourceLang} — nothing to translate.`;
  msg.el.appendChild(note);
}

function removeMessage(msg) {
  msg.el?.remove();
  const idx = state.messages.indexOf(msg);
  if (idx >= 0) state.messages.splice(idx, 1);
  saveHistory();
}

// The Clear button is the ONLY thing that discards history; reloads restore it.
function clearAll() {
  state.messages = [];
  msgCounter = 0;
  state.sessionStart = state.running ? Date.now() : null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  $('messages').innerHTML = emptyStateHtml;
}

/* ---------- History persistence ----------
   The encounter survives page reloads via localStorage; only the Clear
   button discards it. Turns are saved when their streams finish, plus a
   best-effort save on unload for anything in flight. */

const STORAGE_KEY = 'medical_translations_history';

function saveHistory() {
  try {
    const messages = state.messages
      .filter((m) => m.sourceText)
      .map((m) => ({
        id: m.id,
        start: m.start,
        end: m.end,
        specialty: m.specialty,
        specialtyLabel: m.specialtyLabel,
        role: m.role,
        sourceLang: m.sourceLang,
        targetLang: m.targetLang,
        heardLang: m.heardLang || null,
        substituted: !!m.substituted,
        sourceText: m.sourceText,
        cleanText: m.clean?.text || '',
        translationText: m.translation?.text || '',
      }));
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessionStart: state.sessionStart, messages })
    );
  } catch (err) {
    console.warn('could not save history:', err.message);
  }
}

function restoreHistory() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return; }
  if (!data || !Array.isArray(data.messages) || !data.messages.length) return;
  state.sessionStart = data.sessionStart || null;
  for (const saved of data.messages) {
    const msg = {
      id: saved.id,
      start: saved.start,
      end: saved.end,
      specialty: saved.specialty,
      specialtyLabel: saved.specialtyLabel,
      role: saved.role,
      sourceLang: saved.sourceLang,
      targetLang: saved.targetLang,
      heardLang: saved.heardLang,
      substituted: !!saved.substituted,
      sourceText: saved.sourceText,
      clean: { text: saved.cleanText || '', done: true },
      translation: null,
      el: null,
    };
    msgCounter = Math.max(msgCounter, msg.id);
    state.messages.push(msg);
    renderMessage(msg);
    updateMessageHead(msg);
    updateSourceBlob(msg);
    if (msg.clean.text) {
      msg.el.querySelector('.source .blob-text').textContent = msg.clean.text;
    }
    if (saved.translationText) {
      msg.translation = { text: saved.translationText, done: true };
      addTranslationBlob(msg);
      const el = msg.el.querySelector('.translation .blob-text');
      el.classList.remove('streaming');
      el.textContent = msg.translation.text;
    } else if (sameLang(msg.sourceLang, msg.targetLang)) {
      addSameLangNote(msg);
    }
  }
  autoscroll(true);
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

/* ---------- Text-to-speech ---------- */

let currentAudio = null;

function makeSpeakBtn(getText, getSpeaker) {
  const btn = document.createElement('button');
  btn.className = 'speak-btn';
  btn.title = 'Read aloud';
  btn.textContent = '🔊';
  btn.addEventListener('click', () => speakText(getText(), getSpeaker(), btn));
  return btn;
}

async function speakText(text, speaker, btn) {
  if (!text || !text.trim()) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    const resp = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, speaker: speaker || 'unknown' }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const blob = await resp.blob();
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
    }
    const audio = new Audio(URL.createObjectURL(blob));
    currentAudio = audio;
    const finished = new Promise((resolve) => {
      audio.onended = audio.onerror = () => {
        if (currentAudio === audio) {
          URL.revokeObjectURL(audio.src);
          currentAudio = null;
        }
        resolve();
      };
    });
    await audio.play();
    await finished;
  } catch (err) {
    setStatus('error', 'TTS: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔊';
    }
  }
}

/* ---------- Transcript export ---------- */

// One readable bilingual record of the encounter: each turn attributed, timed,
// and paired with its interpretation.
// One SRT file: each cue spans the turn's time, with the polished spoken
// text and its interpretation each on its own row. Raw ASR text is never
// exported, and a same-language turn contributes a single row.
function exportSrt() {
  const msgs = state.messages.filter((m) => m.sourceText);
  if (!msgs.length) {
    setStatus('error', 'Nothing to export yet');
    return;
  }
  const base = state.sessionStart ?? msgs[0].start;
  let n = 0;
  let out = '';
  for (const m of msgs) {
    const rows = [];
    const push = (text) => {
      const t = (text || '').trim();
      if (t && !rows.includes(t)) rows.push(t);
    };
    push(m.clean?.text);
    push(m.translation?.text);
    if (!rows.length) continue;
    n++;
    out += `${n}\n${fmtSrt(m.start - base)} --> ${fmtSrt(m.end - base)}\n${rows.join('\n')}\n\n`;
  }
  if (!n) {
    setStatus('error', 'Nothing to export yet');
    return;
  }
  downloadFile('encounter.srt', out);
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

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fmtClock(ts) {
  return new Date(ts).toTimeString().slice(0, 8);
}
