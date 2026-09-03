'use strict';

/* Interface language.
 *
 * Every page loads this file, so the landing page, the sign-in page, and the
 * console all speak the same language. The choice follows the browser until
 * someone picks one by hand, after which it persists across sessions.
 *
 * English is the source catalogue: a key missing from another language falls
 * back to it rather than showing a bare key.
 */

const I18N_KEY = 'conf_saas_locale';
const TARGETS_KEY = 'conf_saas_targets';

/* The interface languages, with the translation target each one implies.
 * Someone reading the interface in Korean wants, by default, to read the
 * call in Korean. */
const LOCALES = [
  { code: 'en', label: 'English', target: 'English' },
  { code: 'zh', label: '简体中文', target: 'Chinese' },
  { code: 'yue', label: '繁體中文', target: 'Cantonese' },
  { code: 'es', label: 'Español', target: 'Spanish' },
  { code: 'ko', label: '한국어', target: 'Korean' },
  { code: 'ja', label: '日本語', target: 'Japanese' },
];

/* Map a browser tag to one of ours. Written-Chinese variants matter here:
 * zh-TW, zh-HK and anything tagged Hant read traditional characters, which
 * is the `yue` catalogue; everything else Chinese gets simplified. */
function localeFromTag(tag) {
  const t = (tag || '').toLowerCase();
  if (!t) return null;
  if (t.startsWith('yue') || t.startsWith('zh-hant') || t === 'zh-tw' || t === 'zh-hk' || t === 'zh-mo') {
    return 'yue';
  }
  if (t.startsWith('zh')) return 'zh';
  for (const { code } of LOCALES) {
    if (t === code || t.startsWith(code + '-')) return code;
  }
  return null;
}

function storedLocale() {
  try {
    const saved = localStorage.getItem(I18N_KEY);
    return LOCALES.some((l) => l.code === saved) ? saved : null;
  } catch {
    return null;
  }
}

/* `?lang=ja` picks a language for this visit and remembers it, so a link can
 * be shared with someone who needs a particular one. */
function localeFromUrl() {
  try {
    const asked = new URLSearchParams(location.search).get('lang');
    return LOCALES.some((l) => l.code === asked) ? asked : null;
  } catch {
    return null;
  }
}

/* A language in the URL wins, then one picked by hand, then the browser's
 * preference order, then English. */
function detectLocale() {
  const asked = localeFromUrl();
  if (asked) {
    try {
      localStorage.setItem(I18N_KEY, asked);
    } catch { /* private mode: this visit only */ }
    return asked;
  }
  const saved = storedLocale();
  if (saved) return saved;
  for (const tag of navigator.languages || [navigator.language]) {
    const code = localeFromTag(tag);
    if (code) return code;
  }
  return 'en';
}

let currentLocale = detectLocale();

function locale() {
  return currentLocale;
}

/** The chosen language as a tag `Intl` understands, for dates and numbers. */
function localeTag() {
  return currentLocale === 'yue' ? 'zh-Hant' : currentLocale;
}

/** The translation target a locale implies. */
function targetLanguageFor(code) {
  return (LOCALES.find((l) => l.code === code) || LOCALES[0]).target;
}

/** Look up a string, falling back to English, and fill in {placeholders}. */
function t(key, params) {
  const table = STRINGS[currentLocale] || STRINGS.en;
  let text = table[key];
  if (text === undefined) text = STRINGS.en[key];
  if (text === undefined) return key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split('{' + name + '}').join(value);
    }
  }
  return text;
}

/* Translate a document in place. Elements carry the key in `data-i18n`;
 * `data-i18n-html` allows the few strings with inline markup, and
 * `data-i18n-attr` handles placeholders, titles, and other attributes as
 * `attribute:key` pairs. A marked-up element may carry its own placeholder
 * values in `data-i18n-params`, so a string like "{words} words a week"
 * re-renders correctly when the language changes. */
function elementParams(el) {
  if (!el.dataset.i18nParams) return undefined;
  try {
    return JSON.parse(el.dataset.i18nParams);
  } catch (err) {
    console.warn('bad data-i18n-params on', el, err.message);
    return undefined;
  }
}

function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n, elementParams(el));
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml, elementParams(el));
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  document.documentElement.lang = localeTag();
  const title = document.querySelector('title[data-i18n]');
  if (title) document.title = t(title.dataset.i18n);
}

const localeListeners = [];

/** Run something whenever the language changes, and once on registration. */
function onLocaleChange(fn) {
  localeListeners.push(fn);
  fn(currentLocale);
}

function setLocale(code) {
  if (!LOCALES.some((l) => l.code === code) || code === currentLocale) return;
  currentLocale = code;
  try {
    localStorage.setItem(I18N_KEY, code);
  } catch (err) {
    console.warn('could not remember the interface language:', err.message);
  }
  applyTranslations();
  for (const fn of localeListeners) fn(code);
}

/** Fill a <select> with the interface languages and wire it to the choice. */
function renderLocalePicker(select) {
  if (!select) return;
  select.innerHTML = '';
  for (const { code, label } of LOCALES) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.value = currentLocale;
  select.addEventListener('change', () => setLocale(select.value));
}

/* The target languages, remembered across sessions once chosen by hand.
 * Kept here beside the interface language because the two are related: the
 * targets start as whatever language the interface is in. */
function storedTargets() {
  try {
    const saved = JSON.parse(localStorage.getItem(TARGETS_KEY) || 'null');
    return Array.isArray(saved) && saved.every((s) => typeof s === 'string') ? saved : null;
  } catch {
    return null;
  }
}

function rememberTargets(targets) {
  try {
    localStorage.setItem(TARGETS_KEY, JSON.stringify([...targets]));
  } catch (err) {
    console.warn('could not remember the target languages:', err.message);
  }
}

const STRINGS = {};

