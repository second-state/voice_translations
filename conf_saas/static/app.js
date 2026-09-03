'use strict';

// Server-side redirect handles proxies that set X-Forwarded-Proto; this
// catches any that don't. Local plain-HTTP development stays untouched.
if (location.protocol === 'http:'
    && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  location.replace('https://' + location.host + location.pathname + location.search);
}

/* Keep the screen awake while this tab is open: a live translation session
   must not end because the device locked itself. The lock is auto-released
   when the tab is hidden, so it is re-acquired on return, and on first tap
   for browsers that only grant it after a gesture. */
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

/* Meeting Translator — browser side.
   The speech capture, VAD handling, and fan-out to several target languages
   are the standalone conference app's, unchanged in substance. What this
   edition adds around them: the account and its weekly allowance, the
   interface language, and two defaults that follow from it — the spoken
   language is always detected, and the translation targets start as the
   language the interface is being read in. */

// The languages offered as targets, from [conference] languages in the
// server's config; filled in once /api/config answers.
let ALL_LANGS = [];

// ISO 639-1 codes (plus common country-code slips) -> display names, so
// config values and ASR results always collapse onto the chip names.
const LANG_CODES = {
  en: 'English', ko: 'Korean', kr: 'Korean', zh: 'Chinese', cn: 'Chinese',
  yue: 'Cantonese',
  ja: 'Japanese', jp: 'Japanese', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
  vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', nl: 'Dutch', tr: 'Turkish',
  pl: 'Polish', uk: 'Ukrainian', sv: 'Swedish', is: 'Icelandic',
  no: 'Norwegian', nb: 'Norwegian', nn: 'Norwegian', tl: 'Tagalog',
  ht: 'Haitian Creole', bn: 'Bengali', ur: 'Urdu', fa: 'Persian', so: 'Somali',
  am: 'Amharic', ne: 'Nepali', my: 'Burmese',
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

// A language's name in the interface language, falling back to the English
// display name the server speaks in.
function langLabel(name) {
  const key = 'langname.' + name;
  const label = t(key);
  return label === key ? name : label;
}

function sameLang(a, b) {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

const state = {
  cfg: null,
  account: null,
  quota: null,
  billingEnabled: false,
  targets: new Set(),
  // Always 'auto' when the page loads: the spoken language is detected on
  // every sentence. A pin lasts for this visit only.
  sourceOverride: 'auto',
  callType: 'business',
  messages: [],
  running: false,
  sessionStart: null,
};
let msgCounter = 0;
let emptyStateHtml = '';

const $ = (id) => document.getElementById(id);

init().catch((err) => setStatus('error', t('app.err.config', { message: err.message })));

async function init() {
  emptyStateHtml = $('messages').innerHTML;
  // Nothing on this page works without an account, so establish who is
  // signed in before anything else; anonymous visitors go to the sign-in
  // page and never see a half-rendered console.
  if (!(await loadAccount())) {
    location.replace('/login');
    return;
  }
  const resp = await fetch('/api/config');
  if (!resp.ok) throw new Error(await resp.text());
  state.cfg = await resp.json();
  ALL_LANGS = (state.cfg.languages || []).map(langName);

  // The targets start as the language the interface is in — someone reading
  // this in Korean wants to read the call in Korean — unless a set was chosen
  // by hand before, which is remembered until it is changed again.
  const remembered = (storedTargets() || []).map(langName).filter((l) => ALL_LANGS.includes(l));
  state.targets = new Set(remembered.length ? remembered : defaultTargets());

  renderLangChips();
  renderSourceSelect();
  renderCallTypeSelect();
  renderLocalePicker($('localePicker'));
  // Switching the interface language moves the targets with it, unless they
  // were chosen by hand.
  onLocaleChange(() => {
    if (!storedTargets()) state.targets = new Set(defaultTargets());
    redrawTranslatedText();
  });
  restoreHistory();
  window.addEventListener('beforeunload', saveHistory);

  $('micBtn').addEventListener('click', toggleMic);
  $('logoutBtn').addEventListener('click', logout);
  $('upgradeBtn').addEventListener('click', () => startBilling('/api/billing/checkout'));
  $('manageBtn').addEventListener('click', () => startBilling('/api/billing/portal'));
  $('exportBtn').addEventListener('click', exportSrt);
  $('clearBtn').addEventListener('click', clearAll);
  $('settingsToggle').addEventListener('click', () => {
    const collapsed = $('settings').classList.toggle('collapsed');
    const toggle = $('settingsToggle');
    toggle.innerHTML = `<span data-i18n="app.setup">${t('app.setup')}</span> ${collapsed ? '▸' : '▾'}`;
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
}

/* What to translate into when nobody has chosen: the interface language if
   it is on offer, else whatever the server configured. */
function defaultTargets() {
  const fromLocale = targetLanguageFor(locale());
  if (ALL_LANGS.includes(fromLocale)) return [fromLocale];
  return (state.cfg.default_targets || []).map(langName).filter((l) => ALL_LANGS.includes(l));
}

/* ---------- Account, plan, and allowance ----------
   The server is the authority on all three: this only renders what
   /api/me reports and what each API response carries back. */

async function loadAccount() {
  try {
    const resp = await fetch('/api/me');
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data.authenticated) return false;
    state.account = data.user;
    state.billingEnabled = !!data.billing_enabled;
    renderAccount(data.quota);
    return true;
  } catch (err) {
    console.warn('could not load the account:', err.message);
    return false;
  }
}

function renderAccount(quota) {
  if (!state.account) return;
  if (quota) state.quota = quota;
  const q = state.quota;
  $('accountBar').hidden = false;
  $('accountEmail').textContent = state.account.email;

  const pro = state.account.plan === 'pro';
  const badge = $('planBadge');
  badge.textContent = t(pro ? 'app.plan.pro' : 'app.plan.free');
  badge.classList.toggle('pro', pro);

  // Only the free plan has anything to meter.
  $('quotaWrap').hidden = !q || q.unlimited;
  if (q && !q.unlimited) {
    const used = Math.min(q.used, q.limit);
    const pct = q.limit > 0 ? Math.round((used / q.limit) * 100) : 0;
    const fill = $('quotaFill');
    fill.style.width = pct + '%';
    fill.classList.toggle('low', pct >= 80);
    fill.classList.toggle('spent', q.remaining <= 0);
    $('quotaText').textContent = t('app.quota.left', {
      remaining: q.remaining.toLocaleString(localeTag()),
      limit: q.limit.toLocaleString(localeTag()),
    });
    $('quotaText').title = t('app.quota.hint')
      + (q.resets_at ? t('app.quota.resets', { when: new Date(q.resets_at * 1000).toLocaleString(localeTag()) }) : '');
  }

  $('upgradeBtn').hidden = pro || !state.billingEnabled;
  $('manageBtn').hidden = !pro || !state.billingEnabled;
  if (q && !q.unlimited && q.remaining <= 0) showQuotaNotice(q);
  else if (pro || (q && q.remaining > 0)) hideQuotaNotice();
}

function showQuotaNotice(quota) {
  const el = $('quotaNotice');
  const when = quota?.resets_at
    ? t('app.quota.resets', { when: new Date(quota.resets_at * 1000).toLocaleString(localeTag()) }).trim()
    : '';
  el.innerHTML = t('app.quota.spent', { when });
  if (state.billingEnabled) {
    const btn = document.createElement('button');
    btn.className = 'btn accent';
    btn.textContent = t('app.upgrade');
    btn.addEventListener('click', () => startBilling('/api/billing/checkout'));
    el.appendChild(btn);
  }
  el.hidden = false;
}

function hideQuotaNotice() {
  $('quotaNotice').hidden = true;
}

// Any 401 means the session lapsed; any 402 means the allowance is spent.
// Both need the same thing from every call site, so they are handled once
// here and the caller just stops.
async function handleApiFailure(resp) {
  if (resp.status === 401) {
    location.replace('/login');
    return true;
  }
  if (resp.status === 402) {
    const data = await resp.json().catch(() => ({}));
    if (data.quota) renderAccount(data.quota);
    else showQuotaNotice(state.quota);
    if (state.running) await stopMic();
    setStatus('error', t('app.quota.reached'));
    return true;
  }
  return false;
}

async function startBilling(endpoint) {
  try {
    const resp = await fetch(endpoint, { method: 'POST' });
    if (await handleApiFailure(resp)) return;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    location.href = data.url;
  } catch (err) {
    setStatus('error', t('app.err.billing', { message: err.message }));
  }
}

async function logout() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } finally {
    // Back to the landing page, which explains the plans and offers a way
    // back in, rather than straight to an empty sign-in form.
    location.replace('/');
  }
}

/* ---------- Language selection ---------- */

function renderLangChips() {
  const wrap = $('langChips');
  wrap.innerHTML = '';
  for (const lang of ALL_LANGS) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.targets.has(lang) ? ' on' : '');
    chip.textContent = langLabel(lang);
    chip.title = lang;
    chip.addEventListener('click', () => {
      if (state.targets.has(lang)) state.targets.delete(lang);
      else state.targets.add(lang);
      chip.classList.toggle('on');
      // Chosen by hand: remembered until changed again, and no longer
      // following the interface language.
      rememberTargets(state.targets);
    });
    wrap.appendChild(chip);
  }
}