STRINGS.en = {
  // ── Shared ──────────────────────────────────────────────────────────
  'brand': 'Meeting Translator',
  'lang.label': 'Language',

  // ── Landing page ────────────────────────────────────────────────────
  'home.title': 'Meeting Translator — every word of the meeting, in every language',
  'nav.how': 'How it works',
  'nav.features': 'What it does',
  'nav.record': 'The record',
  'nav.pricing': 'Pricing',
  'nav.faq': 'Questions',
  'nav.signin': 'Sign in',
  'nav.start': 'Start free',
  'nav.open': 'Open the translator',

  'hero.eyebrow': '🎙️ One microphone, every language on the call',
  'hero.h1': 'Every word of the meeting, <span class="hl">in every language</span>.',
  'hero.lede': 'Someone speaks, and a second later their sentence is on screen — transcribed, cleaned of the ums and false starts, and translated into every language you picked, all at once. When the call ends, the whole conversation is written down, ready to keep.',
  'hero.seehow': 'See how it works',
  'hero.note': 'New accounts are free: <strong>{words}</strong> words a week, no card.',

  'shot.bar': 'Listening · Business meeting · detecting the language',
  'shot.source': 'English · detected',
  'shot.said': 'Let’s move the launch to Friday, and I’ll send the revised numbers tonight.',
  'shot.t1.lang': 'Chinese',
  'shot.t1.text': '我们把发布改到周五，修改后的数字我今晚发给大家。',
  'shot.t2.lang': 'Spanish',
  'shot.t2.text': 'Pasemos el lanzamiento al viernes; esta noche les mando las cifras revisadas.',
  'shot.t3.lang': 'Japanese',
  'shot.t3.text': 'ローンチは金曜に変更しましょう。修正した数字は今夜お送りします。',
  'shot.note': 'Every sentence goes to every selected language at the same time.',

  'how.h2': 'Three steps, then it stays out of the way',
  'how.lede': 'Nothing to install, and nothing for the other people on the call to do. It runs in the browser on the laptop or phone that is already in the room.',
  'how.1.h': 'Pick the languages',
  'how.1.p': 'Choose what to translate into — one language or five — and what kind of call this is: a meeting, a family catch-up, a book club. The spoken language is detected on every sentence, so nobody has to say who is talking.',
  'how.2.h': 'Talk normally',
  'how.2.p': 'A speech detector in the browser notices when someone starts and stops, so nothing is sent while the room is quiet and nobody holds a button. A long monologue is split at its natural pauses.',
  'how.3.h': 'Read it, hear it, keep it',
  'how.3.p': 'Each sentence appears in every chosen language within a second or two, and can be read aloud. When the call ends, export it as a subtitle file.',

  'feat.h2': 'What it does',
  'feat.lede': 'Four things, in order, to every sentence anyone says.',
  'feat.transcribe.h': 'Transcribes any speech',
  'feat.transcribe.p': 'Whoever is talking, in whichever of 25 languages, is written down as they speak. The language is detected sentence by sentence, so a call that switches between English and Mandarin needs no settings changed mid-way.',
  'feat.cleanup.h': 'Cleans it up',
  'feat.cleanup.p': 'The ums, the false starts, the sentence begun twice: all gone from the transcript. When someone corrects themselves, you get what they settled on. Numbers, names and dates are never touched in the cleaning.',
  'feat.translate.h': 'Translates into every language',
  'feat.translate.p': 'One sentence, every language you picked, all streaming at once. Pick the kind of call — a meeting, a formal event, friends, politics, a book club, engineering — and the register follows: formal stays formal, casual stays casual, in each language’s own way.',
  'feat.record.h': 'Keeps a record of the meeting',
  'feat.record.p': 'Every sentence is kept with the time it was said, in the original and in every language. It survives a reload, and exports as a subtitle file for the recording or a text file anyone can open.',

  'record.h2': 'The meeting, written down as it happened',
  'record.lede': 'Decisions get made in the last five minutes, when half the room has stopped taking notes. Every sentence is kept as it is spoken, in the original and in every language it was translated into, with the time beside it.',
  'record.1.h': 'Every language, side by side',
  'record.1.p': 'Each entry keeps what was said and how it was translated, so a number or a date can be checked against the original rather than against memory.',
  'record.2.h': 'It outlives the call',
  'record.2.p': 'The transcript survives a reload and stays until it is cleared. Export writes it as an SRT file: subtitles for the recording, or plain text anyone can read.',
  'record.3.h': 'For the people who could not join',
  'record.3.p': 'A colleague in another time zone, a relative who missed the call: they can read exactly what was said, in their own language.',
  'record.sheet': 'call-2026-08-29.srt',
  'record.r1.said': 'Let’s move the launch to Friday.',
  'record.r1.rendered': '我们把发布改到周五。',
  'record.r2.said': '服务器那边周四能准备好吗？',
  'record.r2.rendered': 'Can the server side be ready by Thursday?',
  'record.r3.said': 'Thursday morning, if the review passes.',
  'record.r3.rendered': '如果评审通过，周四上午。',

  'pricing.h2': 'Free for the occasional call',
  'pricing.lede': 'Both plans are the same translator, with every language, every call type and every rule. The difference is how much can be said.',
  'plan.free.tag': 'Where everyone starts',
  'plan.free.name': 'Free',
  'plan.free.price': '$0',
  'plan.free.per': ' / forever',
  'plan.free.sub': 'No card and no trial clock. Signing up puts you here.',
  'plan.free.f1': '<strong>{words}</strong> translated words a week',
  'plan.free.f2': 'A <strong>rolling</strong> seven-day window for the weekly free quota',
  'plan.free.f3': 'All 25 languages and all six call types',
  'plan.free.f4': 'As many target languages per call as you like',
  'plan.free.f5': 'Read-aloud, and the subtitle file to keep',
  'plan.free.cta': 'Create a free account',
  'plan.free.foot': 'Everyone who speaks draws on the same weekly words.',
  'plan.pro.tag': 'For regular calls',
  'plan.pro.name': 'Unlimited',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / month',
  'plan.pro.sub': 'Billed monthly through Stripe. Cancel any time.',
  'plan.pro.f1': '<strong>Unlimited</strong> words, with no weekly ceiling',
  'plan.pro.f2': 'Everything in the free plan, unchanged',
  'plan.pro.f3': 'A full day of meetings without watching a counter',
  'plan.pro.f4': 'Cancel or change the card yourself, inside the app',
  'plan.pro.f5': 'Access continues while a payment is being retried',
  'plan.pro.cta': 'Start free, upgrade later',
  'plan.pro.foot': 'You can upgrade from inside the app once you have an account.',
  'plan.pro.off': 'Not yet available',
  'plan.pro.offsub': 'Subscriptions are not enabled on this deployment.',
  'plan.pro.offfoot': 'Every account currently stays on the free plan.',
  'plan.pro.upgrade': 'Upgrade in the app',

  'faq.h2': 'Questions people ask',
  'faq.q1': 'What counts as a word?',
  'faq.a1': 'The words actually spoken, whoever said them. Translations are free: a sentence costs the same whether it goes into one language or five, and hearing it read aloud costs nothing. Chinese, Japanese and other languages written without spaces are counted by character.',
  'faq.q2': 'How far does a free week go?',
  'faq.a2': 'People speak around 130 to 150 words a minute, so {words} words is over half an hour of actual talking: a full meeting, or several short calls. If you run out mid-call the app says so, and the allowance comes back over the following week.',
  'faq.q3': 'What does a “rolling” week mean?',
  'faq.a3': 'Usage is counted from right now backwards over seven days rather than reset on a fixed day. Words spent in Monday’s call stop counting the next Monday, so the allowance returns a little at a time. There is no reset hour to wait for.',
  'faq.q4': 'Do the other people on the call need anything?',
  'faq.a4': 'No. One person runs it, on the device that hears the room or the call audio; everyone else just talks. Share the screen into the call and the others see the translations too.',
  'faq.q5': 'What happens to the audio and the transcript?',
  'faq.a5': 'Speech goes to the speech recognition and translation services this deployment is set up to use, and the text comes back. This server keeps neither the audio nor the transcript: the call stays in your browser until you clear it or export it. Your account holds your email address, whether you subscribe, and how many words each sentence used.',
  'faq.q6': 'How do I sign in?',
  'faq.a6': 'With your email address. We send a link, you tap it, and you are in. There is no password to choose or forget, the same link creates your account the first time, and each link works once.',
  'faq.q7': 'Can I cancel whenever I want?',
  'faq.a7': 'Yes. Subscriptions are handled in Stripe’s billing portal, which you reach from inside the app, and cancelling takes effect without asking anyone. Your account goes back to the free plan rather than disappearing.',
  'faq.q8': 'What does the export look like?',
  'faq.a8': 'An SRT subtitle file: every sentence with the time it was said, the cleaned-up original on one line and each translation on its own line beneath it. Drop it onto the call recording as subtitles, or open it as text. Nothing is uploaded to this server for that to work.',

  'cta.h2': 'Bring it to your next call',
  'cta.p': 'An email address is all it takes, and you will be set up in under a minute.',
  'foot.disclaimer': 'This is a machine translation to help you follow a call. Nobody reviews it before you see it, and it is not a certified translation. For anything contractual or legal, check the original before acting on it.',

  // ── Sign-in page ────────────────────────────────────────────────────
  'login.title': 'Sign in · Meeting Translator',
  'login.lede': 'Follow a call in your own language, and keep the transcript. Enter your email and we will send you a sign-in link, with no password to choose or forget.',
  'login.email': 'Email address',
  'login.placeholder': 'you@example.com',
  'login.submit': 'Email me a sign-in link',
  'login.sending': 'Sending…',
  'login.foot': 'New here? The same link signs you up. Free accounts include <strong>{words}</strong> translated words a week, and a monthly subscription removes the limit.',
  'login.sent': 'Check {email} for a sign-in link. It expires in {minutes} minutes.',
  'login.devlink': 'No mail provider is configured, so here is your link: <a href="{link}">sign in</a>',
  'login.error.invalid': 'That sign-in link has already been used, or is not a valid link. Request a new one below.',
  'login.error.expired': 'That sign-in link has expired. Request a new one below.',
  'verify.title': 'Confirm sign-in · Meeting Translator',
  'verify.lede': 'This link opens a session on this device for the account below. Check that it is the account you meant before you continue.',
  'verify.heading': 'Sign in as',
  'verify.continue': 'Continue',
  'verify.wrong': 'Not the right account? <a href="/login">Request a link for another one.</a>',

  // ── Console: setup ──────────────────────────────────────────────────
  'app.title': 'Meeting Translator',
  'app.setup': 'Options',
  'app.callType': 'Call type',
  'app.callType.hint': 'What kind of call this is; it sets the register of every translation',
  'app.type.business': 'Business meeting',
  'app.type.formal': 'Formal event',
  'app.type.friends': 'Friends & family',
  'app.type.politics': 'Politics & current affairs',
  'app.type.book_club': 'Book club',
  'app.type.tech': 'Tech & engineering',
  'app.targets': 'Translate into',
  'app.targets.hint': '(pick one or more)',
  'app.source': 'Spoken language',
  'app.source.auto': 'Auto-detect',
  'app.source.hint': 'Detected on every sentence unless you pin one here',
  'app.export': 'Export',
  'app.clear': 'Clear',
  'app.empty': 'Press <strong>Start listening</strong> and speak.<br>Each sentence is transcribed, cleaned up, then translated into every selected language at once.',

  // ── Console: microphone and status ──────────────────────────────────
  'app.mic.start': 'Start listening',
  'app.mic.stop': 'Stop listening',
  'app.meter': 'Microphone level',
  'app.status.idle': 'Idle',
  'app.status.listening': 'Listening',
  'app.status.speaking': 'Speaking…',
  'app.status.error': 'Error',
  'app.status.loading': 'Loading VAD model…',
  'app.err.mic': 'Mic error: {message}',
  'app.err.https': 'microphone access needs HTTPS. Open this page via an https:// URL (e.g. a Cloudflare tunnel) or on localhost.',
  'app.err.nomic': 'this browser does not expose the microphone API. If you opened the link inside another app (chat app, QR scanner) or a privacy browser, open it in Chrome directly instead.',
  'app.err.config': 'Config load failed: {message}',
  'app.err.tts': 'TTS: {message}',
  'app.err.billing': 'Billing: {message}',

  // ── Console: utterances ─────────────────────────────────────────────
  'app.turn.transcribing': 'Transcribing…',
  'app.turn.detecting': 'detecting…',
  'app.turn.source': 'Source',
  'app.turn.asSpoken': '{lang} · source',
  'app.turn.sameAsSource': '{lang} · same as source',
  'app.turn.failed': 'Transcription failed: {message}',
  'app.turn.readAloud': 'Read aloud',
  'app.turn.noTargets': 'No language selected — pick one above and the next sentence will be translated.',
  'app.export.empty': 'Nothing to export yet',

  // ── Console: account bar ────────────────────────────────────────────
  'app.plan.free': 'Free plan',
  'app.plan.pro': 'Unlimited',
  'app.quota.left': '{remaining} of {limit} words left this week',
  'app.quota.hint': 'A rolling seven-day window: words stop counting seven days after they are spoken.',
  'app.quota.resets': ' Some allowance returns {when}.',
  'app.quota.spent': '<strong>This week’s free allowance is used up.</strong> Translation is paused until the rolling window frees up. {when}',
  'app.quota.reached': 'Weekly word allowance reached',
  'app.upgrade': 'Subscribe for unlimited',
  'app.manage': 'Manage subscription',
  'app.logout': 'Log out',

  // ── Language names, as this interface calls them ────────────────────
  'langname.English': 'English',
  'langname.Chinese': 'Chinese',
  'langname.Cantonese': 'Cantonese',
  'langname.Spanish': 'Spanish',
  'langname.Korean': 'Korean',
  'langname.Japanese': 'Japanese',
};

STRINGS.zh = {
  'brand': '会议翻译',
  'lang.label': '界面语言',

  'home.title': '会议翻译：会上的每一句话，都变成每一种语言',
  'nav.how': '怎么用',
  'nav.features': '能做什么',
  'nav.record': '会议记录',
  'nav.pricing': '价格',
  'nav.faq': '常见问题',
  'nav.signin': '登录',
  'nav.start': '免费开始',
  'nav.open': '打开翻译',

  'hero.eyebrow': '🎙️ 一个麦克风，会上的每一种语言',
  'hero.h1': '会上的每一句话，<span class="hl">都变成每一种语言</span>。',
  'hero.lede': '有人一开口，一秒钟后这句话就出现在屏幕上：先转成文字，去掉「嗯」「那个」和说了一半的词，再同时译成您选的每一种语言。会议结束时，整场对话已经记好，随时可以带走。',
  'hero.seehow': '看看怎么用',
  'hero.note': '新账号免费：每周 <strong>{words}</strong> 个词，不用信用卡。',

  'shot.bar': '正在听 · 商务会议 · 自动识别语言',
  'shot.source': '英文 · 已识别',
  'shot.said': 'Let’s move the launch to Friday, and I’ll send the revised numbers tonight.',
  'shot.t1.lang': '中文',
  'shot.t1.text': '我们把发布改到周五，修改后的数字我今晚发给大家。',
  'shot.t2.lang': '西班牙文',
  'shot.t2.text': 'Pasemos el lanzamiento al viernes; esta noche les mando las cifras revisadas.',
  'shot.t3.lang': '日文',
  'shot.t3.text': 'ローンチは金曜に変更しましょう。修正した数字は今夜お送りします。',
  'shot.note': '每一句话同时译成您选的每一种语言。',

  'how.h2': '三步之后，它就不打扰您了',
  'how.lede': '不用装任何东西，会上其他人什么也不用做。在会议室里已经有的那台电脑或手机上，用浏览器打开就行。',
  'how.1.h': '选语言',
  'how.1.p': '选要译成哪些语言，一种或者五种都行；再选这是什么样的会：例会、家人聊天、读书会。每句话说的是什么语言都是自动识别的，不用谁先说自己是谁。',
  'how.2.h': '照平常那样讲',
  'how.2.p': '浏览器里的语音检测能听出谁开始讲、谁讲完了，屋里没人说话时不会往外传，也不用一直按着按钮。一个人讲得长，会在自然停顿的地方断开。',
  'how.3.h': '看得到，听得到，留得下',
  'how.3.p': '每句话说完一两秒，就用您选的每种语言显示出来，也可以点开听。会开完了，导出成字幕文件。',

  'feat.h2': '能做什么',
  'feat.lede': '对每个人说的每一句话，按顺序做四件事。',
  'feat.transcribe.h': '把任何人说的话转成文字',
  'feat.transcribe.p': '不管谁在讲、讲的是 25 种语言里的哪一种，边讲边写下来。语言是一句一句识别的，一场会里英文和普通话来回切换，中途什么都不用改。',
  'feat.cleanup.h': '把文字清理干净',
  'feat.cleanup.p': '「嗯」「那个」、说了一半重来的句子，都从记录里去掉；有人说错又改口，留下的是他最后确定的意思。清理时不碰任何数字、名字和日期。',
  'feat.translate.h': '译成每一种语言',
  'feat.translate.p': '一句话，您选的每种语言，同时出来。选好这是什么样的会——例会、正式场合、朋友聊天、时政、读书会、技术讨论——语气就跟着走：正式的还是正式，随意的还是随意，而且是每种语言自己的说法。',
  'feat.record.h': '留下整场会议的记录',
  'feat.record.p': '每句话都连同时间一起保存，原文和每种译文都在。刷新页面也不会丢，可以导出成录像用的字幕文件，或者谁都能打开的文本文件。',

  'record.h2': '会议原原本本记下来',
  'record.lede': '决定往往是在最后五分钟做的，那时候一半的人已经不记笔记了。每句话说出口时就记下来，原文和译成的每种语言都有，旁边还有时间。',
  'record.1.h': '每种语言并排',
  'record.1.p': '每一条都留着原话和译文，一个数字、一个日期，可以回去对原话，不用凭记忆。',
  'record.2.h': '会开完了，记录还在',
  'record.2.p': '刷新页面记录也在，直到您自己清掉。导出成 SRT 文件：可以给录像当字幕，也可以当纯文本谁都能看。',
  'record.3.h': '给没能参加的人',
  'record.3.p': '在另一个时区的同事、错过了通话的家人，可以用自己的语言看到当时到底说了什么。',
  'record.sheet': '会议记录-2026-08-29.srt',
  'record.r1.said': 'Let’s move the launch to Friday.',
  'record.r1.rendered': '我们把发布改到周五。',
  'record.r2.said': '服务器那边周四能准备好吗？',
  'record.r2.rendered': 'Can the server side be ready by Thursday?',
  'record.r3.said': 'Thursday morning, if the review passes.',
  'record.r3.rendered': '如果评审通过，周四上午。',

  'pricing.h2': '偶尔开一次会，免费就够',
  'pricing.lede': '两个套餐是同一个翻译，语言、会议类型、所有规则都一样。差别只在能说多少。',
  'plan.free.tag': '大家都从这里开始',
  'plan.free.name': '免费',
  'plan.free.price': '$0',
  'plan.free.per': ' / 一直免费',
  'plan.free.sub': '不用信用卡，也没有试用倒计时。注册就是这个套餐。',
  'plan.free.f1': '每周 <strong>{words}</strong> 个词',
  'plan.free.f2': '每周免费额度按<strong>滚动</strong>的七天计算',
  'plan.free.f3': '25 种语言、六种会议类型全都能用',
  'plan.free.f4': '一场会想译成几种语言都行',
  'plan.free.f5': '朗读，以及可以留下的字幕文件',
  'plan.free.cta': '注册免费账号',
  'plan.free.foot': '会上每个人说的话都算在同一份每周词数里。',
  'plan.pro.tag': '经常开会的话',
  'plan.pro.name': '不限量',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / 月',
  'plan.pro.sub': '通过 Stripe 每月扣 20 美元，随时可以取消。',
  'plan.pro.f1': '词数<strong>不限</strong>，没有每周上限',
  'plan.pro.f2': '免费套餐里的功能原样都有',
  'plan.pro.f3': '开一整天会也不用盯着计数',
  'plan.pro.f4': '自己在应用里取消或者换卡',
  'plan.pro.f5': '扣款重试期间照常能用',
  'plan.pro.cta': '先免费用，以后再订阅',
  'plan.pro.foot': '有账号之后，在应用里就能升级。',
  'plan.pro.off': '暂时还没有',
  'plan.pro.offsub': '这个部署没有开通订阅。',
  'plan.pro.offfoot': '目前所有账号都留在免费套餐。',
  'plan.pro.upgrade': '在应用里订阅',

  'faq.h2': '大家常问的',
  'faq.q1': '什么算一个词？',
  'faq.a1': '真正说出口的话，不管是谁说的。译文不另外算：一句话译成一种语言还是五种，花的都一样，点开听也不花。中文、日文这种词与词之间不空格的语言，按字数算。',
  'faq.q2': '免费的一周大概够用多久？',
  'faq.a2': '人说话大概一分钟 130 到 150 个词，所以 {words} 个词够说上半个多小时：开一次完整的会，或者几次短会。要是开到一半用完了，应用会提示您，额度会在接下来一周里慢慢还回来。',
  'faq.q3': '「滚动」的一周是什么意思？',
  'faq.a3': '从现在往回数七天，不是到某一天清零。周一那次会用掉的词，下周一就不再计入，额度是一点一点还回来的，不用守着某个时间点等清零。',
  'faq.q4': '会上其他人需要做什么吗？',
  'faq.a4': '不用。一个人在能听到房间或者通话声音的设备上开着它就行，其他人照常说话。把屏幕共享到会议里，其他人也能看到译文。',
  'faq.q5': '录音和记录会怎么处理？',
  'faq.a5': '声音会送到这个部署配置的语音识别和翻译服务，再把文字传回来。这台服务器不保存录音，也不保存记录：会议内容留在您的浏览器里，直到您清掉或者导出。您账号里存的是邮箱、有没有订阅，以及每句话用掉多少词。',
  'faq.q6': '怎么登录？',
  'faq.a6': '用邮箱。我们发一个链接，您一点就进去了。不用设密码，也不用记密码；第一次用这个链接会顺便帮您把账号建好，每个链接只能用一次。',
  'faq.q7': '想取消随时能取消吗？',
  'faq.a7': '可以。订阅在 Stripe 的账单页面管理，从应用里就能进去，取消不用跟任何人打招呼。取消之后账号回到免费套餐，不会被删掉。',
  'faq.q8': '导出来的是什么样子？',
  'faq.a8': '一个 SRT 字幕文件：每句话带着说话的时间，清理过的原文一行，每种译文各占一行。可以直接给会议录像当字幕，也可以当文本打开。这些都不用往服务器上传。',

  'cta.h2': '下次开会带上它',
  'cta.p': '有个邮箱就行，一分钟不到就弄好了。',
  'foot.disclaimer': '这是机器翻译，帮您跟上会议内容。您看到之前没有人审过，也不是有资质的正式翻译。涉及合同或法律的内容，行动之前请核对原文。',

  'login.title': '登录 · 会议翻译',
  'login.lede': '用自己的语言跟上一场会议，还能留下记录。写下邮箱，我们发一个登录链接给您，不用设密码，也不用记密码。',
  'login.email': '邮箱',
  'login.placeholder': 'you@example.com',
  'login.submit': '把登录链接发到我的邮箱',
  'login.sending': '正在发送…',
  'login.foot': '第一次来？同一个链接就帮您注册。免费账号每周有 <strong>{words}</strong> 个词，按月订阅可以去掉这个限制。',
  'login.sent': '请查看 {email} 的收件箱，登录链接 {minutes} 分钟内有效。',
  'login.devlink': '没有配置邮件服务，链接直接给您：<a href="{link}">登录</a>',
  'login.error.invalid': '这个登录链接已经用过，或者不是有效的链接。请在下方重新申请一个。',
  'login.error.expired': '这个登录链接已经过期。请在下方重新申请一个。',
  'verify.title': '确认登录 · 会议翻译',
  'verify.lede': '这个链接会在这台设备上为下面的账号开启会话。继续之前，请确认这是您要用的账号。',
  'verify.heading': '以此账号登录',
  'verify.continue': '继续',
  'verify.wrong': '不是这个账号？<a href="/login">为另一个账号申请链接。</a>',

  'app.title': '会议翻译',
  'app.setup': '选项',
  'app.callType': '会议类型',
  'app.callType.hint': '这是什么样的会；决定每句译文的语气',
  'app.type.business': '商务会议',
  'app.type.formal': '正式场合',
  'app.type.friends': '朋友和家人',
  'app.type.politics': '时政讨论',
  'app.type.book_club': '读书会',
  'app.type.tech': '技术讨论',
  'app.targets': '译成',
  'app.targets.hint': '（可以选多个）',
  'app.source': '说话的语言',
  'app.source.auto': '自动识别',
  'app.source.hint': '每句话自动识别，除非您在这里指定一种',
  'app.export': '导出',
  'app.clear': '清空',
  'app.empty': '按<strong>开始聆听</strong>，然后说话。<br>每句话先转成文字、清理干净，再同时译成选中的每一种语言。',

  'app.mic.start': '开始聆听',
  'app.mic.stop': '停止聆听',
  'app.meter': '麦克风音量',
  'app.status.idle': '空闲',
  'app.status.listening': '正在听',
  'app.status.speaking': '有人在说…',
  'app.status.error': '出错',
  'app.status.loading': '正在加载语音检测模型…',
  'app.err.mic': '麦克风错误：{message}',
  'app.err.https': '使用麦克风需要 HTTPS。请通过 https:// 地址（例如 Cloudflare 隧道）或在 localhost 打开本页。',
  'app.err.nomic': '这个浏览器没有开放麦克风接口。如果您是在别的应用（聊天软件、扫码器）或隐私浏览器里打开的链接，请直接在 Chrome 里打开。',
  'app.err.config': '配置加载失败：{message}',
  'app.err.tts': '朗读：{message}',
  'app.err.billing': '账单：{message}',

  'app.turn.transcribing': '正在转写…',
  'app.turn.detecting': '识别中…',
  'app.turn.source': '原文',
  'app.turn.asSpoken': '{lang} · 原文',
  'app.turn.sameAsSource': '{lang} · 与原文相同',
  'app.turn.failed': '转写失败：{message}',
  'app.turn.readAloud': '朗读',
  'app.turn.noTargets': '还没有选语言——在上面选一种，下一句就会翻译。',
  'app.export.empty': '还没有可以导出的内容',

  'app.plan.free': '免费套餐',
  'app.plan.pro': '不限量',
  'app.quota.left': '本周还剩 {remaining} / {limit} 个词',
  'app.quota.hint': '按滚动的七天计算：每个词在说出七天后就不再计入。',
  'app.quota.resets': ' 部分额度将在 {when} 恢复。',
  'app.quota.spent': '<strong>本周免费额度已用完。</strong>翻译暂停，需等待滚动窗口释放额度。{when}',
  'app.quota.reached': '已达到每周词数上限',
  'app.upgrade': '订阅不限量',
  'app.manage': '管理订阅',
  'app.logout': '退出登录',

  // ── Language names, as this interface calls them ────────────────────
  'langname.English': '英文',
  'langname.Chinese': '中文',
  'langname.Cantonese': '粤语',
  'langname.Spanish': '西班牙文',
  'langname.Korean': '韩文',
  'langname.Japanese': '日文',
};