// The kind of call shapes the register of every translation; changing it
// affects utterances from that point on.
function renderCallTypeSelect() {
  const sel = $('callType');
  const current = sel.value || state.cfg.default_type || state.callType;
  sel.innerHTML = '';
  for (const type of state.cfg.call_types || []) {
    const opt = document.createElement('option');
    opt.value = type.id;
    const key = 'app.type.' + type.id;
    const label = t(key);
    opt.textContent = `${type.icon} ${label === key ? type.label : label}`;
    opt.title = type.blurb;
    sel.appendChild(opt);
  }
  state.callType = current;
  sel.value = state.callType;
  if (!sel.onchange) {
    sel.onchange = () => { state.callType = sel.value; };
  }
}

function renderSourceSelect() {
  const sel = $('sourceLang');
  sel.innerHTML = '';
  const options = [['auto', t('app.source.auto')]].concat(ALL_LANGS.map((l) => [l, langLabel(l)]));
  for (const [value, label] of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.value = state.sourceOverride;
  if (!sel.onchange) {
    sel.onchange = () => { state.sourceOverride = sel.value; };
  }
}

/* ---------- Microphone + Silero VAD (@ricky0123/vad-web, local assets) ----------
   The Silero neural VAD decides what is human speech: audio is only sent to
   the server when the model detects a speech segment, so keyboard noise,
   music, and background hum never trigger transcription. */

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
// utterance, duplicating messages, and the first instance would leak).
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
    setStatus('error', t('app.err.mic', { message: err.message }));
    if (!state.running) {
      $('micBtn').textContent = t('app.mic.start');
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
      throw new Error(t('app.err.https'));
    }
    throw new Error(t('app.err.nomic'));
  }
  if (!vadInstance) {
    setStatus('listening', t('app.status.loading'));
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
        // detected speech segment (plus pre-speech padding). Quiet/distant
        // speakers are boosted to a healthy level before transcription.
        handleUtterance(encodeWav(normalizePeak(audio), 16000), utterStart || now, now);
      },
    });
  }
  vadInstance.start();
  state.running = true;
  state.sessionStart ??= Date.now();
  // Only flip once fully started; the button stays grayed out until then.
  $('micBtn').textContent = t('app.mic.stop');
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
  $('micBtn').textContent = t('app.mic.start');
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
    if (await handleApiFailure(resp)) {
      removeMessage(msg);
      return;
    }
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    // Every transcription reports the allowance it just spent.
    if (data.quota) renderAccount(data.quota);
    const text = (data.text || '').trim();
    if (!text) {
      removeMessage(msg);
      return;
    }
    msg.sourceText = text;
    msg.sourceLang = override || langName(data.language) || langName(state.cfg.default_source) || 'English';
    updateSourceBlob(msg);
    saveHistory();

    // The source blob streams a polished (filler-free) version of the raw
    // transcript; a target matching the source language mirrors it.
    msg.cleanSource = { text: '', done: false, original: true };
    const mirrors = [];
    // One request per target language, all streaming concurrently.
    const targets = [...state.targets];
    for (const lang of targets) {
      if (sameLang(lang, msg.sourceLang)) {
        msg.translations[lang] = msg.cleanSource;
        addTranslationBlob(msg, lang);
        mirrors.push(lang);
      } else {
        streamTranslation(msg, lang);
      }
    }
    if (!targets.length) addNoTargetsNote(msg);
    streamCleanSource(msg, mirrors);
  } catch (err) {
    msg.el.classList.add('error');
    const blobText = msg.el.querySelector('.source .blob-text');
    blobText.classList.remove('pending');
    blobText.textContent = t('app.turn.failed', { message: err.message });
  }
}