STRINGS.yue = {
  'brand': '會議翻譯',
  'lang.label': '介面語言',

  'home.title': '會議翻譯：會上每一句話，都變成每一種語言',
  'nav.how': '點樣用',
  'nav.features': '做到啲乜',
  'nav.record': '會議記錄',
  'nav.pricing': '收費',
  'nav.faq': '常見問題',
  'nav.signin': '登入',
  'nav.start': '免費開始',
  'nav.open': '打開翻譯',

  'hero.eyebrow': '🎙️ 一個咪高峰，會上每一種語言',
  'hero.h1': '會上每一句話，<span class="hl">都變成每一種語言</span>。',
  'hero.lede': '有人一開口，一秒之後嗰句話就出咗喺螢幕上：先變做文字，執走「嗯」「即係」同講到一半嘅字，再同時譯成你揀嘅每一種語言。開完會，成場對話已經記低晒，隨時帶得走。',
  'hero.seehow': '睇下點樣用',
  'hero.note': '新開嘅戶口免費：每星期 <strong>{words}</strong> 個字，唔使信用卡。',

  'shot.bar': '收緊音 · 商務會議 · 自動辨識語言',
  'shot.source': '英文 · 已辨識',
  'shot.said': 'Let’s move the launch to Friday, and I’ll send the revised numbers tonight.',
  'shot.t1.lang': '廣東話',
  'shot.t1.text': '我哋將發佈改到星期五，改好嘅數字我今晚發畀大家。',
  'shot.t2.lang': '西班牙文',
  'shot.t2.text': 'Pasemos el lanzamiento al viernes; esta noche les mando las cifras revisadas.',
  'shot.t3.lang': '日文',
  'shot.t3.text': 'ローンチは金曜に変更しましょう。修正した数字は今夜お送りします。',
  'shot.note': '每一句話同時譯成你揀嘅每一種語言。',

  'how.h2': '三步之後，佢就唔會阻住你',
  'how.lede': '唔使裝任何嘢，會上其他人乜都唔使做。喺會議室度本身有嗰部電腦或者手機，用瀏覽器開就得。',
  'how.1.h': '揀語言',
  'how.1.p': '揀要譯成邊幾種語言，一種定五種都得；再揀呢個係咩會：例會、屋企人傾偈、讀書會。每句話講嘅係咩語言都係自動辨識，唔使邊個先講自己係邊個。',
  'how.2.h': '照平時噉講',
  'how.2.p': '瀏覽器入面嘅語音偵測聽得出邊個開始講、邊個講完，房入面冇人講嘢嗰陣唔會傳出去，亦唔使一路撳住個掣。一個人講得長，會喺自然停頓嘅位斷開。',
  'how.3.h': '睇得到、聽得到、留得低',
  'how.3.p': '每句話講完一兩秒，就用你揀嘅每種語言出嚟，亦可以㩒嚟聽。開完會，匯出做字幕檔。',

  'feat.h2': '做到啲乜',
  'feat.lede': '對每個人講嘅每一句話，順住做四件事。',
  'feat.transcribe.h': '將任何人講嘅嘢變做文字',
  'feat.transcribe.p': '唔理邊個講緊、講嘅係 25 種語言入面邊一種，一路講一路寫低。語言係一句一句辨識嘅，一場會英文同普通話來回切換，中途乜都唔使改。',
  'feat.cleanup.h': '執乾淨啲文字',
  'feat.cleanup.p': '「嗯」「即係」、講到一半重新嚟過嘅句子，全部喺記錄入面執走；有人講錯改口，留低嘅係佢最後定咗嘅意思。執嘅時候唔會掂任何數字、名同日期。',
  'feat.translate.h': '譯成每一種語言',
  'feat.translate.p': '一句話，你揀嘅每種語言，同時出嚟。揀好呢個係咩會——例會、正式場合、朋友傾偈、時政、讀書會、技術討論——語氣就跟住行：正式嘅照舊正式，隨便嘅照舊隨便，而且係每種語言自己嘅講法。',
  'feat.record.h': '留低成場會嘅記錄',
  'feat.record.p': '每句話連同時間一齊保存，原文同每種譯文都喺度。重新載入頁面都唔會冇，可以匯出做錄影用嘅字幕檔，或者邊個都開到嘅文字檔。',

  'record.h2': '會議原原本本記低',
  'record.lede': '決定多數係最後五分鐘先做，嗰陣一半人已經冇再抄筆記。每句話講出口嗰陣就記低，原文同譯成嘅每種語言都有，隔籬仲有時間。',
  'record.1.h': '每種語言並排',
  'record.1.p': '每一條都留住原話同譯文，一個數字、一個日期，可以返去對返原話，唔使靠記憶。',
  'record.2.h': '開完會，記錄仲喺度',
  'record.2.p': '重新載入頁面記錄一樣喺度，直到你自己清走。匯出做 SRT 檔：可以畀錄影做字幕，亦可以當純文字邊個都睇到。',
  'record.3.h': '畀嚟唔到嘅人',
  'record.3.p': '喺另一個時區嘅同事、錯過咗通話嘅屋企人，可以用自己嘅語言睇返當時到底講咗乜。',
  'record.sheet': '會議記錄-2026-08-29.srt',
  'record.r1.said': 'Let’s move the launch to Friday.',
  'record.r1.rendered': '我哋將發佈改到星期五。',
  'record.r2.said': '伺服器嗰邊星期四準備得切嗎？',
  'record.r2.rendered': 'Can the server side be ready by Thursday?',
  'record.r3.said': 'Thursday morning, if the review passes.',
  'record.r3.rendered': '如果評審通過，星期四朝早。',

  'pricing.h2': '間唔中開一次會，免費夠晒',
  'pricing.lede': '兩個計劃都係同一個翻譯，語言、會議類型、所有規則一樣。分別淨係喺講得幾多。',
  'plan.free.tag': '個個都由呢度開始',
  'plan.free.name': '免費',
  'plan.free.price': '$0',
  'plan.free.per': ' / 一直免費',
  'plan.free.sub': '唔使信用卡，亦冇試用倒數。開咗戶口就係呢個計劃。',
  'plan.free.f1': '每星期 <strong>{words}</strong> 個字',
  'plan.free.f2': '每星期嘅免費額度以<strong>滾動</strong>七日計',
  'plan.free.f3': '25 種語言、六種會議類型全部用得',
  'plan.free.f4': '一場會想譯成幾多種語言都得',
  'plan.free.f5': '朗讀，同埋可以留低嘅字幕檔',
  'plan.free.cta': '開個免費戶口',
  'plan.free.foot': '會上每個人講嘅嘢，都計入同一份每星期字數。',
  'plan.pro.tag': '成日開會嘅話',
  'plan.pro.name': '無限',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / 月',
  'plan.pro.sub': '經 Stripe 每月扣 20 美元，隨時可以取消。',
  'plan.pro.f1': '字數<strong>無限</strong>，冇每星期上限',
  'plan.pro.f2': '免費計劃嗰啲，原封不動全部有',
  'plan.pro.f3': '開成日會都唔使盯住個數',
  'plan.pro.f4': '自己喺 app 入面取消或者換卡',
  'plan.pro.f5': '扣款重試期間照樣用得',
  'plan.pro.cta': '先免費用，遲啲先訂閱',
  'plan.pro.foot': '有咗戶口之後，喺 app 入面就升級得。',
  'plan.pro.off': '暫時未有',
  'plan.pro.offsub': '呢個部署未開訂閱。',
  'plan.pro.offfoot': '而家所有戶口都留喺免費計劃。',
  'plan.pro.upgrade': '喺 app 訂閱',

  'faq.h2': '大家成日問嘅',
  'faq.q1': '點先算一個字？',
  'faq.a1': '真係講出口嘅嘢，唔理邊個講。譯文唔另計：一句話譯成一種語言定五種，收費一樣，㩒嚟聽都唔使錢。中文、日文呢啲字與字之間唔空格嘅語言，按字數計。',
  'faq.q2': '免費嗰個星期大概夠用幾耐？',
  'faq.a2': '人講嘢大概一分鐘 130 至 150 個字，所以 {words} 個字夠講半個幾鐘：開一次完整嘅會，或者幾次短會。如果開到一半用完咗，app 會話你知，額度會喺跟住嗰個星期慢慢還返。',
  'faq.q3': '「滾動」嘅一個星期即係點？',
  'faq.a3': '由而家數返轉頭七日，唔係邊一日清零。星期一嗰次會用咗嘅字，下個星期一就唔再計，額度係一啲一啲還返嚟。唔使守住邊個鐘數等清零。',
  'faq.q4': '會上其他人使唔使做啲乜？',
  'faq.a4': '唔使。一個人喺聽到房或者通話聲嘅裝置上開住佢就得，其他人照常講嘢。將螢幕分享入個會，其他人一樣睇到譯文。',
  'faq.q5': '錄音同記錄會點處理？',
  'faq.a5': '把聲會送去呢個部署設定嘅語音辨識同翻譯服務，再將文字傳返嚟。呢部伺服器唔會存錄音，亦唔會存記錄：會議內容留喺你個瀏覽器，直到你清走或者匯出。你戶口入面存嘅係電郵、有冇訂閱，同埋每句話用咗幾多個字。',
  'faq.q6': '點樣登入？',
  'faq.a6': '用電郵。我哋寄個連結畀你，㩒一下就入到。唔使諗密碼，亦唔使記密碼；第一次用呢個連結會順手幫你開埋戶口，每個連結淨係用得一次。',
  'faq.q7': '想取消隨時取消得？',
  'faq.a7': '得。訂閱喺 Stripe 嘅帳單頁面管理，喺 app 入面就入到，取消唔使同任何人講。取消之後戶口返去免費計劃，唔會冇咗。',
  'faq.q8': '匯出嚟係咩樣？',
  'faq.a8': '一個 SRT 字幕檔：每句話帶住講嘅時間，執乾淨嘅原文一行，每種譯文各佔一行。可以直接畀會議錄影做字幕，亦可以當文字開。呢啲全部唔使上傳去伺服器。',

  'cta.h2': '下次開會帶埋佢',
  'cta.p': '有個電郵就得，一分鐘唔使就搞掂。',
  'foot.disclaimer': '呢個係機器翻譯，幫你跟得上會議內容。你睇之前冇人審過，亦唔係有資格嘅正式翻譯。涉及合約或者法律嘅嘢，行動之前請對返原文。',

  'login.title': '登入 · 會議翻譯',
  'login.lede': '用自己嘅語言跟得上一場會，仲可以留低記錄。寫低你個電郵，我哋寄個登入連結畀你，唔使諗密碼，亦唔使記密碼。',
  'login.email': '電郵',
  'login.placeholder': 'you@example.com',
  'login.submit': '將登入連結寄畀我',
  'login.sending': '寄緊…',
  'login.foot': '第一次嚟？同一個連結就幫你開埋戶口。免費戶口每星期有 <strong>{words}</strong> 個字，月費訂閱就冇呢個限制。',
  'login.sent': '請睇下 {email} 嘅收件箱，登入連結 {minutes} 分鐘內有效。',
  'login.devlink': '未設定電郵服務，連結直接畀你：<a href="{link}">登入</a>',
  'login.error.invalid': '呢個登入連結已經用過，或者唔係有效嘅連結。請喺下面重新申請一個。',
  'login.error.expired': '呢個登入連結已經過期。請喺下面重新申請一個。',
  'verify.title': '確認登入 · 會議翻譯',
  'verify.lede': '呢條連結會喺呢部裝置上為下面嘅戶口開啟登入。繼續之前，請確認係你想用嘅戶口。',
  'verify.heading': '用呢個戶口登入',
  'verify.continue': '繼續',
  'verify.wrong': '唔係呢個戶口？<a href="/login">為另一個戶口申請連結。</a>',

  'app.title': '會議翻譯',
  'app.setup': '選項',
  'app.callType': '會議類型',
  'app.callType.hint': '呢個係咩會；決定每句譯文嘅語氣',
  'app.type.business': '商務會議',
  'app.type.formal': '正式場合',
  'app.type.friends': '朋友同屋企人',
  'app.type.politics': '時政討論',
  'app.type.book_club': '讀書會',
  'app.type.tech': '技術討論',
  'app.targets': '譯成',
  'app.targets.hint': '（可以揀多個）',
  'app.source': '講嘢嘅語言',
  'app.source.auto': '自動辨識',
  'app.source.hint': '每句話自動辨識，除非你喺度指定一種',
  'app.export': '匯出',
  'app.clear': '清空',
  'app.empty': '㩒<strong>開始聆聽</strong>，然後講嘢。<br>每句話先變做文字、執乾淨，再同時譯成揀咗嘅每一種語言。',

  'app.mic.start': '開始聆聽',
  'app.mic.stop': '停止聆聽',
  'app.meter': '咪高峰音量',
  'app.status.idle': '閒置',
  'app.status.listening': '收緊音',
  'app.status.speaking': '有人講緊…',
  'app.status.error': '出錯',
  'app.status.loading': '載入緊語音偵測模型…',
  'app.err.mic': '咪高峰錯誤：{message}',
  'app.err.https': '用咪高峰需要 HTTPS。請經 https:// 網址（例如 Cloudflare 隧道）或者喺 localhost 開呢頁。',
  'app.err.nomic': '呢個瀏覽器冇開放咪高峰介面。如果你係喺其他 app（通訊軟件、掃碼器）或者私隱瀏覽器入面開連結，請直接用 Chrome 開。',
  'app.err.config': '設定載入失敗：{message}',
  'app.err.tts': '朗讀：{message}',
  'app.err.billing': '帳單：{message}',

  'app.turn.transcribing': '轉寫緊…',
  'app.turn.detecting': '辨識中…',
  'app.turn.source': '原文',
  'app.turn.asSpoken': '{lang} · 原文',
  'app.turn.sameAsSource': '{lang} · 同原文一樣',
  'app.turn.failed': '轉寫失敗：{message}',
  'app.turn.readAloud': '朗讀',
  'app.turn.noTargets': '未揀語言——喺上面揀一種，下一句就會翻譯。',
  'app.export.empty': '仲未有嘢可以匯出',

  'app.plan.free': '免費計劃',
  'app.plan.pro': '無限',
  'app.quota.left': '今個星期仲剩 {remaining} / {limit} 個字',
  'app.quota.hint': '以滾動七日計：每個字講咗七日之後就唔再計。',
  'app.quota.resets': ' 部分額度會喺 {when} 還返。',
  'app.quota.spent': '<strong>今個星期嘅免費額度用晒喇。</strong>翻譯暫停，要等滾動視窗釋放額度。{when}',
  'app.quota.reached': '已到每星期字數上限',
  'app.upgrade': '訂閱無限',
  'app.manage': '管理訂閱',
  'app.logout': '登出',

  // ── Language names, as this interface calls them ────────────────────
  'langname.English': '英文',
  'langname.Chinese': '普通話',
  'langname.Cantonese': '廣東話',
  'langname.Spanish': '西班牙文',
  'langname.Korean': '韓文',
  'langname.Japanese': '日文',
};

STRINGS.es = {
  'brand': 'Traductor de Reuniones',
  'lang.label': 'Idioma',

  'home.title': 'Traductor de Reuniones: cada palabra de la reunión, en todos los idiomas',
  'nav.how': 'Cómo funciona',
  'nav.features': 'Qué hace',
  'nav.record': 'El registro',
  'nav.pricing': 'Precios',
  'nav.faq': 'Preguntas',
  'nav.signin': 'Entrar',
  'nav.start': 'Empiece gratis',
  'nav.open': 'Abrir el traductor',

  'hero.eyebrow': '🎙️ Un micrófono, todos los idiomas de la llamada',
  'hero.h1': 'Cada palabra de la reunión, <span class="hl">en todos los idiomas</span>.',
  'hero.lede': 'Alguien habla y, un segundo después, su frase está en pantalla: transcrita, sin los «eh» y los arranques en falso, y traducida a todos los idiomas que usted eligió, al mismo tiempo. Cuando termina la llamada, toda la conversación queda escrita, lista para guardar.',
  'hero.seehow': 'Vea cómo funciona',
  'hero.note': 'Las cuentas nuevas son gratis: <strong>{words}</strong> palabras por semana, sin tarjeta.',

  'shot.bar': 'Escuchando · Reunión de trabajo · detectando el idioma',
  'shot.source': 'inglés · detectado',
  'shot.said': 'Let’s move the launch to Friday, and I’ll send the revised numbers tonight.',
  'shot.t1.lang': 'español',
  'shot.t1.text': 'Pasemos el lanzamiento al viernes; esta noche les mando las cifras revisadas.',
  'shot.t2.lang': 'chino',
  'shot.t2.text': '我们把发布改到周五，修改后的数字我今晚发给大家。',
  'shot.t3.lang': 'japonés',
  'shot.t3.text': 'ローンチは金曜に変更しましょう。修正した数字は今夜お送りします。',
  'shot.note': 'Cada frase va a todos los idiomas elegidos al mismo tiempo.',

  'how.h2': 'Tres pasos, y después no estorba',
  'how.lede': 'No hay nada que instalar, y los demás en la llamada no tienen que hacer nada. Funciona en el navegador de la computadora o el teléfono que ya está en la sala.',
  'how.1.h': 'Elija los idiomas',
  'how.1.p': 'Escoja a qué idiomas traducir, uno o cinco, y qué tipo de llamada es: una reunión, una charla familiar, un club de lectura. El idioma hablado se detecta en cada frase, así que nadie tiene que decir quién está hablando.',
  'how.2.h': 'Hable como siempre',
  'how.2.p': 'Un detector de voz en el navegador nota cuándo alguien empieza y termina de hablar, así que no se envía nada mientras la sala está en silencio y nadie tiene que apretar un botón. Un monólogo largo se corta en sus pausas naturales.',
  'how.3.h': 'Léalo, escúchelo, guárdelo',
  'how.3.p': 'Cada frase aparece en todos los idiomas elegidos uno o dos segundos después, y se puede escuchar en voz alta. Cuando termina la llamada, expórtela como archivo de subtítulos.',

  'feat.h2': 'Qué hace',
  'feat.lede': 'Cuatro cosas, en orden, con cada frase que dice cualquiera.',
  'feat.transcribe.h': 'Transcribe lo que diga cualquiera',
  'feat.transcribe.p': 'Quien esté hablando, en cualquiera de 25 idiomas, queda por escrito mientras habla. El idioma se detecta frase por frase, así que una llamada que salta entre inglés y mandarín no necesita cambiar nada a medio camino.',
  'feat.cleanup.h': 'Lo limpia',
  'feat.cleanup.p': 'Los «eh», los arranques en falso, la frase empezada dos veces: todo desaparece de la transcripción. Cuando alguien se corrige, queda lo que quiso decir al final. Los números, los nombres y las fechas nunca se tocan en la limpieza.',
  'feat.translate.h': 'Lo traduce a todos los idiomas',
  'feat.translate.p': 'Una frase, todos los idiomas que eligió, todos a la vez. Escoja el tipo de llamada (una reunión, un acto formal, amigos, política, un club de lectura, ingeniería) y el registro lo sigue: lo formal sigue formal y lo informal sigue informal, a la manera de cada idioma.',
  'feat.record.h': 'Guarda el registro de la reunión',
  'feat.record.p': 'Cada frase se conserva con la hora en que se dijo, en el original y en todos los idiomas. Sobrevive a una recarga, y se exporta como archivo de subtítulos para la grabación o como texto que cualquiera puede abrir.',

  'record.h2': 'La reunión, por escrito y tal como pasó',
  'record.lede': 'Las decisiones se toman en los últimos cinco minutos, cuando la mitad de la sala ya dejó de tomar notas. Cada frase se guarda tal como se dijo, en el original y en todos los idiomas a los que se tradujo, con la hora al lado.',
  'record.1.h': 'Todos los idiomas, uno al lado del otro',
  'record.1.p': 'Cada entrada conserva lo que se dijo y cómo se tradujo, así que una cifra o una fecha se puede comprobar contra el original y no contra la memoria.',
  'record.2.h': 'Dura más que la llamada',
  'record.2.p': 'La transcripción sobrevive a una recarga y se queda hasta que usted la borre. Exportar la escribe como archivo SRT: subtítulos para la grabación, o texto plano que cualquiera puede leer.',
  'record.3.h': 'Para los que no pudieron entrar',
  'record.3.p': 'Un colega en otra zona horaria, un familiar que se perdió la llamada: pueden leer exactamente lo que se dijo, en su propio idioma.',
  'record.sheet': 'reunion-2026-08-29.srt',
  'record.r1.said': 'Let’s move the launch to Friday.',
  'record.r1.rendered': 'Pasemos el lanzamiento al viernes.',
  'record.r2.said': '¿El servidor puede estar listo para el jueves?',
  'record.r2.rendered': 'Can the server side be ready by Thursday?',
  'record.r3.said': 'Thursday morning, if the review passes.',
  'record.r3.rendered': 'El jueves por la mañana, si pasa la revisión.',

  'pricing.h2': 'Gratis para una llamada de vez en cuando',
  'pricing.lede': 'Los dos planes son el mismo traductor, con todos los idiomas, todos los tipos de llamada y todas las reglas. Lo único que cambia es cuánto se puede hablar.',
  'plan.free.tag': 'Aquí empieza todo el mundo',
  'plan.free.name': 'Gratis',
  'plan.free.price': '$0',
  'plan.free.per': ' / para siempre',
  'plan.free.sub': 'Sin tarjeta y sin reloj de prueba. Al registrarse queda en este plan.',
  'plan.free.f1': '<strong>{words}</strong> palabras traducidas por semana',
  'plan.free.f2': 'Una ventana <strong>corrida</strong> de siete días para la cuota gratis semanal',
  'plan.free.f3': 'Los 25 idiomas y los seis tipos de llamada',
  'plan.free.f4': 'Tantos idiomas de destino por llamada como quiera',
  'plan.free.f5': 'Escuchar en voz alta y el archivo de subtítulos para guardar',
  'plan.free.cta': 'Crear una cuenta gratis',
  'plan.free.foot': 'Todo el que habla consume las mismas palabras semanales.',
  'plan.pro.tag': 'Para llamadas frecuentes',
  'plan.pro.name': 'Sin límite',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / mes',
  'plan.pro.sub': 'Se cobran 20 dólares cada mes por Stripe. Puede cancelar cuando quiera.',
  'plan.pro.f1': 'Palabras <strong>sin límite</strong>, sin tope semanal',
  'plan.pro.f2': 'Todo lo del plan gratis, igual',
  'plan.pro.f3': 'Un día entero de reuniones sin estar viendo el contador',
  'plan.pro.f4': 'Cancelar o cambiar la tarjeta usted mismo, desde la aplicación',
  'plan.pro.f5': 'El acceso sigue mientras se reintenta un pago',
  'plan.pro.cta': 'Empiece gratis y suscríbase después',
  'plan.pro.foot': 'Puede pasarse a este plan desde la aplicación cuando ya tenga cuenta.',
  'plan.pro.off': 'Todavía no disponible',
  'plan.pro.offsub': 'En esta instalación no están activadas las suscripciones.',
  'plan.pro.offfoot': 'Por ahora todas las cuentas se quedan en el plan gratis.',
  'plan.pro.upgrade': 'Suscribirse en la aplicación',

  'faq.h2': 'Preguntas que hace la gente',
  'faq.q1': '¿Qué cuenta como palabra?',
  'faq.a1': 'Las palabras que de verdad se dicen, las diga quien las diga. Las traducciones no cuestan: una frase cuesta igual si va a un idioma o a cinco, y escucharla en voz alta no cuesta nada. El chino, el japonés y otros idiomas que se escriben sin espacios se cuentan por carácter.',
  'faq.q2': '¿Para cuánto alcanza una semana gratis?',
  'faq.a2': 'La gente habla unas 130 a 150 palabras por minuto, así que {words} palabras dan para más de media hora de conversación: una reunión completa, o varias llamadas cortas. Si se le acaban a media llamada, la aplicación se lo dice, y la cuota va regresando durante la semana siguiente.',
  'faq.q3': '¿Qué quiere decir semana «corrida»?',
  'faq.a3': 'Se cuenta desde este momento hacia atrás siete días, no se reinicia un día fijo. Las palabras que gastó en la llamada del lunes dejan de contar el lunes siguiente, así que la cuota va regresando poco a poco. No hay una hora de reinicio que esperar.',
  'faq.q4': '¿Los demás en la llamada necesitan algo?',
  'faq.a4': 'No. Una persona lo usa, en el dispositivo que oye la sala o el audio de la llamada; los demás solo hablan. Comparta la pantalla en la llamada y los demás también ven las traducciones.',
  'faq.q5': '¿Qué pasa con el audio y con el texto?',
  'faq.a5': 'La voz se manda a los servicios de reconocimiento y traducción que tenga configurados esta instalación, y regresa el texto. Este servidor no guarda ni el audio ni el texto: la llamada se queda en su navegador hasta que usted la borre o la exporte. De su cuenta guardamos el correo, si tiene suscripción y cuántas palabras gastó cada frase.',
  'faq.q6': '¿Cómo entro?',
  'faq.a6': 'Con su correo. Le mandamos un enlace, usted lo toca y ya está adentro. No hay contraseña que escoger ni que olvidar, el mismo enlace le crea la cuenta la primera vez y cada enlace sirve una sola vez.',
  'faq.q7': '¿Puedo cancelar cuando quiera?',
  'faq.a7': 'Sí. Las suscripciones se manejan en el portal de Stripe, al que se entra desde la aplicación, y la cancelación se aplica sin tener que hablar con nadie. Su cuenta regresa al plan gratis en vez de desaparecer.',
  'faq.q8': '¿Cómo es lo que se exporta?',
  'faq.a8': 'Un archivo de subtítulos SRT: cada frase con la hora en que se dijo, el original ya limpio en una línea y cada traducción en su propia línea debajo. Póngalo sobre la grabación de la llamada como subtítulos, o ábralo como texto. Para eso no se sube nada a este servidor.',

  'cta.h2': 'Llévelo a su próxima llamada',
  'cta.p': 'Solo hace falta un correo y en menos de un minuto queda listo.',
  'foot.disclaimer': 'Esta es una traducción automática para ayudarle a seguir una llamada. Nadie la revisa antes de que usted la vea y no es una traducción certificada. Para cualquier cosa contractual o legal, compruebe el original antes de actuar.',

  'login.title': 'Iniciar sesión · Traductor de Reuniones',
  'login.lede': 'Siga una llamada en su propio idioma y quédese con la transcripción. Escriba su correo y le mandamos un enlace para entrar, sin contraseña que escoger ni olvidar.',
  'login.email': 'Correo electrónico',
  'login.placeholder': 'usted@ejemplo.com',
  'login.submit': 'Enviarme un enlace de acceso',
  'login.sending': 'Enviando…',
  'login.foot': '¿Es nuevo? El mismo enlace lo registra. Las cuentas gratis incluyen <strong>{words}</strong> palabras traducidas por semana, y la suscripción mensual quita el límite.',
  'login.sent': 'Revise {email}: le llegará un enlace de acceso que caduca en {minutes} minutos.',
  'login.devlink': 'No hay proveedor de correo configurado, así que aquí está su enlace: <a href="{link}">entrar</a>',
  'login.error.invalid': 'Ese enlace de acceso ya se usó o no es válido. Pida uno nuevo abajo.',
  'login.error.expired': 'Ese enlace de acceso caducó. Pida uno nuevo abajo.',
  'verify.title': 'Confirmar acceso · Traductor de Reuniones',
  'verify.lede': 'Este enlace abre una sesión en este dispositivo para la cuenta de abajo. Antes de continuar, confirme que es la cuenta que quería.',
  'verify.heading': 'Entrar como',
  'verify.continue': 'Continuar',
  'verify.wrong': '¿No es la cuenta correcta? <a href="/login">Pida un enlace para otra.</a>',

  'app.title': 'Traductor de Reuniones',
  'app.setup': 'Opciones',
  'app.callType': 'Tipo de llamada',
  'app.callType.hint': 'Qué tipo de llamada es; fija el registro de cada traducción',
  'app.type.business': 'Reunión de trabajo',
  'app.type.formal': 'Acto formal',
  'app.type.friends': 'Amigos y familia',
  'app.type.politics': 'Política y actualidad',
  'app.type.book_club': 'Club de lectura',
  'app.type.tech': 'Tecnología e ingeniería',
  'app.targets': 'Traducir a',
  'app.targets.hint': '(elija uno o varios)',
  'app.source': 'Idioma hablado',
  'app.source.auto': 'Detectar automáticamente',
  'app.source.hint': 'Se detecta en cada frase, salvo que fije uno aquí',
  'app.export': 'Exportar',
  'app.clear': 'Borrar',
  'app.empty': 'Pulse <strong>Empezar a escuchar</strong> y hable.<br>Cada frase se transcribe, se limpia y se traduce a la vez a todos los idiomas elegidos.',

  'app.mic.start': 'Empezar a escuchar',
  'app.mic.stop': 'Dejar de escuchar',
  'app.meter': 'Nivel del micrófono',
  'app.status.idle': 'En espera',
  'app.status.listening': 'Escuchando',
  'app.status.speaking': 'Hablando…',
  'app.status.error': 'Error',
  'app.status.loading': 'Cargando el detector de voz…',
  'app.err.mic': 'Error de micrófono: {message}',
  'app.err.https': 'el micrófono necesita HTTPS. Abra esta página con una dirección https:// (por ejemplo un túnel de Cloudflare) o en localhost.',
  'app.err.nomic': 'este navegador no expone el micrófono. Si abrió el enlace dentro de otra aplicación (un chat, un lector de QR) o de un navegador privado, ábralo directamente en Chrome.',
  'app.err.config': 'No se pudo cargar la configuración: {message}',
  'app.err.tts': 'Lectura en voz alta: {message}',
  'app.err.billing': 'Facturación: {message}',

  'app.turn.transcribing': 'Transcribiendo…',
  'app.turn.detecting': 'detectando…',
  'app.turn.source': 'Original',
  'app.turn.asSpoken': '{lang} · original',
  'app.turn.sameAsSource': '{lang} · igual que el original',
  'app.turn.failed': 'Falló la transcripción: {message}',
  'app.turn.readAloud': 'Leer en voz alta',
  'app.turn.noTargets': 'No hay idioma elegido: elija uno arriba y la siguiente frase se traducirá.',
  'app.export.empty': 'Todavía no hay nada que exportar',

  'app.plan.free': 'Plan gratis',
  'app.plan.pro': 'Sin límite',
  'app.quota.left': 'Quedan {remaining} de {limit} palabras esta semana',
  'app.quota.hint': 'Una ventana corrida de siete días: las palabras dejan de contar siete días después de dichas.',
  'app.quota.resets': ' Parte de la cuota vuelve {when}.',
  'app.quota.spent': '<strong>La cuota gratis de esta semana se agotó.</strong> La traducción queda en pausa hasta que la ventana corrida libere palabras. {when}',
  'app.quota.reached': 'Se alcanzó la cuota semanal de palabras',
  'app.upgrade': 'Suscribirse sin límite',
  'app.manage': 'Gestionar la suscripción',
  'app.logout': 'Salir',

  // ── Language names, as this interface calls them ────────────────────
  'langname.English': 'inglés',
  'langname.Chinese': 'chino',
  'langname.Cantonese': 'cantonés',
  'langname.Spanish': 'español',
  'langname.Korean': 'coreano',
  'langname.Japanese': 'japonés',
};