function streamTranslation(msg, lang) {
  msg.translations[lang] = { text: '', done: false };
  addTranslationBlob(msg, lang);
  const el = msg.el.querySelector(`.blob[data-lang="${lang}"] .blob-text`);
  return streamPolish(msg, lang, buildContext(msg, lang), msg.translations[lang], [el], null);
}

// Stream the same-language cleanup into the source blob and any target blob
// that matches the source language.
function streamCleanSource(msg, mirrorLangs) {
  const els = [msg.el.querySelector('.source .blob-text')];
  for (const lang of mirrorLangs) {
    els.push(msg.el.querySelector(`.blob[data-lang="${lang}"] .blob-text`));
  }
  els[0].classList.add('streaming');
  const prior = state.messages.filter((m) => m !== msg && m.sourceText);
  const context = prior.slice(-state.cfg.context_messages).map((m) => ({
    source: m.sourceText,
    translation: m.cleanSource?.text || '',
  }));
  // On failure the raw transcript stays on screen instead of an error.
  return streamPolish(msg, msg.sourceLang, context, msg.cleanSource, els, msg.sourceText);
}

// Shared SSE-over-POST reader: streams /api/translate output into `entry`
// and every element in `els`.
async function streamPolish(msg, targetLang, context, entry, els, fallbackText) {
  const show = (text) => { for (const el of els) el.textContent = text; };
  try {
    const resp = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: msg.sourceText,
        source_lang: msg.sourceLang,
        target_lang: targetLang,
        call_type: state.callType,
        context,
      }),
    });
    if (await handleApiFailure(resp)) return;
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
  saveHistory();
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
      <span class="lang-badge"></span>
    </div>
    <div class="blob source">
      <div class="blob-lang"><span class="blob-label"></span></div>
      <div class="blob-text pending"></div>
    </div>
    <div class="blobs"></div>`;
  el.querySelector('.lang-badge').textContent = t('app.turn.detecting');
  el.querySelector('.source .blob-label').textContent = t('app.turn.source');
  el.querySelector('.source .blob-text').textContent = t('app.turn.transcribing');
  if (state.cfg.tts_enabled) {
    el.querySelector('.source .blob-lang')
      .appendChild(makeSpeakBtn(() => msg.cleanSource?.text || msg.sourceText));
  }
  msg.el = el;
  $('messages').appendChild(el);
  autoscroll(true);
}

function updateSourceBlob(msg) {
  msg.el.querySelector('.lang-badge').textContent = langLabel(msg.sourceLang);
  msg.el.querySelector('.source .blob-label').textContent =
    t('app.turn.asSpoken', { lang: langLabel(msg.sourceLang) });
  const blobText = msg.el.querySelector('.source .blob-text');
  blobText.classList.remove('pending');
  blobText.textContent = msg.sourceText;
}

function translationLabel(lang, entry) {
  return entry.original
    ? t('app.turn.sameAsSource', { lang: langLabel(lang) })
    : langLabel(lang);
}

function addTranslationBlob(msg, lang) {
  const entry = msg.translations[lang];
  const div = document.createElement('div');
  div.className = 'blob translation';
  div.dataset.lang = lang;
  const label = document.createElement('div');
  label.className = 'blob-lang';
  const name = document.createElement('span');
  name.className = 'blob-label';
  name.textContent = translationLabel(lang, entry);
  label.appendChild(name);
  if (state.cfg.tts_enabled) label.appendChild(makeSpeakBtn(() => entry.text));
  const text = document.createElement('div');
  text.className = 'blob-text' + (entry.done ? '' : ' streaming');
  text.textContent = entry.text;
  div.append(label, text);
  msg.el.querySelector('.blobs').appendChild(div);
  autoscroll();
}

function addNoTargetsNote(msg) {
  const note = document.createElement('div');
  note.className = 'same-lang-note';
  note.textContent = t('app.turn.noTargets');
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
  applyTranslations($('messages'));
}

/* ---------- History persistence ----------
   The transcript survives page reloads via localStorage; only the Clear
   button discards it. Streams are saved when they finish, plus a
   best-effort save on unload for anything in flight. */

const STORAGE_KEY = 'conf_saas_history';

function saveHistory() {
  try {
    const messages = state.messages
      .filter((m) => m.sourceText)
      .map((m) => ({
        id: m.id,
        start: m.start,
        end: m.end,
        sourceLang: m.sourceLang,
        sourceText: m.sourceText,
        cleanText: m.cleanSource?.text || '',
        translations: Object.fromEntries(
          Object.entries(m.translations).map(([lang, entry]) => [
            lang,
            { text: entry.text || '', original: !!entry.original },
          ])
        ),
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
      sourceLang: saved.sourceLang,
      sourceText: saved.sourceText,
      translations: {},
      el: null,
    };
    msgCounter = Math.max(msgCounter, msg.id);
    state.messages.push(msg);
    renderMessage(msg);
    updateSourceBlob(msg);
    msg.cleanSource = { text: saved.cleanText || '', done: true, original: true };
    if (msg.cleanSource.text) {
      msg.el.querySelector('.source .blob-text').textContent = msg.cleanSource.text;
    }
    for (const [lang, entry] of Object.entries(saved.translations || {})) {
      msg.translations[lang] = entry.original
        ? msg.cleanSource
        : { text: entry.text || '', done: true };
      addTranslationBlob(msg, lang);
    }
  }
  autoscroll(true);
}

/* Labels inside already-rendered utterances, the chips, and the two
   selects are written by JavaScript, so a language change has to redraw
   them. The transcribed and translated text is left alone: it is what people
   said, not interface copy. */
function redrawTranslatedText() {
  applyTranslations();
  renderLangChips();
  renderSourceSelect();
  renderCallTypeSelect();
  for (const msg of state.messages) {
    if (!msg.el || !msg.sourceText) continue;
    updateSourceBlob(msg);
    for (const blob of msg.el.querySelectorAll('.blob.translation')) {
      const lang = blob.dataset.lang;
      const entry = msg.translations[lang];
      if (entry) blob.querySelector('.blob-label').textContent = translationLabel(lang, entry);
    }
    const note = msg.el.querySelector('.same-lang-note');
    if (note) note.textContent = t('app.turn.noTargets');
    for (const btn of msg.el.querySelectorAll('.speak-btn')) btn.title = t('app.turn.readAloud');
  }
  const toggle = $('settingsToggle');
  const collapsed = $('settings').classList.contains('collapsed');
  toggle.innerHTML = `<span data-i18n="app.setup">${t('app.setup')}</span> ${collapsed ? '▸' : '▾'}`;
  if (state.account) renderAccount();
}

function autoscroll(force) {
  const c = $('messages');
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 160;
  if (force || nearBottom) c.scrollTop = c.scrollHeight;
}

function setStatus(kind, detail) {
  const el = $('status');
  el.className = 'status ' + kind;
  el.textContent = detail || t('app.status.' + kind, {}) || kind;
  if (detail) console.warn(detail);
}

/* ---------- Text-to-speech ---------- */

let currentAudio = null;

function makeSpeakBtn(getText) {
  const btn = document.createElement('button');
  btn.className = 'speak-btn';
  btn.title = t('app.turn.readAloud');
  btn.textContent = '🔊';
  btn.addEventListener('click', () => speakText(getText(), btn));
  return btn;
}

async function speakText(text, btn) {
  if (!text || !text.trim()) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const resp = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (await handleApiFailure(resp)) return;
    if (!resp.ok) throw new Error(await resp.text());
    const blob = await resp.blob();
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
    }
    const audio = new Audio(URL.createObjectURL(blob));
    currentAudio = audio;
    audio.onended = () => {
      if (currentAudio === audio) {
        URL.revokeObjectURL(audio.src);
        currentAudio = null;
      }
    };
    await audio.play();
  } catch (err) {
    setStatus('error', t('app.err.tts', { message: err.message }));
  } finally {
    btn.disabled = false;
    btn.textContent = '🔊';
  }
}

/* ---------- SRT export ---------- */

// One SRT file: each cue spans the utterance's time, with the polished
// source and every translated language on its own row. Raw ASR text is
// never exported, and rows identical to an earlier row are folded (a
// target matching the source language mirrors the polished source).
function exportSrt() {
  const msgs = state.messages.filter((m) => m.sourceText);
  if (!msgs.length) {
    setStatus('error', t('app.export.empty'));
    return;
  }
  const base = state.sessionStart ?? msgs[0].start;
  let n = 0;
  let out = '';
  for (const m of msgs) {
    const rows = [];
    const push = (text) => {
      const trimmed = (text || '').trim();
      if (trimmed && !rows.includes(trimmed)) rows.push(trimmed);
    };
    push(m.cleanSource?.text);
    for (const entry of Object.values(m.translations)) push(entry.text);
    if (!rows.length) continue;
    n++;
    out += `${n}\n${fmtSrt(m.start - base)} --> ${fmtSrt(m.end - base)}\n${rows.join('\n')}\n\n`;
  }
  if (!n) {
    setStatus('error', t('app.export.empty'));
    return;
  }
  const started = new Date(base);
  const pad = (v) => String(v).padStart(2, '0');
  const stamp = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`;
  downloadFile(`call-${stamp}.srt`, out);
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