STRINGS.ko = {
  'brand': '회의 번역',
  'lang.label': '언어',

  'home.title': '회의 번역 — 회의에서 오간 모든 말을, 모든 언어로',
  'nav.how': '사용 방법',
  'nav.features': '하는 일',
  'nav.record': '회의 기록',
  'nav.pricing': '요금',
  'nav.faq': '자주 묻는 질문',
  'nav.signin': '로그인',
  'nav.start': '무료로 시작',
  'nav.open': '번역 열기',

  'hero.eyebrow': '🎙️ 마이크 하나로, 통화에 오가는 모든 언어를',
  'hero.h1': '회의에서 오간 모든 말을, <span class="hl">모든 언어로</span>.',
  'hero.lede': '누군가 말하면 1초 뒤에 그 문장이 화면에 뜹니다. 글로 받아 적고, ‘음’과 말을 하다 만 부분을 걷어내고, 고른 언어 전부로 한꺼번에 번역합니다. 통화가 끝나면 대화 전체가 글로 남아 바로 보관할 수 있습니다.',
  'hero.seehow': '어떻게 쓰는지 보기',
  'hero.note': '새 계정은 무료입니다. 매주 <strong>{words}</strong>단어, 카드 등록 없이 씁니다.',

  'shot.bar': '듣는 중 · 업무 회의 · 언어 자동 감지',
  'shot.source': '영어 · 감지됨',
  'shot.said': 'Let’s move the launch to Friday, and I’ll send the revised numbers tonight.',
  'shot.t1.lang': '한국어',
  'shot.t1.text': '출시를 금요일로 옮기고, 수정한 수치는 오늘 밤 보내드리겠습니다.',
  'shot.t2.lang': '중국어',
  'shot.t2.text': '我们把发布改到周五，修改后的数字我今晚发给大家。',
  'shot.t3.lang': '일본어',
  'shot.t3.text': 'ローンチは金曜に変更しましょう。修正した数字は今夜お送りします。',
  'shot.note': '모든 문장이 고른 언어 전부로 동시에 번역됩니다.',

  'how.h2': '세 단계, 그다음엔 신경 쓸 일이 없습니다',
  'how.lede': '설치할 것도 없고, 통화에 참여한 다른 사람들이 할 일도 없습니다. 이미 회의실에 있는 노트북이나 휴대폰의 브라우저에서 돌아갑니다.',
  'how.1.h': '언어를 고릅니다',
  'how.1.p': '어떤 언어로 번역할지 하나든 다섯이든 고르고, 어떤 자리인지 고릅니다. 업무 회의, 가족 통화, 독서 모임. 말하는 언어는 문장마다 자동으로 감지되니 누가 말하는지 알려줄 필요가 없습니다.',
  'how.2.h': '평소처럼 말합니다',
  'how.2.p': '브라우저 안의 음성 감지가 누가 말을 시작하고 끝냈는지 알아차려서, 조용할 때는 아무것도 보내지 않고 버튼을 누르고 있을 필요도 없습니다. 긴 발언은 자연스러운 쉼에서 나뉩니다.',
  'how.3.h': '읽고, 듣고, 남깁니다',
  'how.3.p': '문장이 끝나고 1~2초 뒤에 고른 언어 전부로 뜨고, 소리 내어 들을 수도 있습니다. 통화가 끝나면 자막 파일로 내보냅니다.',

  'feat.h2': '하는 일',
  'feat.lede': '누가 한 말이든, 모든 문장에 대해 네 가지를 차례로 합니다.',
  'feat.transcribe.h': '누구의 말이든 받아 적습니다',
  'feat.transcribe.p': '누가 말하든, 25개 언어 중 무엇으로 말하든, 말하는 대로 글이 됩니다. 언어는 문장마다 감지되므로 영어와 중국어를 오가는 통화에서도 중간에 설정을 바꿀 일이 없습니다.',
  'feat.cleanup.h': '깔끔하게 다듬습니다',
  'feat.cleanup.p': '‘음’, 하다 만 말, 두 번 시작한 문장은 기록에서 모두 사라집니다. 스스로 고쳐 말하면 마지막에 정한 내용이 남습니다. 숫자, 이름, 날짜는 다듬으면서도 건드리지 않습니다.',
  'feat.translate.h': '모든 언어로 번역합니다',
  'feat.translate.p': '한 문장이 고른 언어 전부로 동시에 흘러나옵니다. 자리의 종류를 고르면(업무 회의, 공식 행사, 친구, 정치, 독서 모임, 엔지니어링) 말투가 따라갑니다. 격식은 격식대로, 편한 말은 편한 대로, 각 언어의 방식으로.',
  'feat.record.h': '회의 기록을 남깁니다',
  'feat.record.p': '모든 문장이 말한 시각과 함께 원문과 모든 번역으로 보관됩니다. 새로고침해도 남아 있고, 녹화에 얹을 자막 파일이나 누구나 열 수 있는 텍스트 파일로 내보낼 수 있습니다.',

  'record.h2': '회의가 있었던 그대로, 글로',
  'record.lede': '결정은 마지막 5분에, 절반이 이미 메모를 멈춘 뒤에 내려집니다. 모든 문장이 말한 그대로, 원문과 번역된 모든 언어로, 시각과 함께 남습니다.',
  'record.1.h': '모든 언어를 나란히',
  'record.1.p': '각 항목에 원문과 번역이 함께 남아, 숫자나 날짜를 기억이 아니라 원문과 대조할 수 있습니다.',
  'record.2.h': '통화가 끝나도 남습니다',
  'record.2.p': '기록은 새로고침해도 남고, 지울 때까지 있습니다. 내보내기는 SRT 파일로 씁니다. 녹화용 자막으로도, 누구나 읽을 수 있는 텍스트로도 쓸 수 있습니다.',
  'record.3.h': '참석하지 못한 사람을 위해',
  'record.3.p': '다른 시간대의 동료, 통화를 놓친 가족이 무슨 말이 오갔는지 자기 언어로 그대로 읽을 수 있습니다.',
  'record.sheet': '회의-2026-08-29.srt',
  'record.r1.said': 'Let’s move the launch to Friday.',
  'record.r1.rendered': '출시를 금요일로 옮깁시다.',
  'record.r2.said': '서버 쪽은 목요일까지 준비될까요?',
  'record.r2.rendered': 'Can the server side be ready by Thursday?',
  'record.r3.said': 'Thursday morning, if the review passes.',
  'record.r3.rendered': '리뷰가 통과되면 목요일 오전입니다.',

  'pricing.h2': '가끔 통화한다면 무료로 충분합니다',
  'pricing.lede': '두 요금제 모두 같은 번역입니다. 언어도, 회의 종류도, 규칙도 같습니다. 차이는 얼마나 말할 수 있는지뿐입니다.',
  'plan.free.tag': '모두 여기서 시작합니다',
  'plan.free.name': '무료',
  'plan.free.price': '$0',
  'plan.free.per': ' / 계속 무료',
  'plan.free.sub': '카드도, 체험 기간 카운트다운도 없습니다. 가입하면 이 요금제입니다.',
  'plan.free.f1': '매주 <strong>{words}</strong>단어',
  'plan.free.f2': '주간 무료 한도는 <strong>롤링</strong> 7일 기준',
  'plan.free.f3': '25개 언어와 여섯 가지 회의 종류 전부',
  'plan.free.f4': '한 통화에 번역할 언어 수 제한 없음',
  'plan.free.f5': '음성 읽기, 그리고 보관할 자막 파일',
  'plan.free.cta': '무료 계정 만들기',
  'plan.free.foot': '말하는 사람 모두가 같은 주간 단어 수를 씁니다.',
  'plan.pro.tag': '통화가 잦다면',
  'plan.pro.name': '무제한',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / 월',
  'plan.pro.sub': 'Stripe로 매월 20달러가 결제되고, 언제든 해지할 수 있습니다.',
  'plan.pro.f1': '단어 <strong>무제한</strong>, 주간 상한 없음',
  'plan.pro.f2': '무료 요금제의 기능은 그대로',
  'plan.pro.f3': '하루 종일 회의해도 남은 양을 신경 쓰지 않아도 됩니다',
  'plan.pro.f4': '앱 안에서 직접 해지하거나 카드를 바꿉니다',
  'plan.pro.f5': '결제 재시도 중에도 계속 쓸 수 있습니다',
  'plan.pro.cta': '무료로 시작하고 나중에 전환',
  'plan.pro.foot': '계정을 만든 뒤 앱 안에서 전환할 수 있습니다.',
  'plan.pro.off': '아직 제공하지 않습니다',
  'plan.pro.offsub': '이 배포에서는 구독이 활성화되어 있지 않습니다.',
  'plan.pro.offfoot': '현재 모든 계정은 무료 요금제로 유지됩니다.',
  'plan.pro.upgrade': '앱에서 구독하기',

  'faq.h2': '많이 물어보시는 것',
  'faq.q1': '단어는 어떻게 세나요?',
  'faq.a1': '실제로 입 밖에 낸 말을, 누가 했든 셉니다. 번역은 세지 않습니다. 한 문장이 한 언어로 가든 다섯 언어로 가든 같고, 소리로 듣는 것도 무료입니다. 중국어나 일본어처럼 단어를 띄어 쓰지 않는 언어는 글자 수로 셉니다.',
  'faq.q2': '무료 한 주로 어느 정도 쓸 수 있나요?',
  'faq.a2': '사람은 보통 1분에 130~150단어를 말하므로 {words}단어면 실제로 30분 넘게 말할 수 있는 분량입니다. 회의 한 번을 제대로 하거나 짧은 통화 몇 번에 충분합니다. 통화 도중에 다 쓰면 앱이 알려주고, 다음 한 주 동안 조금씩 다시 채워집니다.',
  'faq.q3': '‘롤링’ 한 주가 무슨 뜻인가요?',
  'faq.a3': '정해진 날에 초기화되는 것이 아니라 지금부터 지난 7일을 거슬러 셉니다. 월요일 통화에서 쓴 단어는 다음 월요일에 빠지므로 사용량이 조금씩 돌아옵니다. 초기화 시간을 기다릴 일이 없습니다.',
  'faq.q4': '통화의 다른 사람들이 할 일이 있나요?',
  'faq.a4': '없습니다. 한 사람이 회의실이나 통화 소리가 들리는 기기에서 켜 두면 나머지는 그냥 말하면 됩니다. 화면을 통화에 공유하면 다른 사람들도 번역을 볼 수 있습니다.',
  'faq.q5': '녹음과 기록은 어떻게 되나요?',
  'faq.a5': '음성은 이 배포에 설정된 음성 인식·번역 서비스로 전송되고 텍스트가 돌아옵니다. 이 서버는 음성도 기록도 저장하지 않습니다. 통화 내용은 지우거나 내보낼 때까지 브라우저에 남습니다. 계정에 남는 것은 이메일 주소, 구독 여부, 각 문장이 쓴 단어 수입니다.',
  'faq.q6': '로그인은 어떻게 하나요?',
  'faq.a6': '이메일 주소로 합니다. 링크를 보내드리면 눌러서 들어옵니다. 정하거나 잊어버릴 비밀번호가 없고, 처음 쓸 때는 같은 링크로 계정이 만들어지며 링크는 한 번만 작동합니다.',
  'faq.q7': '원할 때 해지할 수 있나요?',
  'faq.a7': '네. 구독은 앱에서 들어가는 Stripe 결제 포털에서 관리하고, 누구에게 연락하지 않아도 해지됩니다. 해지하면 계정이 사라지지 않고 무료 요금제로 돌아갑니다.',
  'faq.q8': '내보낸 파일은 어떤 모양인가요?',
  'faq.a8': 'SRT 자막 파일입니다. 모든 문장이 말한 시각과 함께, 다듬은 원문이 한 줄, 각 번역이 그 아래 한 줄씩 들어갑니다. 통화 녹화에 자막으로 얹거나 텍스트로 열면 됩니다. 이 과정에서 서버로 올라가는 것은 없습니다.',

  'cta.h2': '다음 통화에 가지고 가세요',
  'cta.p': '이메일 주소만 있으면 1분 안에 준비됩니다.',
  'foot.disclaimer': '이것은 통화를 따라갈 수 있게 돕는 기계 번역입니다. 보시기 전에 사람이 검토하지 않으며, 공인 번역이 아닙니다. 계약이나 법률과 관련된 내용은 원문을 확인한 뒤에 행동하세요.',

  'login.title': '로그인 · 회의 번역',
  'login.lede': '통화를 내 언어로 따라가고, 기록을 보관하세요. 이메일 주소를 입력하시면 로그인 링크를 보내드립니다. 정하거나 잊어버릴 비밀번호는 없습니다.',
  'login.email': '이메일 주소',
  'login.placeholder': 'you@example.com',
  'login.submit': '로그인 링크 보내기',
  'login.sending': '보내는 중…',
  'login.foot': '처음이신가요? 같은 링크로 가입됩니다. 무료 계정은 매주 <strong>{words}</strong>단어를 쓸 수 있고, 월 구독을 하면 제한이 없어집니다.',
  'login.sent': '{email}로 보낸 로그인 링크를 확인하세요. {minutes}분 뒤에 만료됩니다.',
  'login.devlink': '메일 서비스가 설정되어 있지 않아 링크를 여기 드립니다: <a href="{link}">로그인</a>',
  'login.error.invalid': '이 로그인 링크는 이미 사용되었거나 유효하지 않습니다. 아래에서 새로 요청해 주세요.',
  'login.error.expired': '이 로그인 링크는 만료되었습니다. 아래에서 새로 요청해 주세요.',
  'verify.title': '로그인 확인 · 회의 번역',
  'verify.lede': '이 링크는 이 기기에서 아래 계정의 세션을 엽니다. 계속하기 전에 원하시는 계정이 맞는지 확인해 주세요.',
  'verify.heading': '이 계정으로 로그인',
  'verify.continue': '계속',
  'verify.wrong': '다른 계정이신가요? <a href="/login">다른 계정용 링크를 요청해 주세요.</a>',

  'app.title': '회의 번역',
  'app.setup': '옵션',
  'app.callType': '회의 종류',
  'app.callType.hint': '어떤 자리인지; 모든 번역의 말투를 정합니다',
  'app.type.business': '업무 회의',
  'app.type.formal': '공식 행사',
  'app.type.friends': '친구와 가족',
  'app.type.politics': '정치와 시사',
  'app.type.book_club': '독서 모임',
  'app.type.tech': '기술과 엔지니어링',
  'app.targets': '번역할 언어',
  'app.targets.hint': '(하나 이상 고르세요)',
  'app.source': '말하는 언어',
  'app.source.auto': '자동 감지',
  'app.source.hint': '여기서 하나를 고정하지 않으면 문장마다 감지합니다',
  'app.export': '내보내기',
  'app.clear': '지우기',
  'app.empty': '<strong>듣기 시작</strong>을 누르고 말하세요.<br>각 문장이 받아 적히고, 다듬어지고, 고른 언어 전부로 한꺼번에 번역됩니다.',

  'app.mic.start': '듣기 시작',
  'app.mic.stop': '듣기 중지',
  'app.meter': '마이크 음량',
  'app.status.idle': '대기',
  'app.status.listening': '듣는 중',
  'app.status.speaking': '말하는 중…',
  'app.status.error': '오류',
  'app.status.loading': '음성 감지 모델 불러오는 중…',
  'app.err.mic': '마이크 오류: {message}',
  'app.err.https': '마이크를 쓰려면 HTTPS가 필요합니다. https:// 주소(예: Cloudflare 터널)나 localhost에서 이 페이지를 여세요.',
  'app.err.nomic': '이 브라우저는 마이크 API를 제공하지 않습니다. 다른 앱(메신저, QR 스캐너)이나 프라이버시 브라우저 안에서 링크를 열었다면 Chrome에서 직접 여세요.',
  'app.err.config': '설정을 불러오지 못했습니다: {message}',
  'app.err.tts': '음성 읽기: {message}',
  'app.err.billing': '결제: {message}',

  'app.turn.transcribing': '받아 적는 중…',
  'app.turn.detecting': '감지 중…',
  'app.turn.source': '원문',
  'app.turn.asSpoken': '{lang} · 원문',
  'app.turn.sameAsSource': '{lang} · 원문과 같음',
  'app.turn.failed': '받아 적기에 실패했습니다: {message}',
  'app.turn.readAloud': '소리 내어 읽기',
  'app.turn.noTargets': '고른 언어가 없습니다. 위에서 하나 고르면 다음 문장부터 번역됩니다.',
  'app.export.empty': '아직 내보낼 것이 없습니다',

  'app.plan.free': '무료 요금제',
  'app.plan.pro': '무제한',
  'app.quota.left': '이번 주 {limit}단어 중 {remaining}단어 남음',
  'app.quota.hint': '롤링 7일 기준: 말한 지 7일이 지난 단어는 더 이상 세지 않습니다.',
  'app.quota.resets': ' 한도 일부가 {when}에 돌아옵니다.',
  'app.quota.spent': '<strong>이번 주 무료 한도를 모두 사용했습니다.</strong> 롤링 기간이 한도를 돌려줄 때까지 번역이 중단됩니다. {when}',
  'app.quota.reached': '주간 단어 한도에 도달했습니다',
  'app.upgrade': '무제한 구독',
  'app.manage': '구독 관리',
  'app.logout': '로그아웃',

  // ── Language names, as this interface calls them ────────────────────
  'langname.English': '영어',
  'langname.Chinese': '중국어',
  'langname.Cantonese': '광둥어',
  'langname.Spanish': '스페인어',
  'langname.Korean': '한국어',
  'langname.Japanese': '일본어',
};

STRINGS.ja = {
  'brand': '会議翻訳',
  'lang.label': '言語',

  'home.title': '会議翻訳 — 会議で話されたすべてを、すべての言語で',
  'nav.how': '使い方',
  'nav.features': 'できること',
  'nav.record': '会議の記録',
  'nav.pricing': '料金',
  'nav.faq': 'よくある質問',
  'nav.signin': 'ログイン',
  'nav.start': '無料で始める',
  'nav.open': '翻訳を開く',

  'hero.eyebrow': '🎙️ マイク一本で、通話に出てくるすべての言語を',
  'hero.h1': '会議で話されたすべてを、<span class="hl">すべての言語で</span>。',
  'hero.lede': '誰かが話すと、一秒後にはその文が画面に出ます。文字に起こし、「えっと」や言いかけをそぎ落とし、選んだ言語すべてに同時に翻訳します。通話が終わるころには会話全体が文字で残り、そのまま保存できます。',
  'hero.seehow': '使い方を見る',
  'hero.note': '新しいアカウントは無料です。毎週 <strong>{words}</strong> 語まで、カード登録は要りません。',

  'shot.bar': '認識中 · ビジネス会議 · 言語を自動判定',
  'shot.source': '英語 · 判定済み',
  'shot.said': 'Let’s move the launch to Friday, and I’ll send the revised numbers tonight.',
  'shot.t1.lang': '日本語',
  'shot.t1.text': 'ローンチは金曜に変更しましょう。修正した数字は今夜お送りします。',
  'shot.t2.lang': '中国語',
  'shot.t2.text': '我们把发布改到周五，修改后的数字我今晚发给大家。',
  'shot.t3.lang': 'スペイン語',
  'shot.t3.text': 'Pasemos el lanzamiento al viernes; esta noche les mando las cifras revisadas.',
  'shot.note': 'すべての文が、選んだ言語すべてに同時に届きます。',

  'how.h2': '三つの手順、あとは邪魔をしません',
  'how.lede': 'インストールは不要で、通話の相手側がすることもありません。すでに会議室にあるノートパソコンやスマホのブラウザで動きます。',
  'how.1.h': '言語を選ぶ',
  'how.1.p': 'どの言語に訳すかを一つでも五つでも選び、どんな場かを選びます。会議、家族との通話、読書会。話されている言語は文ごとに自動で判定されるので、誰が話すかを宣言する必要はありません。',
  'how.2.h': 'いつも通りに話す',
  'how.2.p': 'ブラウザ内の音声検出が話し始めと話し終わりを聞き分けるので、静かな間は何も送られず、ボタンを押し続ける必要もありません。長い発言は自然な間で区切られます。',
  'how.3.h': '読む、聞く、残す',
  'how.3.p': '一文ごとに1〜2秒で選んだ言語すべてに表示され、読み上げて聞くこともできます。通話が終わったら字幕ファイルとして書き出します。',

  'feat.h2': 'できること',
  'feat.lede': '誰かが話す一文ごとに、四つのことを順番に行います。',
  'feat.transcribe.h': '誰の発言でも文字にする',
  'feat.transcribe.p': '誰が話しても、25の言語のどれで話しても、話すそばから文字になります。言語は文ごとに判定されるので、英語と中国語を行き来する通話でも途中で設定を変える必要はありません。',
  'feat.cleanup.h': '文字を整える',
  'feat.cleanup.p': '「えっと」、言いかけ、二度言い直した文は記録から消えます。自分で言い直したときは、最後に決めた内容が残ります。数字、名前、日付は整える際にも触りません。',
  'feat.translate.h': 'すべての言語に翻訳する',
  'feat.translate.p': '一つの文が、選んだ言語すべてに同時に流れます。場の種類を選べば（会議、式典、友人、政治、読書会、エンジニアリング）、言葉づかいがそれに合います。改まった話は改まったまま、くだけた話はくだけたまま、それぞれの言語のやり方で。',
  'feat.record.h': '会議の記録を残す',
  'feat.record.p': 'すべての文が、話された時刻と一緒に、原文とすべての翻訳で保存されます。再読み込みしても残り、録画に載せる字幕ファイルや誰でも開けるテキストファイルとして書き出せます。',

  'record.h2': '会議を、あった通りに文字で',
  'record.lede': '決定は最後の五分で下されます。半分の人がもうメモを取らなくなったころに。すべての文が話された通りに、原文と翻訳されたすべての言語で、時刻付きで残ります。',
  'record.1.h': 'すべての言語を並べて',
  'record.1.p': '各項目に原文と翻訳が残るので、数字や日付を記憶ではなく原文と照らし合わせられます。',
  'record.2.h': '通話が終わっても残る',
  'record.2.p': '記録は再読み込みしても残り、消すまでそこにあります。書き出しはSRTファイルです。録画の字幕にも、誰でも読めるテキストにもなります。',
  'record.3.h': '参加できなかった人のために',
  'record.3.p': '別のタイムゾーンにいる同僚、通話に出られなかった家族。何が話されたかを、自分の言語でそのまま読めます。',
  'record.sheet': '会議-2026-08-29.srt',
  'record.r1.said': 'Let’s move the launch to Friday.',
  'record.r1.rendered': 'ローンチは金曜に変更しましょう。',
  'record.r2.said': 'サーバー側は木曜までに準備できますか。',
  'record.r2.rendered': 'Can the server side be ready by Thursday?',
  'record.r3.said': 'Thursday morning, if the review passes.',
  'record.r3.rendered': 'レビューが通れば、木曜の午前中です。',

  'pricing.h2': 'たまの通話なら無料で足ります',
  'pricing.lede': 'どちらのプランも同じ翻訳です。言語も会議の種類も決まりも同じで、違うのは話せる量だけです。',
  'plan.free.tag': '全員ここから始まります',
  'plan.free.name': '無料',
  'plan.free.price': '$0',
  'plan.free.per': ' / ずっと無料',
  'plan.free.sub': 'カードも、試用期間のカウントダウンもありません。登録するとこのプランになります。',
  'plan.free.f1': '毎週 <strong>{words}</strong> 語',
  'plan.free.f2': '毎週の無料枠は7日間の<strong>ローリング</strong>方式',
  'plan.free.f3': '25の言語と六つの会議の種類すべて',
  'plan.free.f4': '一つの通話で訳す言語の数に制限なし',
  'plan.free.f5': '読み上げと、保存できる字幕ファイル',
  'plan.free.cta': '無料アカウントを作る',
  'plan.free.foot': '話す人全員が同じ週の語数を使います。',
  'plan.pro.tag': '通話が多いなら',
  'plan.pro.name': '無制限',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / 月',
  'plan.pro.sub': 'Stripeで毎月20米ドルをお支払い。いつでも解約できます。',
  'plan.pro.f1': '語数<strong>無制限</strong>。週の上限なし',
  'plan.pro.f2': '無料プランの内容はそのまま',
  'plan.pro.f3': '一日中会議でも残量を気にせずに済みます',
  'plan.pro.f4': '解約もカードの変更もアプリの中で自分でできます',
  'plan.pro.f5': '支払いの再試行中も使い続けられます',
  'plan.pro.cta': 'まず無料で始めて、あとから切り替え',
  'plan.pro.foot': 'アカウントを作ったあと、アプリの中で切り替えられます。',
  'plan.pro.off': 'まだ提供していません',
  'plan.pro.offsub': 'この環境では定期購入が有効になっていません。',
  'plan.pro.offfoot': '現在すべてのアカウントが無料プランのままです。',
  'plan.pro.upgrade': 'アプリで登録する',

  'faq.h2': 'よく聞かれること',
  'faq.q1': '何を1語として数えますか',
  'faq.a1': '誰が言ったかにかかわらず、実際に声に出した言葉を数えます。翻訳は数えません。一つの文が一言語に行っても五言語に行っても同じで、読み上げも無料です。中国語や日本語のように単語を分けて書かない言語は、文字数で数えます。',
  'faq.q2': '無料の1週間でどのくらい使えますか',
  'faq.a2': '人が話す速さはおおよそ1分間に130〜150語なので、{words} 語なら実際に話す時間で30分あまりぶんです。会議1回、または短い通話数回に足ります。通話の途中で使い切るとアプリが知らせ、翌週にかけて少しずつ戻ります。',
  'faq.q3': '「ローリング」の1週間とは',
  'faq.a3': '決まった日にリセットするのではなく、今から7日さかのぼって数えます。月曜の通話で使った分は次の月曜に外れるので、使える量は少しずつ戻ります。リセットの時刻を待つ必要はありません。',
  'faq.q4': '通話の相手側に必要なものはありますか',
  'faq.a4': 'ありません。一人が、部屋や通話の音が聞こえる端末で動かすだけで、あとの人は普通に話すだけです。画面を通話に共有すれば、相手側にも翻訳が見えます。',
  'faq.q5': '音声と記録はどうなりますか',
  'faq.a5': '音声はこの環境に設定された音声認識と翻訳のサービスに送られ、文字が返ってきます。このサーバーは音声も記録も保存しません。通話の内容は、消すか書き出すまでブラウザの中にあります。アカウントに残るのは、メールアドレス、契約の状態、各文で使った語数です。',
  'faq.q6': 'ログインの方法は',
  'faq.a6': 'メールアドレスで行います。リンクをお送りするので、押すだけで入れます。決めたり忘れたりするパスワードはなく、初めて使うときは同じリンクでアカウントができ、リンクは一度だけ使えます。',
  'faq.q7': 'いつでも解約できますか',
  'faq.a7': 'できます。定期購入はアプリから入れるStripeの支払いページで管理し、誰かに連絡しなくても解約できます。解約するとアカウントは消えず、無料プランに戻ります。',
  'faq.q8': '書き出したファイルはどんな形ですか',
  'faq.a8': 'SRT字幕ファイルです。すべての文に話された時刻が付き、整えた原文が一行、各翻訳がその下に一行ずつ入ります。通話の録画に字幕として載せるか、テキストとして開いてください。この間、サーバーには何も送られません。',

  'cta.h2': '次の通話に持って行ってください',
  'cta.p': 'メールアドレスだけで、1分かからずに使えるようになります。',
  'foot.disclaimer': 'これは通話を追うための機械翻訳です。目にする前に人が確認することはなく、認定された翻訳でもありません。契約や法律に関わる内容は、原文を確認してから行動してください。',

  'login.title': 'ログイン · 会議翻訳',
  'login.lede': '通話を自分の言語で追いかけ、記録を残せます。メールアドレスを入力していただくと、ログイン用のリンクをお送りします。決めたり忘れたりするパスワードはありません。',
  'login.email': 'メールアドレス',
  'login.placeholder': 'you@example.com',
  'login.submit': 'ログイン用リンクを送る',
  'login.sending': '送信中…',
  'login.foot': '初めてですか。同じリンクで登録できます。無料アカウントは毎週 <strong>{words}</strong> 語まで使え、月額の定期購入で上限がなくなります。',
  'login.sent': '{email} に送ったログイン用リンクをご確認ください。{minutes} 分で無効になります。',
  'login.devlink': 'メールサービスが設定されていないため、リンクをここに示します: <a href="{link}">ログイン</a>',
  'login.error.invalid': 'このログイン用リンクはすでに使用されているか、有効なリンクではありません。下から新しいリンクを請求してください。',
  'login.error.expired': 'このログイン用リンクは期限切れです。下から新しいリンクを請求してください。',
  'verify.title': 'ログインの確認 · 会議翻訳',
  'verify.lede': 'このリンクは、この端末で下のアカウントのセッションを開きます。続ける前に、意図したアカウントかご確認ください。',
  'verify.heading': 'このアカウントでログイン',
  'verify.continue': '続ける',
  'verify.wrong': '別のアカウントですか。<a href="/login">別のアカウント用のリンクを請求する</a>',

  'app.title': '会議翻訳',
  'app.setup': 'オプション',
  'app.callType': '会議の種類',
  'app.callType.hint': 'どんな場か。すべての翻訳の言葉づかいを決めます',
  'app.type.business': 'ビジネス会議',
  'app.type.formal': '式典・公式の場',
  'app.type.friends': '友人・家族',
  'app.type.politics': '政治・時事',
  'app.type.book_club': '読書会',
  'app.type.tech': '技術・エンジニアリング',
  'app.targets': '翻訳先',
  'app.targets.hint': '（一つ以上選んでください）',
  'app.source': '話す言語',
  'app.source.auto': '自動判定',
  'app.source.hint': 'ここで固定しない限り、文ごとに判定します',
  'app.export': '書き出し',
  'app.clear': '消去',
  'app.empty': '<strong>受信を開始</strong>を押して話してください。<br>各文が文字に起こされ、整えられ、選んだ言語すべてに同時に翻訳されます。',

  'app.mic.start': '受信を開始',
  'app.mic.stop': '受信を停止',
  'app.meter': 'マイクの音量',
  'app.status.idle': '待機中',
  'app.status.listening': '認識中',
  'app.status.speaking': '発話中…',
  'app.status.error': 'エラー',
  'app.status.loading': '音声検出モデルを読み込み中…',
  'app.err.mic': 'マイクのエラー: {message}',
  'app.err.https': 'マイクの利用にはHTTPSが必要です。https:// のアドレス（Cloudflareトンネルなど）か localhost でこのページを開いてください。',
  'app.err.nomic': 'このブラウザはマイクのAPIを公開していません。別のアプリ（チャット、QRリーダー）やプライバシーブラウザの中でリンクを開いた場合は、Chromeで直接開いてください。',
  'app.err.config': '設定を読み込めませんでした: {message}',
  'app.err.tts': '読み上げ: {message}',
  'app.err.billing': '請求: {message}',

  'app.turn.transcribing': '文字起こし中…',
  'app.turn.detecting': '判定中…',
  'app.turn.source': '原文',
  'app.turn.asSpoken': '{lang} · 原文',
  'app.turn.sameAsSource': '{lang} · 原文と同じ',
  'app.turn.failed': '文字起こしに失敗しました: {message}',
  'app.turn.readAloud': '読み上げる',
  'app.turn.noTargets': '言語が選ばれていません。上で一つ選ぶと次の文から翻訳されます。',
  'app.export.empty': 'まだ書き出すものがありません',

  'app.plan.free': '無料プラン',
  'app.plan.pro': '無制限',
  'app.quota.left': '今週はあと {remaining} / {limit} 語',
  'app.quota.hint': '7日間のローリング方式: 話してから7日経った語は数えなくなります。',
  'app.quota.resets': ' 枠の一部が {when} に戻ります。',
  'app.quota.spent': '<strong>今週の無料分を使い切りました。</strong>ローリング期間で上限が戻るまで翻訳を停止します。{when}',
  'app.quota.reached': '週の語数上限に達しました',
  'app.upgrade': '無制限に登録',
  'app.manage': '契約を管理',
  'app.logout': 'ログアウト',

  // ── Language names, as this interface calls them ────────────────────
  'langname.English': '英語',
  'langname.Chinese': '中国語',
  'langname.Cantonese': '広東語',
  'langname.Spanish': 'スペイン語',
  'langname.Korean': '韓国語',
  'langname.Japanese': '日本語',
};
