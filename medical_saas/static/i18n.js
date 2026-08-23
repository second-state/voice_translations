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

const I18N_KEY = 'medical_saas_locale';
const LANGS_KEY = 'medical_saas_languages';

/* The interface languages, with the app language each one implies for the
 * patient. Someone reading the interface in Spanish is, by default, sitting
 * with a Spanish-speaking patient. */
const LOCALES = [
  { code: 'en', label: 'English', patient: 'English' },
  { code: 'zh', label: '简体中文', patient: 'Chinese' },
  { code: 'yue', label: '繁體中文', patient: 'Cantonese' },
  { code: 'es', label: 'Español', patient: 'Spanish' },
  { code: 'ko', label: '한국어', patient: 'Korean' },
  { code: 'ja', label: '日本語', patient: 'Japanese' },
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

/** The app language a locale implies for the patient side. */
function patientLanguageFor(code) {
  return (LOCALES.find((l) => l.code === code) || LOCALES[0]).patient;
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
 * `attribute:key` pairs. */
/* A marked-up element may carry its own placeholder values, so a string
   like "{words} words a week" re-renders correctly when the language
   changes without the page having to re-supply the number. */
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

/* The encounter's two languages, remembered across sessions once chosen.
 * Kept here beside the interface language because the two are related: the
 * patient side starts as whatever language the interface is in. */
function storedLanguages() {
  try {
    const saved = JSON.parse(localStorage.getItem(LANGS_KEY) || 'null');
    return saved && saved.clinician && saved.patient ? saved : null;
  } catch {
    return null;
  }
}

function rememberLanguages(clinician, patient) {
  try {
    localStorage.setItem(LANGS_KEY, JSON.stringify({ clinician, patient }));
  } catch (err) {
    console.warn('could not remember the encounter languages:', err.message);
  }
}

const STRINGS = {};

STRINGS.en = {
  // ── Shared ──────────────────────────────────────────────────────────
  'brand': 'Medical Translator',
  'lang.label': 'Language',
  'common.clinician': 'Clinician',
  'common.patient': 'Patient',

  // ── Landing page ────────────────────────────────────────────────────
  'home.title': 'Medical Translator — understand your doctor, keep what was said',
  'nav.how': 'How it works',
  'nav.features': 'What it gets right',
  'nav.pricing': 'Pricing',
  'nav.faq': 'Questions',
  'nav.signin': 'Sign in',
  'nav.start': 'Start free',
  'nav.open': 'Open the translator',

  'hero.eyebrow': '🎙️ Put your phone on the table and talk',
  'hero.h1': 'Understand what the doctor said. <span class="hl">Take it home in writing.</span>',
  'hero.lede': 'The doctor speaks one language, you speak another, and the appointment goes by fast. Put your phone between you and every sentence appears in your language a second after it is spoken, with the doses, the dates and the warnings kept word for word. When you leave, the whole conversation leaves with you.',
  'hero.seehow': 'See how it works',
  'hero.note': 'New accounts are free: <strong>{words}</strong> words a week, no card.',
  'shot.bar': 'Listening · Heart clinic · English ↔ Spanish',
  'shot.who.doctor': 'Doctor',
  'shot.who.you': 'You',
  'shot.dir.cp': 'English → Spanish',
  'shot.dir.pc': 'Spanish → English',
  'shot.said1': 'Start Lasix, 40 milligrams every morning, and stop the fluid pills you were taking.',
  'shot.rendered1': 'Empiece a tomar Lasix, 40 miligramos todas las mañanas, y deje las pastillas para el líquido que estaba tomando.',
  'shot.said2': 'No he tomado nada desde el jueves porque me daba mareos.',
  'shot.rendered2': 'I haven’t taken anything since Thursday because it was making me dizzy.',
  'shot.flag': 'Every number the doctor says is checked against the translation.',

  'how.h2': 'Three steps in the exam room',
  'how.lede': 'Nothing to install and nobody to phone. It runs in the browser on the phone you already carry.',
  'how.1.h': 'Set the two languages',
  'how.1.p': 'Your language and the one the doctor speaks, then the kind of visit: heart, pregnancy, cancer, mental health. That is how the words that belong to this visit come out right.',
  'how.2.h': 'Talk the way you normally would',
  'how.2.p': 'It hears when each person starts and stops speaking, so nobody holds a button and nothing is sent while the room is quiet. Tell the doctor you are using it, and put the phone where you can both be heard.',
  'how.3.h': 'Read it, hear it, keep it',
  'how.3.p': 'Each sentence shows up in your language a second or two after it is said, and it can be read out loud. By the time you leave, the visit is written down and saved on your phone.',

  'feat.h2': 'Where a medical visit goes wrong in translation',
  'feat.lede': 'A general translation app aims for a sentence that reads well. Here, nothing may be added, dropped or softened, even when the result comes out blunt.',
  'feat.doses.h': 'The dose stays the dose',
  'feat.doses.p': 'Numbers, units, how often and how long come through exactly as spoken. Nothing is rounded, converted to other units, or turned into “a few”. If a number goes missing from the translation, it is flagged so you can ask again.',
  'feat.neg.h': '“No” does not turn into “yes”',
  'feat.neg.p': '“No fever”, “not allergic”, “never smoked”, “do not take it with food”. A “not” cannot be lost on the way into your language, and it cannot appear where nobody said one.',
  'feat.side.h': 'Left stays left',
  'feat.side.p': 'Which side, which arm, which eye. It comes through as spoken, and is never dropped to make the sentence read more smoothly.',
  'feat.spec.h': '19 kinds of visit',
  'feat.spec.p': 'Heart, cancer, pregnancy, mental health, pharmacy, surgery and more. Each one knows its own vocabulary and its own traps: units against millilitres for insulin, which eye the drops go in, whether a treatment is meant to cure you or to keep you comfortable.',
  'feat.mishear.h': 'It repairs what the microphone got wrong',
  'feat.mishear.p': 'The doctor says Lasix and speech recognition writes <code>lay six</code>. Knowing the kind of visit, it puts the real word back. It never “fixes” a number that way, because a number has nothing to check it against.',
  'feat.uncert.h': '“Maybe” stays “maybe”',
  'feat.uncert.p': '“It might be”, “we think”, “we have to rule it out” stay uncertain, and what the doctor is sure about stays sure. That is the difference you are agreeing to when you say yes.',
  'feat.langs.h': '25 languages',
  'feat.langs.p': 'Spanish, Mandarin, Hong Kong Cantonese, Vietnamese, Tagalog, Korean, Arabic, Haitian Creole, Somali and more, each written the way people speak it in a clinic rather than the way a textbook would.',
  'feat.disfl.h': 'The stumbles come out, the meaning stays',
  'feat.disfl.p': 'False starts and half-finished words are cleaned up, and when someone corrects themselves you get what they settled on. No number, medicine name, “not” or body part is touched in the cleaning.',
  'feat.privacy.h': 'Nothing is kept on our side',
  'feat.privacy.p': 'We keep no recording and no transcript of your visit. It lives in your browser until you clear it or save it. What we store is your email address and whether you subscribe.',

  'pricing.h2': 'Free for the occasional appointment',
  'pricing.lede': 'Both plans are the same translator, with every language, every kind of visit and every safety rule. The difference is how much can be said.',
  'plan.free.tag': 'Where everyone starts',
  'plan.free.name': 'Free',
  'plan.free.price': '$0',
  'plan.free.per': ' / forever',
  'plan.free.sub': 'No card and no trial clock. Signing up puts you here.',
  'plan.free.f1': '<strong>{words}</strong> translated words a week',
  'plan.free.f2': 'A <strong>rolling</strong> seven-day window for the weekly free quota',
  'plan.free.f3': 'All 25 languages and all 19 kinds of visit',
  'plan.free.f4': 'Every safety rule, the number check, and the microphone repair',
  'plan.free.f5': 'Read-aloud, and the written record to take home',
  'plan.free.cta': 'Create a free account',
  'plan.free.foot': 'What you say and what the doctor says both count toward the weekly words.',
  'plan.pro.tag': 'For frequent appointments',
  'plan.pro.name': 'Unlimited',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / month',
  'plan.pro.sub': 'Billed monthly through Stripe. Cancel any time.',
  'plan.pro.f1': '<strong>Unlimited</strong> words, with no weekly ceiling',
  'plan.pro.f2': 'Everything in the free plan, unchanged',
  'plan.pro.f3': 'A long night in the emergency room without watching a counter',
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
  'faq.a1': 'The words actually spoken, on both sides. The translation itself is free: a sentence costs the same whether your language needs three words for it or thirty, and hearing it read aloud costs nothing. Chinese, Japanese and other languages written without spaces are counted by character.',
  'faq.q9': 'How far does a free week go?',
  'faq.a9': 'People speak around 130 to 150 words a minute and both sides count, so {words} words covers a short appointment: the questions and the instructions, not the small talk. If you run out in the middle of a visit the app says so, and the allowance comes back over the following week.',
  'faq.q2': 'What does a “rolling” week mean?',
  'faq.a2': 'Usage is counted from right now backwards over seven days rather than reset on a fixed day. Words spent at Monday’s appointment stop counting the next Monday, so the allowance returns a little at a time. There is no reset hour to wait for.',
  'faq.q3': 'Should I still ask for the hospital interpreter?',
  'faq.a3': 'Yes, and you do not have to choose between them. In the United States a hospital or clinic that receives federal funding must provide you a professional interpreter, by phone or in person, free of charge. Ask for one before you sign anything, and for consent, test results, or bad news. This app is a machine translation that nobody checks before you read it, so use it to follow what is happening, to prepare your questions, and to keep the record.',
  'faq.q4': 'What happens to the audio and the transcript?',
  'faq.a4': 'Speech goes to the speech recognition and translation services this deployment is set up to use, and the text comes back. This server keeps neither the audio nor the transcript: the visit stays in your browser until you clear it or save it. Your account holds your email address, whether you subscribe, and how many words each turn used.',
  'faq.q5': 'How do I sign in?',
  'faq.a5': 'With your email address. We send a link, you tap it, and you are in. There is no password to choose or forget, the same link creates your account the first time, and each link works once.',
  'faq.q6': 'Can I cancel whenever I want?',
  'faq.a6': 'Yes. Subscriptions are handled in Stripe’s billing portal, which you reach from inside the app, and cancelling takes effect without asking anyone. Your account goes back to the free plan rather than disappearing.',
  'faq.q7': 'Does it work on my phone in the waiting room?',
  'faq.a7': 'Yes. It runs in the browser with nothing to install, and the screen stays awake while a visit is open. The browser asks for the microphone the first time, and only allows it over a secure https address.',

  'cta.h2': 'Take it to your next appointment',
  'cta.p': 'An email address is all it takes, and you will be set up in under a minute.',
  'foot.disclaimer': 'This is a machine translation to help you follow a medical visit. It is not a certified medical interpretation, and nobody reviews it before you see it. If a clinic or hospital offers you a professional interpreter, take it, and ask again about anything here that does not match what you understood.',

  // ── The record a visit leaves behind ────────────────────────────────
  'nav.record': 'What you keep',
  'record.h2': 'Everything that was said, still there when you get home',
  'record.lede': 'The dose, the date to come back, the thing to call about: most of it is said in the last five minutes, when you are already reaching for your coat. Every sentence from both sides is written down as it is spoken, in both languages, with the time beside it. Read it again at the pharmacy, at home, as many times as you need.',
  'record.1.h': 'Both languages, side by side',
  'record.1.p': 'You keep the doctor’s own words and what they mean in your language. If a dose looks wrong later, you can check what was said instead of trusting your memory.',
  'record.2.h': 'It is still there tomorrow',
  'record.2.p': 'The visit stays in your browser after you close the page, and saves as a file you can print, email, or show at the pharmacy counter.',
  'record.3.h': 'For the family who could not come',
  'record.3.p': 'The daughter who sorts the pills, the son who drives to the next appointment: they can read exactly what the doctor said, in your own language, instead of a summary repeated at the door.',
  'record.sheet': 'visit-2026-08-23.txt',
  'record.r1.said': 'Take one tablet twice a day, and stop the other one.',
  'record.r1.rendered': 'Tome una pastilla dos veces al día, y la otra déjela.',
  'record.r2.said': '¿Me va a dar mareos?',
  'record.r2.rendered': 'Will it make me dizzy?',
  'record.r3.said': 'It can at first. Come back in two weeks.',
  'record.r3.rendered': 'Al principio puede. Vuelva en dos semanas.',
  'faq.q8': 'Can I take the record home?',
  'faq.a8': 'That is what it is for. Saving writes every turn, in both languages, into a plain text file with the time of each entry: who spoke, what they said, and what it means. The visit also stays in your browser until you clear it, so you can read it again before you leave. Nothing is uploaded to this server for that to work.',

  // ── Sign-in page ────────────────────────────────────────────────────
  'login.title': 'Sign in · Medical Translator',
  'login.lede': 'Follow what is said at a medical visit in your own language, and keep a copy of it afterwards. Enter your email and we will send you a sign-in link, with no password to choose or forget.',
  'login.email': 'Email address',
  'login.placeholder': 'you@example.com',
  'login.submit': 'Email me a sign-in link',
  'login.sending': 'Sending…',
  'login.foot': 'New here? The same link signs you up. Free accounts include <strong>{words}</strong> translated words a week, and a monthly subscription removes the limit.',
  'login.sent': 'Check {email} for a sign-in link. It expires in {minutes} minutes.',
  'login.devlink': 'No mail provider is configured, so here is your link: <a href="{link}">sign in</a>',
  'login.expired': 'That sign-in link has expired or was already used. Request a new one.',

  // ── Console: setup ──────────────────────────────────────────────────
  'app.title': 'Medical Translator',
  'app.setup': 'Encounter setup',
  'app.specialty': 'Specialty',
  'app.specialty.hint': 'Tunes both speech recognition and translation to this field',
  'app.clinicianSpeaks': 'Clinician speaks',
  'app.patientSpeaks': 'Patient speaks',
  'app.swap': 'Swap the two languages',
  'app.roleHint': 'The speaker is detected from the language of each turn — use the Clinician/Patient buttons on a message to correct it.',
  'app.export': 'Export',
  'app.clear': 'Clear',
  'app.empty': 'Pick the specialty and the two languages, then press <strong>Start listening</strong>.<br>Each utterance is transcribed, attributed to the clinician or the patient, and translated into the other language.',

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

  // ── Console: turns ──────────────────────────────────────────────────
  'app.turn.transcribing': 'Transcribing…',
  'app.turn.spoken': 'Spoken',
  'app.turn.asSpoken': '{lang} · as spoken',
  'app.turn.interpreted': '{lang} · translated',
  'app.turn.failed': 'Transcription failed: {message}',
  'app.turn.whoSpoke': 'Who spoke this turn',
  'app.turn.isSpeaker': 'Speaker of this turn',
  'app.turn.reassign': 'Reassign this turn and translate again',
  'app.turn.substituted': '⚠ recognizer said {detected}; treated as {used}',
  'app.turn.deviation': '⚠ sounds like {detected}, expected {expected}',
  'app.turn.sameLang': 'Both parties are speaking {lang} — nothing to translate.',
  'app.turn.readAloud': 'Read aloud',
  'app.numbers': 'Check the numbers: <b>{missing}</b> appeared in the speech but not in the translation. Some languages write figures as words — confirm before acting on it.',
  'app.export.empty': 'Nothing to export yet',

  // ── Console: account bar ────────────────────────────────────────────
  // ── The exported record ─────────────────────────────────────────────
  'export.title': 'RECORD OF YOUR VISIT',
  'export.date': 'Date:',
  'export.specialty': 'Department:',
  'export.languages': 'Languages:',
  'export.turns': 'Entries:',
  'export.disclaimer': 'This is a machine translation of what was said during the visit. It was not reviewed by a person, and it does not replace a qualified medical interpreter. If anything here is unclear, or does not match what you remember, ask the clinic before acting on it.',
  'export.into': 'Translated into {lang}:',
  'export.sameLang': '(both sides were speaking this language — nothing was translated)',

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
  'app.err.billing': 'Billing: {message}',
  'app.err.tts': 'TTS: {message}',
  'app.err.config': 'Config load failed: {message}',
};

STRINGS.zh = {
  'brand': '医疗翻译',
  'lang.label': '界面语言',
  'common.clinician': '医护',
  'common.patient': '患者',

  'home.title': '医疗翻译：听懂医生的话，把这次看病的记录带回家',
  'nav.how': '怎么用',
  'nav.features': '不会译丢的地方',
  'nav.pricing': '价格',
  'nav.faq': '常见问题',
  'nav.signin': '登录',
  'nav.start': '免费开始',
  'nav.open': '打开翻译',

  'hero.eyebrow': '🎙️ 把手机放在桌上，正常说话就行',
  'hero.h1': '听懂医生说了什么，<span class="hl">再把整段对话带回家</span>。',
  'hero.lede': '医生讲英文，您讲中文，几分钟的问诊一晃就过去了。把手机放在两个人中间，每句话说完一两秒就变成中文出现在屏幕上，药量、日期、要注意的事都照原话保留。走出诊室的时候，这段对话跟着您一起走。',
  'hero.seehow': '看看怎么用',
  'hero.note': '新账号免费：每周 <strong>{words}</strong> 个词，不用信用卡。',
  'shot.bar': '正在听 · 心脏科 · 英文 ↔ 中文',
  'shot.who.doctor': '医生',
  'shot.who.you': '您',
  'shot.dir.cp': '英文 → 中文',
  'shot.dir.pc': '中文 → 英文',
  'shot.said1': 'Start Lasix, 40 milligrams every morning, and stop the fluid pills you were taking.',
  'shot.rendered1': '开始吃 Lasix（呋塞米），每天早上 40 毫克，原来那个利尿的药停掉。',
  'shot.said2': '我从周四就没吃了，因为吃了头晕。',
  'shot.rendered2': 'I haven’t taken it since Thursday because it made me dizzy.',
  'shot.flag': '医生说的每个数字都会跟译文对一遍。',

  'how.h2': '诊室里的三步',
  'how.lede': '不用装任何东西，也不用打电话找人。手机上的浏览器打开就能用。',
  'how.1.h': '选两个语言',
  'how.1.p': '选您说的语言和医生说的语言，再选这次看的科：心脏、怀孕、肿瘤、精神科。这样这一科的专门说法才不会译歪。',
  'how.2.h': '照平常那样讲',
  'how.2.p': '它自己听得出谁开始讲、谁讲完了，不用一直按着按钮，屋里没人说话的时候也不会往外传。跟医生说一声您在用翻译，把手机放在两个人都能听见的地方。',
  'how.3.h': '看得到，听得到，留得下',
  'how.3.p': '每句话说完一两秒就用中文显示出来，也可以点开听。等您离开诊室，这次看病的对话已经全部记下来，存在手机里了。',

  'feat.h2': '看病时最容易译丢的东西',
  'feat.lede': '普通翻译软件想把句子说得顺。这里要的是不添、不漏、不打折扣，哪怕译出来有点生硬。',
  'feat.doses.h': '药量一个字都不能改',
  'feat.doses.p': '数字、单位、一天几次、吃多久，都照原话出来。不四舍五入，不换算成别的单位，也不会变成「几片」。要是译文里少了一个数字，会给您标出来，让您再问一遍。',
  'feat.neg.h': '「不」不会变成「要」',
  'feat.neg.p': '「没有发烧」、「不过敏」、「从来不抽烟」、「不要跟饭一起吃」。这个「不」字不会在译成中文的时候掉了，也不会凭空多出来。',
  'feat.side.h': '左边还是左边',
  'feat.side.p': '哪一边、哪只手、哪只眼睛，都照原话译，不会为了句子顺就省掉。',
  'feat.spec.h': '19 个科别',
  'feat.spec.p': '心脏、肿瘤、产科、精神科、药房、麻醉等等，每一科都有自己的说法和容易搞混的地方：胰岛素的「单位」和「毫升」、眼药水滴哪只眼睛、这个治疗是为了治好还是为了让人舒服些。',
  'feat.mishear.h': '麦克风听岔了会修回来',
  'feat.mishear.p': '医生说的是 Lasix，语音识别写成 <code>lay six</code>。它知道这次是哪一科，会把真正的词补回去。但数字从来不这样「改」，因为数字没有别的线索可以对。',
  'feat.uncert.h': '「可能」还是「可能」',
  'feat.uncert.p': '「可能是」、「我们觉得」、「还要再排除一下」，译过来还是没把握的语气；医生说得肯定的，译过来也还是肯定。您点头答应的时候，靠的就是这点区别。',
  'feat.langs.h': '25 种语言',
  'feat.langs.p': '西班牙语、普通话、香港粤语、越南语、他加禄语、韩语、阿拉伯语、海地克里奥尔语、索马里语等等，都是按诊所里真正的说法来，不是书面语。',
  'feat.disfl.h': '嗯嗯啊啊去掉，意思留着',
  'feat.disfl.p': '话说了一半又重来的、结巴的，都清掉；有人说错又改口，留下的是他最后确定的意思。清理的时候不碰任何数字、药名、「不」字和身体部位。',
  'feat.privacy.h': '我们这边什么都不留',
  'feat.privacy.p': '录音和记录我们都不保存。它只存在您的浏览器里，直到您自己清掉或者存下来。我们保存的只有您的邮箱，和您有没有订阅。',

  'pricing.h2': '偶尔看一次病，免费就够',
  'pricing.lede': '两个套餐是同一个翻译，语言、科别、所有安全规则都一样。差别只在能说多少。',
  'plan.free.tag': '大家都从这里开始',
  'plan.free.name': '免费',
  'plan.free.price': '$0',
  'plan.free.per': ' / 一直免费',
  'plan.free.sub': '不用信用卡，也没有试用倒计时。注册就是这个套餐。',
  'plan.free.f1': '每周 <strong>{words}</strong> 个词',
  'plan.free.f2': '每周免费额度按<strong>滚动</strong>的七天计算',
  'plan.free.f3': '25 种语言、19 个科别全都能用',
  'plan.free.f4': '所有安全规则、数字核对、麦克风听岔的修正',
  'plan.free.f5': '朗读，以及把就诊记录带走',
  'plan.free.cta': '注册免费账号',
  'plan.free.foot': '您说的和医生说的都算在每周的词数里。',
  'plan.pro.tag': '经常跑医院的话',
  'plan.pro.name': '不限量',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / 月',
  'plan.pro.sub': '通过 Stripe 每月扣 20 美元，随时可以取消。',
  'plan.pro.f1': '词数<strong>不限</strong>，没有每周上限',
  'plan.pro.f2': '免费套餐里的功能原样都有',
  'plan.pro.f3': '在急诊耗一整晚也不用盯着计数',
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
  'faq.a1': '真正说出口的话，两边都算。译文不另外算：一句话不管译成中文是三个字还是三十个字，花的都一样，点开听也不花。中文、日文这种词与词之间不空格的语言，按字数算。',
  'faq.q9': '免费的一周大概够用多久？',
  'faq.a9': '人说话大概一分钟 130 到 150 个词，而且两边都算，所以 {words} 个词够一次短的门诊：问诊和医嘱的部分，寒暄不算在内。要是看到一半用完了，应用会提示您，额度会在接下来一周里慢慢还回来。',
  'faq.q2': '「滚动」的一周是什么意思？',
  'faq.a2': '从现在往回数七天，不是到某一天清零。周一那次门诊用掉的词，下周一就不再计入，额度是一点一点还回来的，不用守着某个时间点等清零。',
  'faq.q3': '医院的口译员还要不要叫？',
  'faq.a3': '要，而且这两个不冲突。在美国，接受联邦经费的医院和诊所必须免费给您提供专业口译员，电话或者到场都行。签字之前一定要叫，知情同意、检查结果、坏消息也一样。这个应用是机器翻译，没有人在您看到之前先审一遍，所以拿它跟上医生在讲什么、事先想好要问什么、把记录留下来。',
  'faq.q4': '录音和记录会怎么处理？',
  'faq.a4': '声音会送到这个部署配置的语音识别和翻译服务，再把文字传回来。这台服务器不保存录音，也不保存记录：这次看病的内容留在您的浏览器里，直到您清掉或者存下来。您账号里存的是邮箱、有没有订阅，以及每次说话用掉多少词。',
  'faq.q5': '怎么登录？',
  'faq.a5': '用邮箱。我们发一个链接，您一点就进去了。不用设密码，也不用记密码；第一次用这个链接会顺便帮您把账号建好，每个链接只能用一次。',
  'faq.q6': '想取消随时能取消吗？',
  'faq.a6': '可以。订阅在 Stripe 的账单页面管理，从应用里就能进去，取消不用跟任何人打招呼。取消之后账号回到免费套餐，不会被删掉。',
  'faq.q7': '在候诊室用手机能用吗？',
  'faq.a7': '能。浏览器里就能跑，不用装东西，看病过程中屏幕也不会自己黑掉。第一次浏览器会问您要不要开麦克风，而且只有在 https 的安全地址下才给开。',

  'cta.h2': '下次看病带上它',
  'cta.p': '有个邮箱就行，一分钟不到就弄好了。',
  'foot.disclaimer': '这是机器翻译，帮您跟上看病时说的话，不是有资质的医疗口译，您看到之前也没有人审过。诊所或医院要是提供专业翻译，请一定用；这里有哪句跟您理解的对不上，回头再问一遍。',

  'nav.record': '带走的记录',
  'record.h2': '医生说过的话，回到家还在',
  'record.lede': '吃多少、什么时候回来复诊、出现什么情况要马上打电话，这些多半是在最后五分钟说的，那时候您已经在收东西准备走了。两个人说的每一句都当场记下来，中英文都有，旁边还有时间。在药房、在家里，想看几遍就看几遍。',
  'record.1.h': '中英文并排',
  'record.1.p': '医生的原话和中文意思都留着。过后要是觉得药量不对，可以回去看当时怎么说的，不用凭记忆。',
  'record.2.h': '第二天还在',
  'record.2.p': '关掉网页，这次看病的记录还留在浏览器里，也可以存成文件，打印、发邮件，或者到药房柜台直接给人看。',
  'record.3.h': '给没能一起来的家人',
  'record.3.p': '帮着分药的女儿、开车送下次复诊的儿子，可以看到医生原原本本说了什么，是中文的，不是在门口听来的一句转述。',
  'record.sheet': '就诊记录-2026-08-23.txt',
  'record.r1.said': 'Take one tablet twice a day, and stop the other one.',
  'record.r1.rendered': '一次一片，一天两次；另外那种停掉。',
  'record.r2.said': '吃了会不会头晕？',
  'record.r2.rendered': 'Will it make me dizzy?',
  'record.r3.said': 'It can at first. Come back in two weeks.',
  'record.r3.rendered': '刚开始可能会。两个星期后回来复诊。',
  'faq.q8': '记录能带回家吗？',
  'faq.a8': '本来就是为这个做的。存下来之后，每一句话都写进一个文本文件里，中英文都有，还带时间：谁说的、说了什么、什么意思。这次看病的内容也会留在浏览器里，直到您清掉，所以走之前还能再看一遍。这些都不用往服务器上传。',

  'login.title': '登录 · 医疗翻译',
  'login.lede': '用中文跟上看病时说的每一句话，之后还能留一份记录。写下邮箱，我们发一个登录链接给您，不用设密码，也不用记密码。',
  'login.email': '邮箱地址',
  'login.placeholder': 'you@example.com',
  'login.submit': '发送登录链接到邮箱',
  'login.sending': '发送中…',
  'login.foot': '第一次来？同一个链接就帮您注册。免费账号每周有 <strong>{words}</strong> 个词，按月订阅可以去掉这个限制。',
  'login.sent': '请查收 {email} 的登录链接，{minutes} 分钟内有效。',
  'login.devlink': '未配置邮件服务，登录链接在此：<a href="{link}">登录</a>',
  'login.expired': '该登录链接已过期或已被使用，请重新获取。',

  'app.title': '医疗翻译',
  'app.setup': '就诊设置',
  'app.specialty': '科室',
  'app.specialty.hint': '同时针对该科室优化语音识别与翻译',
  'app.clinicianSpeaks': '医护使用',
  'app.patientSpeaks': '患者使用',
  'app.swap': '交换两种语言',
  'app.roleHint': '说话方根据每句话的语言自动判断 — 如需更正，请点击消息上的「医护 / 患者」按钮。',
  'app.export': '导出',
  'app.clear': '清空',
  'app.empty': '选择科室与两种语言，然后按<strong>开始聆听</strong>。<br>每句话都会被转写、归属到医护或患者，并翻译成另一种语言。',

  'app.mic.start': '开始聆听',
  'app.mic.stop': '停止聆听',
  'app.meter': '麦克风音量',
  'app.status.idle': '待机',
  'app.status.listening': '聆听中',
  'app.status.speaking': '说话中…',
  'app.status.error': '错误',
  'app.status.loading': '正在加载语音检测模型…',
  'app.err.mic': '麦克风错误：{message}',
  'app.err.https': '使用麦克风需要 HTTPS。请通过 https:// 地址（例如 Cloudflare 隧道）或 localhost 打开本页面。',
  'app.err.nomic': '该浏览器不提供麦克风接口。如果你是在其他应用（聊天应用、扫码工具）内或隐私浏览器中打开的链接，请改用 Chrome 直接打开。',

  'app.turn.transcribing': '转写中…',
  'app.turn.spoken': '原话',
  'app.turn.asSpoken': '{lang} · 原话',
  'app.turn.interpreted': '{lang} · 翻译',
  'app.turn.failed': '转写失败：{message}',
  'app.turn.whoSpoke': '这句话由谁说出',
  'app.turn.isSpeaker': '本句的说话方',
  'app.turn.reassign': '改为该说话方并重新翻译',
  'app.turn.substituted': '⚠ 识别结果为{detected}，已按{used}处理',
  'app.turn.deviation': '⚠ 听起来像{detected}，预期为{expected}',
  'app.turn.sameLang': '双方都在使用{lang} — 无需翻译。',
  'app.turn.readAloud': '朗读',
  'app.numbers': '请核对数字：<b>{missing}</b> 出现在原话中，但未出现在译文里。部分语言会用文字书写数字，执行前请先确认。',
  'app.export.empty': '暂无可导出的内容',

  'export.title': '就诊记录',
  'export.date': '日期：',
  'export.specialty': '科室：',
  'export.languages': '语言：',
  'export.turns': '条目：',
  'export.disclaimer': '这是就诊过程中所说内容的机器翻译记录。它未经任何人复核，也不能取代有资质的医疗口译员。如果其中有不清楚的地方，或与你记得的内容不符，请在照做之前先向诊所确认。',
  'export.into': '翻译成{lang}：',
  'export.sameLang': '（双方使用的是同一种语言 — 未进行翻译）',

  'app.plan.free': '免费方案',
  'app.plan.pro': '不限量',
  'app.quota.left': '本周剩余 {remaining} / {limit} 词',
  'app.quota.hint': '滚动七天窗口：每个词在说出七天后不再计入。',
  'app.quota.resets': ' 部分额度将于 {when} 恢复。',
  'app.quota.spent': '<strong>本周免费额度已用完。</strong>翻译暂停，需等待滚动窗口释放额度。{when}',
  'app.quota.reached': '已达每周词数上限',
  'app.upgrade': '订阅解除限制',
  'app.manage': '管理订阅',
  'app.logout': '退出登录',
  'app.err.billing': '账单：{message}',
  'app.err.tts': '语音合成：{message}',
  'app.err.config': '配置加载失败：{message}',
};

/* Traditional Chinese, written with Hong Kong medical vocabulary — the same
 * register the app's Cantonese interpreting uses (覆診, 食藥, 照X光). */
STRINGS.yue = {
  'brand': '醫療翻譯',
  'lang.label': '介面語言',
  'common.clinician': '醫護',
  'common.patient': '病人',

  'home.title': '醫療翻譯：聽得明醫生講嘅嘢，成次應診記錄帶得走',
  'nav.how': '點樣用',
  'nav.features': '唔會譯漏嘅位',
  'nav.pricing': '收費',
  'nav.faq': '常見問題',
  'nav.signin': '登入',
  'nav.start': '免費開始',
  'nav.open': '打開翻譯',

  'hero.eyebrow': '🎙️ 手機放喺枱面，照平時噉講就得',
  'hero.h1': '聽得明醫生講咗乜，<span class="hl">成份記錄帶返屋企</span>。',
  'hero.lede': '醫生講英文，你講廣東話，幾分鐘嘅應診一陣間就過咗。將手機放喺兩個人中間，每句話講完一兩秒就變成中文出咗嚟，藥量、日期、要注意嘅嘢全部照原話保留。行出診症室嗰陣，成段對話跟住你走。',
  'hero.seehow': '睇下點樣用',
  'hero.note': '新開嘅戶口免費：每星期 <strong>{words}</strong> 個字，唔使信用卡。',
  'shot.bar': '收緊音 · 心臟科 · 英文 ↔ 廣東話',
  'shot.who.doctor': '醫生',
  'shot.who.you': '你',
  'shot.dir.cp': '英文 → 廣東話',
  'shot.dir.pc': '廣東話 → 英文',
  'shot.said1': 'Start Lasix, 40 milligrams every morning, and stop the fluid pills you were taking.',
  'shot.rendered1': '開始食 Lasix，每朝食 40 毫克，之前嗰隻去水丸就停咗佢。',
  'shot.said2': '我由星期四就冇食過，因為食完頭暈。',
  'shot.rendered2': 'I haven’t taken any since Thursday because it made me dizzy.',
  'shot.flag': '醫生講嘅每個數字都會同譯文對一次。',

  'how.h2': '喺診症室入面，三步',
  'how.lede': '唔使裝任何嘢，亦唔使打電話搵人。用手機上面個瀏覽器就用得。',
  'how.1.h': '揀兩種語言',
  'how.1.p': '揀你講嘅語言同醫生講嘅語言，再揀今次睇邊科：心臟、懷孕、腫瘤、精神科。噉樣嗰科嘅專門講法先至唔會譯歪。',
  'how.2.h': '照平時噉講嘢',
  'how.2.p': '佢自己聽得出邊個開始講、邊個講完，唔使一路撳住個掣，房入面冇人講嘢嗰陣亦唔會傳出去。同醫生講一聲你用緊翻譯，將手機放喺兩個人都聽到嘅位。',
  'how.3.h': '睇得到、聽得到、留得低',
  'how.3.p': '每句話講完一兩秒就用中文出嚟，亦可以㩒嚟聽。等你走嗰陣，成次應診已經記晒低，存咗喺手機度。',

  'feat.h2': '睇醫生最容易譯漏嘅嘢',
  'feat.lede': '普通翻譯 app 想句子順口。呢度要嘅係唔加、唔漏、唔打折，就算譯到有啲生硬都要。',
  'feat.doses.h': '藥量一個字都唔改得',
  'feat.doses.p': '數字、單位、一日幾次、食幾耐，全部照原話出。唔會四捨五入，唔會換做第二種單位，亦唔會變成「幾粒」。如果譯文入面少咗個數字，會標出嚟，等你再問多次。',
  'feat.neg.h': '「唔好」唔會變成「要」',
  'feat.neg.p': '「冇發燒」、「唔敏感」、「從來冇食過煙」、「唔好同飯一齊食」。個「唔」字唔會譯譯下唔見咗，亦唔會無端端多咗個出嚟。',
  'feat.side.h': '左邊就係左邊',
  'feat.side.p': '邊一邊、邊隻手、邊隻眼，照原話譯，唔會為咗句子順啲就慳咗佢。',
  'feat.spec.h': '19 個科',
  'feat.spec.p': '心臟、腫瘤、產科、精神科、藥房、麻醉等等，每科有自己嘅講法同容易搞亂嘅位：胰島素嘅「單位」同「毫升」、眼藥水滴邊隻眼、個治療係為醫好定係為舒服啲。',
  'feat.mishear.h': '咪高峰聽錯會執返正',
  'feat.mishear.p': '醫生講嘅係 Lasix，語音辨識寫咗做 <code>lay six</code>。佢知今次係邊科，會將正確嘅字補返。但數字就從來唔會噉「執」，因為數字冇嘢可以對得返。',
  'feat.uncert.h': '「可能」照舊係「可能」',
  'feat.uncert.p': '「可能係」、「我哋估計」、「仲要再排除下」，譯過嚟一樣係唔肯定嘅語氣；醫生講得實嘅，譯過嚟一樣咁實。你點頭應承嗰陣，靠嘅就係呢個分別。',
  'feat.langs.h': '25 種語言',
  'feat.langs.p': '西班牙文、普通話、香港廣東話、越南文、他加祿文、韓文、阿拉伯文、海地克里奧爾文、索馬里文等等，全部照診所入面真正嘅講法，唔係書面嗰套。',
  'feat.disfl.h': '「嗯」「呃」剪走，意思照留',
  'feat.disfl.p': '講到一半又重新嚟過、口窒窒嗰啲會清走；有人講錯咗改口，留低嘅係佢最後定咗嗰個意思。清嘅時候唔會掂任何數字、藥名、「唔」字同身體部位。',
  'feat.privacy.h': '我哋呢邊乜都唔留',
  'feat.privacy.p': '錄音同記錄我哋都唔會存。淨係留喺你個瀏覽器度，直到你自己清走或者存低。我哋存嘅得你個電郵，同埋你有冇訂閱。',

  'pricing.h2': '間唔中睇一次醫生，免費夠晒',
  'pricing.lede': '兩個計劃都係同一個翻譯，語言、科別、所有安全規則一樣。分別淨係喺講得幾多。',
  'plan.free.tag': '個個都由呢度開始',
  'plan.free.name': '免費',
  'plan.free.price': '$0',
  'plan.free.per': ' / 一直免費',
  'plan.free.sub': '唔使信用卡，亦冇試用倒數。開咗戶口就係呢個計劃。',
  'plan.free.f1': '每星期 <strong>{words}</strong> 個字',
  'plan.free.f2': '每星期嘅免費額度以<strong>滾動</strong>七日計',
  'plan.free.f3': '25 種語言、19 個科全部用得',
  'plan.free.f4': '所有安全規則、數字核對、咪高峰聽錯嘅修正',
  'plan.free.f5': '朗讀，同埋將應診記錄帶走',
  'plan.free.cta': '開個免費戶口',
  'plan.free.foot': '你講嘅同醫生講嘅，都計入每星期嘅字數。',
  'plan.pro.tag': '成日要覆診嘅話',
  'plan.pro.name': '無限',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / 月',
  'plan.pro.sub': '經 Stripe 每月扣 20 美元，隨時可以取消。',
  'plan.pro.f1': '字數<strong>無限</strong>，冇每星期上限',
  'plan.pro.f2': '免費計劃嗰啲，原封不動全部有',
  'plan.pro.f3': '喺急症室捱通宵都唔使盯住個數',
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
  'faq.a1': '真係講出口嘅嘢，兩邊都計。譯文唔另計：一句話唔理譯成中文係三個字定三十個字，收費一樣，㩒嚟聽都唔使錢。中文、日文呢啲字與字之間唔空格嘅語言，按字數計。',
  'faq.q9': '免費嗰個星期大概夠用幾耐？',
  'faq.a9': '人講嘢大概一分鐘 130 至 150 個字，而且兩邊都計，所以 {words} 個字夠一次短嘅門診：問診同醫囑嗰部分，傾閒偈唔計。如果睇到一半用完咗，app 會話你知，額度會喺跟住嗰個星期慢慢還返。',
  'faq.q2': '「滾動」嘅一個星期即係點？',
  'faq.a2': '由而家數返轉頭七日，唔係邊一日清零。星期一嗰次門診用咗嘅字，下個星期一就唔再計，額度係一啲一啲還返嚟。唔使守住邊個鐘數等清零。',
  'faq.q3': '醫院嗰個傳譯員仲使唔使叫？',
  'faq.a3': '使，而且兩樣嘢唔衝突。喺美國，收聯邦資助嘅醫院同診所必須免費提供專業傳譯員，電話或者到場都得。簽任何嘢之前一定要叫，知情同意、檢查結果、壞消息一樣。呢個 app 係機器翻譯，冇人喺你睇之前審過，所以用嚟跟得上醫生講緊乜、事前諗定要問咩、同埋留低份記錄。',
  'faq.q4': '錄音同記錄會點處理？',
  'faq.a4': '把聲會送去呢個部署設定嘅語音辨識同翻譯服務，再將文字傳返嚟。呢部伺服器唔會存錄音，亦唔會存記錄：今次應診嘅內容留喺你個瀏覽器，直到你清走或者存低。你戶口入面存嘅係電郵、有冇訂閱，同埋每次講嘢用咗幾多個字。',
  'faq.q5': '點樣登入？',
  'faq.a5': '用電郵。我哋寄個連結畀你，㩒一下就入到。唔使諗密碼，亦唔使記密碼；第一次用呢個連結會順手幫你開埋戶口，每個連結淨係用得一次。',
  'faq.q6': '想取消隨時取消得？',
  'faq.a6': '得。訂閱喺 Stripe 嘅帳單頁面管理，喺 app 入面就入到，取消唔使同任何人講。取消之後戶口返去免費計劃，唔會冇咗。',
  'faq.q7': '喺候診室用手機用唔用得？',
  'faq.a7': '用得。喺瀏覽器就跑到，唔使裝嘢，應診期間個螢幕亦唔會自己熄。第一次瀏覽器會問你畀唔畀開咪高峰，而且淨係喺 https 嘅安全網址先開得。',

  'cta.h2': '下次睇醫生帶埋佢',
  'cta.p': '有個電郵就得，一分鐘唔使就搞掂。',
  'foot.disclaimer': '呢個係機器翻譯，幫你跟得上睇醫生嗰陣講嘅嘢，唔係有資格嘅醫療傳譯，你睇之前亦冇人審過。診所或者醫院如果有專業傳譯員，請一定要用；呢度有邊句同你理解嘅唔對，返轉頭再問清楚。',

  'nav.record': '帶得走嘅記錄',
  'record.h2': '醫生講過嘅嘢，返到屋企一樣仲喺度',
  'record.lede': '食幾多、幾時覆診、出咗咩情況要即刻打電話，呢啲多數係最後五分鐘先講，嗰陣你已經執緊嘢準備走。兩個人講嘅每一句都即場記低，中英文都有，隔籬仲有時間。喺藥房、喺屋企，想睇幾多次都得。',
  'record.1.h': '中英文並排',
  'record.1.p': '醫生嘅原話同中文意思都留住。之後如果覺得個藥量唔對路，可以返去睇返當時點講，唔使靠記憶。',
  'record.2.h': '第二日一樣仲喺度',
  'record.2.p': '熄咗個網頁，記錄一樣留喺瀏覽器度，亦可以存做檔案，打印、電郵，或者喺藥房櫃檯直接畀人睇。',
  'record.3.h': '畀嗰啲嚟唔到嘅家人',
  'record.3.p': '幫手分藥嘅女、揸車送你去覆診嘅仔，可以睇到醫生原原本本講咗乜，係中文嘅，唔係喺門口聽返嚟嗰句轉述。',
  'record.sheet': '應診記錄-2026-08-23.txt',
  'record.r1.said': 'Take one tablet twice a day, and stop the other one.',
  'record.r1.rendered': '一次一粒，一日兩次；另外嗰隻停咗佢。',
  'record.r2.said': '食完會唔會頭暈？',
  'record.r2.rendered': 'Will it make me dizzy?',
  'record.r3.said': 'It can at first. Come back in two weeks.',
  'record.r3.rendered': '頭幾日可能會。兩個星期後返嚟覆診。',
  'faq.q8': '份記錄帶得返屋企？',
  'faq.a8': '本來就係為咗噉。存低之後，每一句都寫入一個文字檔，中英文都有，仲有時間：邊個講、講咗乜、係咩意思。今次應診嘅內容亦會留喺瀏覽器，直到你清走，所以走之前仲可以再睇一次。呢啲全部唔使上傳去伺服器。',

  'login.title': '登入 · 醫療翻譯',
  'login.lede': '用中文跟得上睇醫生嗰陣講嘅每一句，之後仲可以留低份記錄。寫低你個電郵，我哋寄個登入連結畀你，唔使諗密碼，亦唔使記密碼。',
  'login.email': '電郵地址',
  'login.placeholder': 'you@example.com',
  'login.submit': '寄登入連結俾我',
  'login.sending': '寄緊…',
  'login.foot': '第一次嚟？同一個連結就幫你開埋戶口。免費戶口每星期有 <strong>{words}</strong> 個字，月費訂閱就冇呢個限制。',
  'login.sent': '請查收 {email} 嘅登入連結，{minutes} 分鐘內有效。',
  'login.devlink': '未設定郵件服務，登入連結喺呢度：<a href="{link}">登入</a>',
  'login.expired': '呢條登入連結已經過期或者用咗，請重新攞一條。',

  'app.title': '醫療翻譯',
  'app.setup': '應診設定',
  'app.specialty': '專科',
  'app.specialty.hint': '同時針對呢個專科優化語音識別同翻譯',
  'app.clinicianSpeaks': '醫護講',
  'app.patientSpeaks': '病人講',
  'app.swap': '對調兩種語言',
  'app.roleHint': '講嘢嗰方會根據每句話嘅語言自動判斷 — 要更正就㩒訊息上面嘅「醫護 / 病人」掣。',
  'app.export': '匯出',
  'app.clear': '清除',
  'app.empty': '揀好專科同兩種語言，然後㩒<strong>開始聆聽</strong>。<br>每句話都會被轉寫、歸到醫護定病人，再翻譯成另一種語言。',

  'app.mic.start': '開始聆聽',
  'app.mic.stop': '停止聆聽',
  'app.meter': '麥克風音量',
  'app.status.idle': '待機',
  'app.status.listening': '聆聽中',
  'app.status.speaking': '講緊嘢…',
  'app.status.error': '錯誤',
  'app.status.loading': '載入緊語音偵測模型…',
  'app.err.mic': '麥克風錯誤：{message}',
  'app.err.https': '用麥克風需要 HTTPS。請經 https:// 網址（例如 Cloudflare 隧道）或者 localhost 開呢一頁。',
  'app.err.nomic': '呢個瀏覽器冇提供麥克風介面。如果你係喺其他應用程式（通訊軟件、掃碼工具）入面或者私隱瀏覽器開條連結，請改用 Chrome 直接開。',

  'app.turn.transcribing': '轉寫緊…',
  'app.turn.spoken': '原話',
  'app.turn.asSpoken': '{lang} · 原話',
  'app.turn.interpreted': '{lang} · 翻譯',
  'app.turn.failed': '轉寫失敗：{message}',
  'app.turn.whoSpoke': '呢句話邊個講',
  'app.turn.isSpeaker': '本句嘅講者',
  'app.turn.reassign': '改為呢一方並重新翻譯',
  'app.turn.substituted': '⚠ 識別結果係{detected}，已當作{used}處理',
  'app.turn.deviation': '⚠ 聽落似{detected}，預期係{expected}',
  'app.turn.sameLang': '雙方都係講{lang} — 唔使翻譯。',
  'app.turn.readAloud': '朗讀',
  'app.numbers': '請核對數字：<b>{missing}</b> 喺原話出現過，但譯文入面冇。有啲語言會用文字寫數字，執行之前請先確認。',
  'app.export.empty': '暫時冇嘢可以匯出',

  'export.title': '應診紀錄',
  'export.date': '日期：',
  'export.specialty': '專科：',
  'export.languages': '語言：',
  'export.turns': '條目：',
  'export.disclaimer': '呢份係應診期間所講內容嘅機器翻譯紀錄。佢未經任何人覆核，亦唔可以取代有資格嘅醫療傳譯員。如果有邊度睇唔明，或者同你記得嘅唔一樣，照做之前請先問返診所。',
  'export.into': '翻譯成{lang}：',
  'export.sameLang': '（雙方講緊同一種語言 — 冇做翻譯）',

  'app.plan.free': '免費方案',
  'app.plan.pro': '無限字數',
  'app.quota.left': '今個星期仲有 {remaining} / {limit} 字',
  'app.quota.hint': '滾動七日視窗：每個字喺講出七日之後就唔再計。',
  'app.quota.resets': ' 部分額度會喺 {when} 回復。',
  'app.quota.spent': '<strong>今個星期嘅免費額度用晒喇。</strong>翻譯暫停，要等滾動視窗釋放額度。{when}',
  'app.quota.reached': '已達每星期字數上限',
  'app.upgrade': '訂閱解除限制',
  'app.manage': '管理訂閱',
  'app.logout': '登出',
  'app.err.billing': '帳單：{message}',
  'app.err.tts': '語音合成：{message}',
  'app.err.config': '設定載入失敗：{message}',
};

STRINGS.es = {
  'brand': 'Traductor Médico',
  'lang.label': 'Idioma',
  'common.clinician': 'Personal clínico',
  'common.patient': 'Paciente',

  'home.title': 'Traductor médico: entienda a su doctor y llévese lo que le dijeron',
  'nav.how': 'Cómo funciona',
  'nav.features': 'Precisión',
  'nav.pricing': 'Precios',
  'nav.faq': 'Preguntas',
  'nav.signin': 'Entrar',
  'nav.start': 'Empiece gratis',
  'nav.open': 'Abrir el traductor',

  'hero.eyebrow': '🎙️ Ponga el teléfono sobre la mesa y hable',
  'hero.h1': 'Entienda lo que dijo el doctor. <span class="hl">Llévese la visita por escrito.</span>',
  'hero.lede': 'El doctor habla inglés, usted habla español y la cita se le va volando. Ponga el teléfono entre los dos y cada frase aparece en español un segundo después de dicha, con las dosis, las fechas y las advertencias tal como se dijeron. Cuando salga, se lleva toda la conversación.',
  'hero.seehow': 'Vea cómo funciona',
  'hero.note': 'Las cuentas nuevas son gratis: <strong>{words}</strong> palabras por semana, sin tarjeta.',
  'shot.bar': 'Escuchando · Cardiología · inglés ↔ español',
  'shot.who.doctor': 'Doctor',
  'shot.who.you': 'Usted',
  'shot.dir.cp': 'inglés → español',
  'shot.dir.pc': 'español → inglés',
  'shot.said1': 'Start Lasix, 40 milligrams every morning, and stop the fluid pills you were taking.',
  'shot.rendered1': 'Empiece a tomar Lasix, 40 miligramos todas las mañanas, y deje las pastillas para el líquido que estaba tomando.',
  'shot.said2': 'No he tomado nada desde el jueves porque me daba mareos.',
  'shot.rendered2': 'I haven’t taken anything since Thursday because it was making me dizzy.',
  'shot.flag': 'Cada número que dice el doctor se compara con la traducción.',

  'how.h2': 'Tres pasos en el consultorio',
  'how.lede': 'No hay nada que instalar ni a quién llamar. Funciona en el navegador del teléfono que ya trae.',
  'how.1.h': 'Escoja los dos idiomas',
  'how.1.p': 'El suyo y el del doctor, y el tipo de visita: corazón, embarazo, cáncer, salud mental. Así salen bien las palabras propias de esa cita.',
  'how.2.h': 'Hable como habla siempre',
  'how.2.p': 'El teléfono nota solo cuándo empieza y cuándo termina de hablar cada quien, así que nadie tiene que apretar un botón y no se manda nada mientras el cuarto está en silencio. Avísele al doctor que lo está usando y ponga el teléfono donde se oigan los dos.',
  'how.3.h': 'Léalo, escúchelo, guárdelo',
  'how.3.p': 'Cada frase aparece en español uno o dos segundos después de dicha, y se puede escuchar en voz alta. Para cuando salga, la visita ya quedó escrita y guardada en su teléfono.',

  'feat.h2': 'Donde una visita médica se pierde en la traducción',
  'feat.lede': 'Una aplicación de traducción normal busca que la frase suene bonita. Aquí lo que importa es que no se agregue, no se quite y no se suavice nada, aunque quede seco.',
  'feat.doses.h': 'La dosis se respeta',
  'feat.doses.p': 'Los números, las unidades, cada cuánto y por cuánto tiempo pasan tal cual se dijeron. Nada se redondea, nada se cambia a otras unidades y nada se convierte en «unas cuantas». Si un número se pierde en la traducción, se le avisa para que vuelva a preguntar.',
  'feat.neg.h': 'El «no» no se vuelve «sí»',
  'feat.neg.p': '«No tiene fiebre», «no es alérgico», «nunca fumó», «no lo tome con comida». Un «no» no se puede perder al pasar al español, ni puede aparecer donde nadie lo dijo.',
  'feat.side.h': 'La izquierda sigue siendo la izquierda',
  'feat.side.p': 'Qué lado, qué brazo, qué ojo. Pasa tal como se dijo y nunca se quita para que la frase suene más natural.',
  'feat.spec.h': '19 tipos de visita',
  'feat.spec.p': 'Corazón, cáncer, embarazo, salud mental, farmacia, cirugía y más. Cada uno con su vocabulario y sus trampas: unidades contra mililitros de insulina, en qué ojo van las gotas, si un tratamiento es para curarlo o para que usted esté cómodo.',
  'feat.mishear.h': 'Arregla lo que el micrófono entendió mal',
  'feat.mishear.p': 'El doctor dice Lasix y el micrófono escribe <code>lay six</code>. Como sabe de qué tipo de visita se trata, repone la palabra verdadera. Con los números nunca hace eso, porque un número no tiene con qué comprobarse.',
  'feat.uncert.h': 'El «puede ser» sigue siendo «puede ser»',
  'feat.uncert.p': '«Podría ser», «creemos que», «hay que descartar» siguen siendo dudas, y lo que el doctor da por seguro sigue seguro. Esa diferencia es lo que usted acepta cuando dice que sí.',
  'feat.langs.h': '25 idiomas',
  'feat.langs.p': 'Español, mandarín, cantonés de Hong Kong, vietnamita, tagalo, coreano, árabe, criollo haitiano, somalí y más, escritos como se habla en una clínica y no como vienen en un libro.',
  'feat.disfl.h': 'Se quitan los tropiezos, no el sentido',
  'feat.disfl.p': 'Se limpian las frases empezadas a medias, y cuando alguien se corrige queda lo que quiso decir al final. En esa limpieza no se toca ningún número, nombre de medicina, «no» ni parte del cuerpo.',
  'feat.privacy.h': 'Aquí no se guarda nada',
  'feat.privacy.p': 'No guardamos ninguna grabación ni el texto de su visita. Se queda en su navegador hasta que usted lo borre o lo guarde. Lo que sí guardamos es su correo y si tiene suscripción.',

  'pricing.h2': 'Gratis para una cita de vez en cuando',
  'pricing.lede': 'Los dos planes son el mismo traductor, con todos los idiomas, todos los tipos de visita y todas las reglas de seguridad. Lo único que cambia es cuánto se puede hablar.',
  'plan.free.tag': 'Aquí empieza todo el mundo',
  'plan.free.name': 'Gratis',
  'plan.free.price': '$0',
  'plan.free.per': ' / para siempre',
  'plan.free.sub': 'Sin tarjeta y sin reloj de prueba. Al registrarse queda en este plan.',
  'plan.free.f1': '<strong>{words}</strong> palabras traducidas por semana',
  'plan.free.f2': 'Una ventana <strong>corrida</strong> de siete días para la cuota gratis semanal',
  'plan.free.f3': 'Los 25 idiomas y los 19 tipos de visita',
  'plan.free.f4': 'Todas las reglas de seguridad, la revisión de números y el arreglo del micrófono',
  'plan.free.f5': 'Escuchar en voz alta y llevarse la visita por escrito',
  'plan.free.cta': 'Crear una cuenta gratis',
  'plan.free.foot': 'Lo que dice usted y lo que dice el doctor cuentan para las palabras de la semana.',
  'plan.pro.tag': 'Para citas seguidas',
  'plan.pro.name': 'Sin límite',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / mes',
  'plan.pro.sub': 'Se cobran 20 dólares cada mes por Stripe. Puede cancelar cuando quiera.',
  'plan.pro.f1': 'Palabras <strong>sin límite</strong>, sin tope semanal',
  'plan.pro.f2': 'Todo lo del plan gratis, igual',
  'plan.pro.f3': 'Una noche larga en emergencias sin estar viendo el contador',
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
  'faq.a1': 'Las palabras que de verdad se dicen, de los dos lados. La traducción no cuesta: una frase cuesta igual si en el otro idioma salen tres palabras o treinta, y escucharla en voz alta no cuesta nada. El chino, el japonés y otros idiomas que se escriben sin espacios se cuentan por carácter.',
  'faq.q9': '¿Para cuánto alcanza una semana gratis?',
  'faq.a9': 'La gente habla unas 130 a 150 palabras por minuto y cuentan los dos lados, así que {words} palabras alcanzan para una cita corta: las preguntas y las indicaciones, no la plática. Si se le acaban a media visita, la aplicación se lo dice, y la cuota va regresando durante la semana siguiente.',
  'faq.q2': '¿Qué quiere decir semana «corrida»?',
  'faq.a2': 'Se cuenta desde este momento hacia atrás siete días, no se reinicia un día fijo. Las palabras que gastó en la cita del lunes dejan de contar el lunes siguiente, así que la cuota va regresando poco a poco. No hay una hora de reinicio que esperar.',
  'faq.q3': '¿De todos modos pido el intérprete del hospital?',
  'faq.a3': 'Sí, y no tiene que escoger entre uno y otro. En Estados Unidos, un hospital o una clínica que recibe fondos federales está obligado a darle un intérprete profesional, por teléfono o en persona, sin cobrarle. Pídalo antes de firmar cualquier cosa, y para consentimientos, resultados o malas noticias. Esta aplicación es una traducción automática que nadie revisa antes de que usted la lea: úsela para ir siguiendo la conversación, para preparar sus preguntas y para quedarse con el registro.',
  'faq.q4': '¿Qué pasa con el audio y con el texto?',
  'faq.a4': 'La voz se manda a los servicios de reconocimiento y traducción que tenga configurados esta instalación, y regresa el texto. Este servidor no guarda ni el audio ni el texto: la visita se queda en su navegador hasta que usted la borre o la guarde. De su cuenta guardamos el correo, si tiene suscripción y cuántas palabras gastó cada intervención.',
  'faq.q5': '¿Cómo entro?',
  'faq.a5': 'Con su correo. Le mandamos un enlace, usted lo toca y ya está adentro. No hay contraseña que escoger ni que olvidar, el mismo enlace le crea la cuenta la primera vez y cada enlace sirve una sola vez.',
  'faq.q6': '¿Puedo cancelar cuando quiera?',
  'faq.a6': 'Sí. Las suscripciones se manejan en el portal de Stripe, al que se entra desde la aplicación, y la cancelación se aplica sin tener que hablar con nadie. Su cuenta regresa al plan gratis en vez de desaparecer.',
  'faq.q7': '¿Funciona en el teléfono en la sala de espera?',
  'faq.a7': 'Sí. Funciona en el navegador, no hay nada que instalar, y la pantalla no se apaga mientras la visita está abierta. La primera vez el navegador le pide permiso para el micrófono, y solo lo da en una dirección segura (https).',

  'cta.h2': 'Llévelo a su próxima cita',
  'cta.p': 'Solo hace falta un correo y en menos de un minuto queda listo.',
  'foot.disclaimer': 'Esta es una traducción automática para ayudarle a seguir una visita médica. No es una interpretación médica certificada y nadie la revisa antes de que usted la lea. Si la clínica o el hospital le ofrecen un intérprete profesional, acéptelo, y vuelva a preguntar por cualquier cosa de aquí que no cuadre con lo que usted entendió.',

  'nav.record': 'El registro',
  'record.h2': 'Todo lo que se dijo, todavía ahí cuando llegue a casa',
  'record.lede': 'La dosis, la fecha para volver, la señal por la que hay que llamar: casi todo se dice en los últimos cinco minutos, cuando usted ya se está parando de la silla. Cada frase de los dos queda escrita al momento, en los dos idiomas y con la hora al lado. Léala otra vez en la farmacia, en casa, las veces que haga falta.',
  'record.1.h': 'Los dos idiomas, uno al lado del otro',
  'record.1.p': 'Le quedan las palabras del doctor y lo que significan en español. Si después una dosis no le cuadra, puede revisar lo que se dijo en vez de confiar en la memoria.',
  'record.2.h': 'Sigue ahí al día siguiente',
  'record.2.p': 'La visita se queda en el navegador aunque cierre la página, y se guarda como archivo para imprimir, mandar por correo o enseñar en la farmacia.',
  'record.3.h': 'Para la familia que no pudo ir',
  'record.3.p': 'La hija que le organiza las pastillas, el hijo que la lleva a la próxima cita: pueden leer exactamente lo que dijo el doctor, en español, en vez de un resumen contado en la puerta.',
  'record.sheet': 'visita-2026-08-23.txt',
  'record.r1.said': 'Take one tablet twice a day, and stop the other one.',
  'record.r1.rendered': 'Tome una pastilla dos veces al día, y la otra déjela.',
  'record.r2.said': '¿Me va a dar mareos?',
  'record.r2.rendered': 'Will it make me dizzy?',
  'record.r3.said': 'It can at first. Come back in two weeks.',
  'record.r3.rendered': 'Al principio puede. Vuelva en dos semanas.',
  'faq.q8': '¿Me puedo llevar el registro a la casa?',
  'faq.a8': 'Para eso es. Al guardar, cada intervención queda en un archivo de texto en los dos idiomas y con la hora: quién habló, qué dijo y qué significa. La visita también se queda en el navegador hasta que la borre, así que puede releerla antes de salir. Para eso no se sube nada a este servidor.',

  'login.title': 'Iniciar sesión · Traductor Médico',
  'login.lede': 'Siga en español lo que se dice en una visita médica y quédese con una copia. Escriba su correo y le mandamos un enlace para entrar, sin contraseña que escoger ni olvidar.',
  'login.email': 'Correo electrónico',
  'login.placeholder': 'usted@ejemplo.com',
  'login.submit': 'Enviarme un enlace de acceso',
  'login.sending': 'Enviando…',
  'login.foot': '¿Es nuevo? El mismo enlace lo registra. Las cuentas gratis incluyen <strong>{words}</strong> palabras traducidas por semana, y la suscripción mensual quita el límite.',
  'login.sent': 'Busque en {email} un enlace de acceso. Caduca en {minutes} minutos.',
  'login.devlink': 'No hay proveedor de correo configurado, así que aquí tiene su enlace: <a href="{link}">iniciar sesión</a>',
  'login.expired': 'Ese enlace de acceso ha caducado o ya se usó. Solicite uno nuevo.',

  'app.title': 'Traductor Médico',
  'app.setup': 'Configuración de la consulta',
  'app.specialty': 'Especialidad',
  'app.specialty.hint': 'Ajusta a este campo tanto el reconocimiento de voz como la traducción',
  'app.clinicianSpeaks': 'El personal clínico habla',
  'app.patientSpeaks': 'El paciente habla',
  'app.swap': 'Intercambiar los dos idiomas',
  'app.roleHint': 'Quién habla se deduce del idioma de cada intervención; use los botones Personal clínico/Paciente de un mensaje para corregirlo.',
  'app.export': 'Exportar',
  'app.clear': 'Borrar',
  'app.empty': 'Elija la especialidad y los dos idiomas y pulse <strong>Empezar a escuchar</strong>.<br>Cada intervención se transcribe, se atribuye al personal clínico o al paciente y se traduce al otro idioma.',

  'app.mic.start': 'Empezar a escuchar',
  'app.mic.stop': 'Dejar de escuchar',
  'app.meter': 'Nivel del micrófono',
  'app.status.idle': 'En espera',
  'app.status.listening': 'Escuchando',
  'app.status.speaking': 'Hablando…',
  'app.status.error': 'Error',
  'app.status.loading': 'Cargando el modelo de voz…',
  'app.err.mic': 'Error de micrófono: {message}',
  'app.err.https': 'el acceso al micrófono requiere HTTPS. Abra esta página con una dirección https:// (por ejemplo, un túnel de Cloudflare) o en localhost.',
  'app.err.nomic': 'este navegador no expone la API de micrófono. Si abrió el enlace dentro de otra aplicación (mensajería, lector de QR) o en un navegador de privacidad, ábralo directamente en Chrome.',

  'app.turn.transcribing': 'Transcribiendo…',
  'app.turn.spoken': 'Dicho',
  'app.turn.asSpoken': '{lang} · tal como se dijo',
  'app.turn.interpreted': '{lang} · traducido',
  'app.turn.failed': 'Fallo al transcribir: {message}',
  'app.turn.whoSpoke': 'Quién habló en esta intervención',
  'app.turn.isSpeaker': 'Quien habla en esta intervención',
  'app.turn.reassign': 'Reasignar esta intervención y volver a traducir',
  'app.turn.substituted': '⚠ el reconocedor dijo {detected}; tratado como {used}',
  'app.turn.deviation': '⚠ suena a {detected}, se esperaba {expected}',
  'app.turn.sameLang': 'Ambas partes hablan {lang}: no hay nada que traducir.',
  'app.turn.readAloud': 'Leer en voz alta',
  'app.numbers': 'Compruebe las cifras: <b>{missing}</b> aparecía en lo dicho pero no en la traducción. Algunos idiomas escriben las cifras con letras; confírmelo antes de actuar.',
  'app.export.empty': 'Todavía no hay nada que exportar',

  'export.title': 'REGISTRO DE SU CONSULTA',
  'export.date': 'Fecha:',
  'export.specialty': 'Servicio:',
  'export.languages': 'Idiomas:',
  'export.turns': 'Entradas:',
  'export.disclaimer': 'Esta es una traducción automática de lo que se dijo durante la consulta. Nadie la ha revisado y no sustituye a un intérprete médico cualificado. Si algo no queda claro, o no coincide con lo que usted recuerda, pregunte en la clínica antes de actuar.',
  'export.into': 'Traducido al {lang}:',
  'export.sameLang': '(ambas partes hablaban este idioma: no se tradujo nada)',

  'app.plan.free': 'Plan gratuito',
  'app.plan.pro': 'Ilimitado',
  'app.quota.left': 'Quedan {remaining} de {limit} palabras esta semana',
  'app.quota.hint': 'Ventana móvil de siete días: las palabras dejan de contar siete días después de decirse.',
  'app.quota.resets': ' Parte de la asignación vuelve el {when}.',
  'app.quota.spent': '<strong>La asignación gratuita de esta semana se ha agotado.</strong> La traducción queda en pausa hasta que la ventana móvil libere palabras. {when}',
  'app.quota.reached': 'Límite semanal de palabras alcanzado',
  'app.upgrade': 'Suscribirse para ilimitado',
  'app.manage': 'Gestionar la suscripción',
  'app.logout': 'Cerrar sesión',
  'app.err.billing': 'Facturación: {message}',
  'app.err.tts': 'Voz: {message}',
  'app.err.config': 'No se pudo cargar la configuración: {message}',
};

STRINGS.ko = {
  'brand': '의료 번역',
  'lang.label': '언어',
  'common.clinician': '의료진',
  'common.patient': '환자',

  'home.title': '의료 번역 — 의사가 한 말을 알아듣고, 기록으로 가져가세요',
  'nav.how': '사용 방법',
  'nav.features': '놓치지 않는 것',
  'nav.pricing': '요금',
  'nav.faq': '질문',
  'nav.signin': '로그인',
  'nav.start': '무료로 시작',
  'nav.open': '번역 열기',

  'hero.eyebrow': '🎙️ 휴대폰을 탁자에 올려놓고 평소처럼 말하세요',
  'hero.h1': '의사가 한 말을 알아듣고, <span class="hl">진료 내용을 그대로 가져가세요</span>.',
  'hero.lede': '의사는 영어로 말하고 나는 한국어로 말하는데, 진료는 순식간에 지나갑니다. 휴대폰을 두 사람 사이에 놓아두면 한 문장이 끝나고 1~2초 뒤에 한국어로 화면에 뜹니다. 약 용량, 날짜, 주의할 점은 말한 그대로 남습니다. 진료실을 나설 때 대화 전체가 함께 나옵니다.',
  'hero.seehow': '어떻게 쓰는지 보기',
  'hero.note': '새 계정은 무료입니다. 매주 <strong>{words}</strong>단어, 카드 등록 없이 씁니다.',
  'shot.bar': '듣는 중 · 심장내과 · 영어 ↔ 한국어',
  'shot.who.doctor': '의사',
  'shot.who.you': '나',
  'shot.dir.cp': '영어 → 한국어',
  'shot.dir.pc': '한국어 → 영어',
  'shot.said1': 'Start Lasix, 40 milligrams every morning, and stop the fluid pills you were taking.',
  'shot.rendered1': '라식스를 매일 아침 40밀리그램씩 드시고, 지금 드시던 이뇨제는 중단하세요.',
  'shot.said2': '목요일부터 안 먹었어요. 먹으면 어지러워서요.',
  'shot.rendered2': 'I haven’t taken it since Thursday because it made me dizzy.',
  'shot.flag': '의사가 말한 숫자는 모두 번역문과 대조합니다.',

  'how.h2': '진료실에서 세 단계',
  'how.lede': '설치할 것도, 전화를 걸 곳도 없습니다. 이미 들고 다니는 휴대폰의 브라우저에서 바로 열립니다.',
  'how.1.h': '두 언어를 고릅니다',
  'how.1.p': '내가 쓰는 언어와 의사가 쓰는 언어를 고르고, 오늘 진료 과목도 고릅니다. 심장, 임신, 암, 정신건강처럼 과목을 정해야 그 분야에서 쓰는 표현이 제대로 나옵니다.',
  'how.2.h': '평소처럼 말합니다',
  'how.2.p': '누가 말을 시작하고 끝냈는지 알아서 알아듣기 때문에 버튼을 누르고 있을 필요가 없고, 아무도 말하지 않을 때는 아무것도 전송되지 않습니다. 의사에게 통역 앱을 쓴다고 알려주고, 두 사람 목소리가 다 닿는 자리에 휴대폰을 두세요.',
  'how.3.h': '읽고, 듣고, 남깁니다',
  'how.3.p': '문장이 끝나고 1~2초 뒤에 한국어로 뜨고, 소리 내어 들을 수도 있습니다. 진료가 끝날 때쯤이면 오간 말이 전부 글로 남아 휴대폰에 저장됩니다.',

  'feat.h2': '진료에서 번역이 어긋나는 지점',
  'feat.lede': '일반 번역 앱은 문장이 매끄럽게 읽히도록 만듭니다. 여기서 중요한 것은 무엇도 더해지거나 빠지거나 부드러워지지 않는 것입니다. 결과가 다소 딱딱해지더라도 그렇습니다.',
  'feat.doses.h': '용량은 그대로',
  'feat.doses.p': '숫자, 단위, 하루 몇 번, 며칠 동안이 말한 그대로 전달됩니다. 반올림하지 않고, 다른 단위로 바꾸지 않고, ‘몇 알’처럼 뭉뚱그리지 않습니다. 번역문에서 숫자가 빠지면 표시해 주니 다시 물어보면 됩니다.',
  'feat.neg.h': '‘아니오’가 ‘예’로 바뀌지 않습니다',
  'feat.neg.p': '‘열은 없습니다’, ‘알레르기는 없습니다’, ‘담배는 피운 적 없습니다’, ‘식사와 함께 드시면 안 됩니다’. 부정이 한국어로 넘어오면서 사라지지 않고, 없던 부정이 생기지도 않습니다.',
  'feat.side.h': '왼쪽은 왼쪽으로',
  'feat.side.p': '어느 쪽인지, 어느 팔인지, 어느 눈인지가 말한 그대로 전달되고, 문장이 자연스러워지라고 빠지는 일은 없습니다.',
  'feat.spec.h': '19개 진료 과목',
  'feat.spec.p': '심장, 암, 산부인과, 정신건강, 약국, 마취 등 과목마다 쓰는 말과 헷갈리기 쉬운 지점이 다릅니다. 인슐린의 단위와 밀리리터, 안약을 어느 눈에 넣는지, 완치를 목표로 하는 치료인지 편하게 지내기 위한 치료인지 같은 것들입니다.',
  'feat.mishear.h': '마이크가 잘못 들은 것은 되돌립니다',
  'feat.mishear.p': '의사는 라식스라고 했는데 음성 인식은 <code>lay six</code>라고 적습니다. 어떤 과목의 진료인지 알기 때문에 원래 단어를 되살립니다. 숫자는 그렇게 고치지 않습니다. 숫자는 무엇과 대조할 근거가 없기 때문입니다.',
  'feat.uncert.h': '‘아마도’는 ‘아마도’로',
  'feat.uncert.p': '‘그럴 수도 있습니다’, ‘저희 생각에는’, ‘배제해 봐야 합니다’는 불확실한 채로 남고, 의사가 확실히 말한 것은 확실하게 남습니다. 동의한다고 말할 때 근거가 되는 것이 이 차이입니다.',
  'feat.langs.h': '25개 언어',
  'feat.langs.p': '스페인어, 중국어, 홍콩 광둥어, 베트남어, 타갈로그어, 한국어, 아랍어, 아이티 크레올어, 소말리어 등을 지원하고, 교과서 문장이 아니라 진료 현장에서 실제로 쓰는 말로 옮깁니다.',
  'feat.disfl.h': '군말은 빼고 뜻은 남기고',
  'feat.disfl.p': '말을 하다 만 부분이나 더듬은 부분은 정리하고, 스스로 고쳐 말했을 때는 마지막에 정한 내용이 남습니다. 정리하면서 숫자, 약 이름, 부정, 신체 부위는 건드리지 않습니다.',
  'feat.privacy.h': '저희 쪽에는 남지 않습니다',
  'feat.privacy.p': '녹음도 기록도 저장하지 않습니다. 진료 내용은 지우거나 저장할 때까지 브라우저에만 있습니다. 저희가 보관하는 것은 이메일 주소와 구독 여부입니다.',

  'pricing.h2': '가끔 병원에 간다면 무료로 충분합니다',
  'pricing.lede': '두 요금제 모두 같은 번역입니다. 언어도, 과목도, 안전 규칙도 같습니다. 차이는 얼마나 말할 수 있는지뿐입니다.',
  'plan.free.tag': '모두 여기서 시작합니다',
  'plan.free.name': '무료',
  'plan.free.price': '$0',
  'plan.free.per': ' / 계속 무료',
  'plan.free.sub': '카드도, 체험 기간 카운트다운도 없습니다. 가입하면 이 요금제입니다.',
  'plan.free.f1': '매주 <strong>{words}</strong>단어',
  'plan.free.f2': '주간 무료 한도는 <strong>롤링</strong> 7일 기준',
  'plan.free.f3': '25개 언어와 19개 진료 과목 전부',
  'plan.free.f4': '모든 안전 규칙, 숫자 대조, 마이크 오인식 보정',
  'plan.free.f5': '음성 읽기, 그리고 진료 기록 가져가기',
  'plan.free.cta': '무료 계정 만들기',
  'plan.free.foot': '내가 한 말과 의사가 한 말이 모두 주간 단어 수에 들어갑니다.',
  'plan.pro.tag': '자주 다닌다면',
  'plan.pro.name': '무제한',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / 월',
  'plan.pro.sub': 'Stripe로 매월 20달러가 결제되고, 언제든 해지할 수 있습니다.',
  'plan.pro.f1': '단어 <strong>무제한</strong>, 주간 상한 없음',
  'plan.pro.f2': '무료 요금제의 기능은 그대로',
  'plan.pro.f3': '응급실에서 밤을 새워도 남은 양을 신경 쓰지 않아도 됩니다',
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
  'faq.a1': '실제로 입 밖에 낸 말을 양쪽 다 셉니다. 번역문은 세지 않습니다. 한 문장이 다른 언어에서 세 단어가 되든 서른 단어가 되든 같고, 소리로 듣는 것도 무료입니다. 중국어나 일본어처럼 단어를 띄어 쓰지 않는 언어는 글자 수로 셉니다.',
  'faq.q9': '무료 한 주로 어느 정도 쓸 수 있나요?',
  'faq.a9': '사람은 보통 1분에 130~150단어를 말하고 양쪽이 모두 세어지므로, {words}단어면 짧은 외래 진료 한 번 분량입니다. 인사말이 아니라 묻고 답하고 설명을 듣는 부분이 그렇습니다. 진료 도중에 다 쓰면 앱이 알려주고, 다음 한 주 동안 조금씩 다시 채워집니다.',
  'faq.q2': '‘롤링’ 한 주가 무슨 뜻인가요?',
  'faq.a2': '정해진 날에 초기화되는 것이 아니라 지금부터 지난 7일을 거슬러 셉니다. 월요일 진료에서 쓴 단어는 다음 월요일에 빠지므로 사용량이 조금씩 돌아옵니다. 초기화 시간을 기다릴 일이 없습니다.',
  'faq.q3': '병원 통역사는 그래도 요청해야 하나요?',
  'faq.a3': '네, 그리고 둘 중 하나를 고를 필요가 없습니다. 미국에서 연방 지원을 받는 병원과 진료소는 전문 통역사를 전화나 대면으로 무료로 제공해야 합니다. 서류에 서명하기 전에는 반드시 요청하시고, 동의서, 검사 결과, 나쁜 소식일 때도 마찬가지입니다. 이 앱은 사람이 검토하지 않은 기계 번역이니 진행 상황을 따라가고, 물어볼 것을 미리 정리하고, 기록을 남기는 용도로 쓰세요.',
  'faq.q4': '녹음과 기록은 어떻게 되나요?',
  'faq.a4': '음성은 이 배포에 설정된 음성 인식·번역 서비스로 전송되고 텍스트가 돌아옵니다. 이 서버는 음성도 기록도 저장하지 않습니다. 진료 내용은 지우거나 저장할 때까지 브라우저에 남습니다. 계정에 남는 것은 이메일 주소, 구독 여부, 각 발언이 쓴 단어 수입니다.',
  'faq.q5': '로그인은 어떻게 하나요?',
  'faq.a5': '이메일 주소로 합니다. 링크를 보내드리면 눌러서 들어옵니다. 정하거나 잊어버릴 비밀번호가 없고, 처음 쓸 때는 같은 링크로 계정이 만들어지며 링크는 한 번만 작동합니다.',
  'faq.q6': '원할 때 해지할 수 있나요?',
  'faq.a6': '네. 구독은 앱에서 들어가는 Stripe 결제 포털에서 관리하고, 누구에게 연락하지 않아도 해지됩니다. 해지하면 계정이 사라지지 않고 무료 요금제로 돌아갑니다.',
  'faq.q7': '대기실에서 휴대폰으로도 되나요?',
  'faq.a7': '됩니다. 브라우저에서 바로 돌아가고 설치할 것이 없으며, 진료가 열려 있는 동안에는 화면이 꺼지지 않습니다. 처음에 브라우저가 마이크 권한을 묻고, https 주소에서만 허용됩니다.',

  'cta.h2': '다음 진료 때 가지고 가세요',
  'cta.p': '이메일 주소만 있으면 1분 안에 준비됩니다.',
  'foot.disclaimer': '이것은 진료 중 오가는 말을 따라갈 수 있게 돕는 기계 번역입니다. 공인 의료 통역이 아니며, 보시기 전에 사람이 검토하지 않습니다. 진료소나 병원에서 전문 통역사를 제공하면 이용하시고, 여기 적힌 내용이 이해한 것과 다르면 다시 물어보세요.',

  'nav.record': '남는 기록',
  'record.h2': '집에 돌아와서도 그대로 남아 있는 진료 내용',
  'record.lede': '용량, 다시 오는 날짜, 이런 증상이면 전화하라는 말. 대부분 마지막 5분에, 이미 자리에서 일어서는 중에 나옵니다. 두 사람이 한 말이 그 자리에서 두 언어로, 시간과 함께 기록됩니다. 약국에서도 집에서도 몇 번이든 다시 읽을 수 있습니다.',
  'record.1.h': '두 언어를 나란히',
  'record.1.p': '의사가 한 말과 그 한국어 뜻이 함께 남습니다. 나중에 용량이 이상해 보이면 기억이 아니라 그때 한 말을 확인하면 됩니다.',
  'record.2.h': '다음 날에도 남아 있습니다',
  'record.2.p': '페이지를 닫아도 브라우저에 그대로 남고, 파일로 저장해 인쇄하거나 메일로 보내거나 약국 창구에서 보여줄 수 있습니다.',
  'record.3.h': '같이 못 온 가족을 위해',
  'record.3.p': '약을 챙겨주는 딸, 다음 진료에 데려다주는 아들이 문 앞에서 전해 들은 요약이 아니라 의사가 한 말 그대로를 한국어로 읽을 수 있습니다.',
  'record.sheet': '진료기록-2026-08-23.txt',
  'record.r1.said': 'Take one tablet twice a day, and stop the other one.',
  'record.r1.rendered': '한 번에 한 알씩 하루 두 번 드시고, 다른 약은 중단하세요.',
  'record.r2.said': '먹으면 어지러울까요?',
  'record.r2.rendered': 'Will it make me dizzy?',
  'record.r3.said': 'It can at first. Come back in two weeks.',
  'record.r3.rendered': '처음에는 그럴 수 있습니다. 2주 뒤에 다시 오세요.',
  'faq.q8': '기록을 집에 가져갈 수 있나요?',
  'faq.a8': '그러라고 만든 기능입니다. 저장하면 모든 발언이 두 언어와 시각과 함께 텍스트 파일로 저장됩니다. 누가 말했는지, 무슨 말을 했는지, 무슨 뜻인지가 들어갑니다. 진료 내용은 지울 때까지 브라우저에도 남아 있어서 나가기 전에 다시 읽어볼 수 있습니다. 이 과정에서 서버로 올라가는 것은 없습니다.',

  'login.title': '로그인 · 의료 번역',
  'login.lede': '진료에서 오가는 말을 한국어로 따라가고, 끝난 뒤에는 기록을 보관하세요. 이메일 주소를 입력하시면 로그인 링크를 보내드립니다. 정하거나 잊어버릴 비밀번호는 없습니다.',
  'login.email': '이메일 주소',
  'login.placeholder': 'you@example.com',
  'login.submit': '로그인 링크 보내기',
  'login.sending': '보내는 중…',
  'login.foot': '처음이신가요? 같은 링크로 가입됩니다. 무료 계정은 매주 <strong>{words}</strong>단어를 쓸 수 있고, 월 구독을 하면 제한이 없어집니다.',
  'login.sent': '{email}에서 로그인 링크를 확인하세요. {minutes}분 후 만료됩니다.',
  'login.devlink': '메일 서비스가 설정되어 있지 않아 링크를 여기 드립니다: <a href="{link}">로그인</a>',
  'login.expired': '이 로그인 링크는 만료되었거나 이미 사용되었습니다. 새로 요청하세요.',

  'app.title': '의료 번역',
  'app.setup': '진료 설정',
  'app.specialty': '진료과',
  'app.specialty.hint': '음성 인식과 번역을 이 분야에 맞게 조정합니다',
  'app.clinicianSpeaks': '의료진 언어',
  'app.patientSpeaks': '환자 언어',
  'app.swap': '두 언어 바꾸기',
  'app.roleHint': '말한 사람은 각 발화의 언어로 판단합니다. 잘못되었으면 메시지의 「의료진 / 환자」 버튼으로 바로잡으세요.',
  'app.export': '내보내기',
  'app.clear': '지우기',
  'app.empty': '진료과와 두 언어를 고른 뒤 <strong>듣기 시작</strong>을 누르세요.<br>각 발화는 받아쓰기되어 의료진 또는 환자에게 귀속되고, 다른 언어로 번역됩니다.',

  'app.mic.start': '듣기 시작',
  'app.mic.stop': '듣기 중지',
  'app.meter': '마이크 입력 크기',
  'app.status.idle': '대기',
  'app.status.listening': '듣는 중',
  'app.status.speaking': '말하는 중…',
  'app.status.error': '오류',
  'app.status.loading': '음성 감지 모델 불러오는 중…',
  'app.err.mic': '마이크 오류: {message}',
  'app.err.https': '마이크 사용에는 HTTPS가 필요합니다. https:// 주소(예: Cloudflare 터널) 또는 localhost로 이 페이지를 여세요.',
  'app.err.nomic': '이 브라우저는 마이크 API를 제공하지 않습니다. 다른 앱(메신저, QR 스캐너)이나 프라이버시 브라우저에서 링크를 열었다면 Chrome에서 직접 여세요.',

  'app.turn.transcribing': '받아쓰는 중…',
  'app.turn.spoken': '말한 내용',
  'app.turn.asSpoken': '{lang} · 말한 그대로',
  'app.turn.interpreted': '{lang} · 번역',
  'app.turn.failed': '받아쓰기 실패: {message}',
  'app.turn.whoSpoke': '이 발화를 말한 사람',
  'app.turn.isSpeaker': '이 발화의 화자',
  'app.turn.reassign': '이 발화를 재지정하고 다시 번역',
  'app.turn.substituted': '⚠ 인식 결과는 {detected}였으나 {used}(으)로 처리했습니다',
  'app.turn.deviation': '⚠ {detected}처럼 들립니다. 예상 언어는 {expected}입니다',
  'app.turn.sameLang': '양쪽 모두 {lang}(으)로 말하고 있어 번역할 것이 없습니다.',
  'app.turn.readAloud': '소리 내어 읽기',
  'app.numbers': '숫자를 확인하세요: <b>{missing}</b>이(가) 말한 내용에는 있었지만 번역에는 없습니다. 숫자를 글자로 쓰는 언어도 있으니 실행 전에 확인하세요.',
  'app.export.empty': '아직 내보낼 내용이 없습니다',

  'export.title': '진료 기록',
  'export.date': '날짜:',
  'export.specialty': '진료과:',
  'export.languages': '언어:',
  'export.turns': '항목 수:',
  'export.disclaimer': '이 문서는 진료 중에 오간 말을 기계가 번역한 기록입니다. 사람이 검토하지 않았으며, 자격을 갖춘 의료 통역사를 대신하지 않습니다. 이해되지 않는 부분이 있거나 기억과 다르다면, 그대로 따르기 전에 진료소에 문의하십시오.',
  'export.into': '{lang}(으)로 번역:',
  'export.sameLang': '(양쪽 모두 이 언어로 말했습니다 — 번역하지 않았습니다)',

  'app.plan.free': '무료 요금제',
  'app.plan.pro': '무제한',
  'app.quota.left': '이번 주 {limit} 단어 중 {remaining} 단어 남음',
  'app.quota.hint': '슬라이딩 7일 기준: 말한 지 7일이 지난 단어는 더 이상 세지 않습니다.',
  'app.quota.resets': ' {when}에 일부 한도가 돌아옵니다.',
  'app.quota.spent': '<strong>이번 주 무료 한도를 모두 사용했습니다.</strong> 슬라이딩 기간이 한도를 돌려줄 때까지 번역이 중단됩니다. {when}',
  'app.quota.reached': '주간 단어 한도에 도달했습니다',
  'app.upgrade': '구독하고 무제한 사용',
  'app.manage': '구독 관리',
  'app.logout': '로그아웃',
  'app.err.billing': '결제: {message}',
  'app.err.tts': '음성 합성: {message}',
  'app.err.config': '설정을 불러오지 못했습니다: {message}',
};

STRINGS.ja = {
  'brand': '医療翻訳',
  'lang.label': '表示言語',
  'common.clinician': '医療者',
  'common.patient': '患者',

  'home.title': '医療翻訳 — 医師の説明がわかる、そのまま持ち帰れる',
  'nav.how': '使い方',
  'nav.features': '訳の正確さ',
  'nav.pricing': '料金',
  'nav.faq': 'よくある質問',
  'nav.signin': 'ログイン',
  'nav.start': '無料で始める',
  'nav.open': '翻訳を開く',

  'hero.eyebrow': '🎙️ スマホを机に置いて、いつも通り話すだけ',
  'hero.h1': '医師の説明がその場でわかる。<span class="hl">そのまま持ち帰れる。</span>',
  'hero.lede': '医師は英語、こちらは日本語、そして診察はあっという間に終わります。スマホを二人の間に置いておくと、一文話し終えて1〜2秒で日本語が画面に出ます。薬の量も、日付も、気をつけることも、言われたまま残ります。診察室を出るときには、会話がまるごと手元にあります。',
  'hero.seehow': '使い方を見る',
  'hero.note': '新しいアカウントは無料です。毎週 <strong>{words}</strong> 語まで、カード登録は要りません。',
  'shot.bar': '認識中 · 循環器 · 英語 ↔ 日本語',
  'shot.who.doctor': '医師',
  'shot.who.you': '自分',
  'shot.dir.cp': '英語 → 日本語',
  'shot.dir.pc': '日本語 → 英語',
  'shot.said1': 'Start Lasix, 40 milligrams every morning, and stop the fluid pills you were taking.',
  'shot.rendered1': 'ラシックスを毎朝40ミリグラム飲み始めてください。今まで飲んでいた利尿剤はやめてください。',
  'shot.said2': '木曜日から飲んでいません。飲むとめまいがしたので。',
  'shot.rendered2': 'I haven’t taken it since Thursday because it made me dizzy.',
  'shot.flag': '医師が言った数字は、すべて訳文と照らし合わせます。',

  'how.h2': '診察室での三つの手順',
  'how.lede': 'インストールも、電話をかける先もありません。いつも持っているスマホのブラウザで開きます。',
  'how.1.h': '二つの言語を選ぶ',
  'how.1.p': '自分の言語と医師の言語、そして今日の診療科を選びます。心臓、妊娠、がん、こころの健康など、科を決めることでその分野の言い方が正しく出ます。',
  'how.2.h': 'いつも通りに話す',
  'how.2.p': '誰が話し始めて話し終えたかを自分で聞き分けるので、ボタンを押し続ける必要はなく、誰も話していない間は何も送りません。通訳アプリを使っていることを医師に伝えて、二人の声が届く場所にスマホを置いてください。',
  'how.3.h': '読む、聞く、残す',
  'how.3.p': '一文ごとに1〜2秒で日本語が表示され、読み上げて聞くこともできます。診察が終わるころには、やり取りが文字で残り、スマホに保存されています。',

  'feat.h2': '診察でいちばん訳がずれるところ',
  'feat.lede': '普通の翻訳アプリは、読みやすい文にすることを目指します。ここで大事なのは、足さない、落とさない、やわらげないことです。多少ぶっきらぼうになってもそうします。',
  'feat.doses.h': '薬の量は動かしません',
  'feat.doses.p': '数字、単位、一日何回、何日間が、言われた通りに出ます。四捨五入せず、別の単位に換算せず、「何錠か」のようにぼかしません。訳文から数字が抜けた場合は印が付くので、もう一度聞けます。',
  'feat.neg.h': '「いいえ」が「はい」になりません',
  'feat.neg.p': '「熱はありません」「アレルギーはありません」「たばこは吸ったことがありません」「食事と一緒に飲まないでください」。否定が日本語に移るときに消えることはなく、なかった否定が増えることもありません。',
  'feat.side.h': '左は左のまま',
  'feat.side.p': 'どちら側か、どちらの腕か、どちらの目か。言われた通りに伝わり、文を自然にするために省かれることはありません。',
  'feat.spec.h': '19の診療科',
  'feat.spec.p': '心臓、がん、産婦人科、こころの健康、薬局、麻酔など、科ごとに使う言葉も間違えやすい点も違います。インスリンの単位とミリリットル、目薬をどちらの目に差すか、治すための治療か楽に過ごすための治療か、といったところです。',
  'feat.mishear.h': 'マイクの聞き違いを直します',
  'feat.mishear.p': '医師はラシックスと言ったのに、音声認識は <code>lay six</code> と書きます。どの科の診察かがわかっているので、本来の言葉に戻します。数字はそのように直しません。数字には照らし合わせる手がかりがないからです。',
  'feat.uncert.h': '「かもしれない」は「かもしれない」のまま',
  'feat.uncert.p': '「かもしれません」「私たちはこう考えています」「念のため除外しておきたい」は不確かなまま残り、医師が言い切ったことは言い切ったまま残ります。同意するかどうかは、その違いにかかっています。',
  'feat.langs.h': '25の言語',
  'feat.langs.p': 'スペイン語、中国語、香港の広東語、ベトナム語、タガログ語、韓国語、アラビア語、ハイチ・クレオール語、ソマリ語など。教科書の文ではなく、診療の場で実際に使われている言い方で訳します。',
  'feat.disfl.h': '言いよどみは取り、意味は残す',
  'feat.disfl.p': '言いかけて止めた部分やつっかえた部分は整理し、言い直したときは最後に決まった内容が残ります。整理のときに数字、薬の名前、否定、体の部位には触れません。',
  'feat.privacy.h': 'こちらには何も残しません',
  'feat.privacy.p': '録音も記録も保存しません。診察の内容は、消すか保存するまでブラウザの中だけにあります。こちらで持っているのはメールアドレスと、契約しているかどうかだけです。',

  'pricing.h2': 'たまの受診なら無料で足ります',
  'pricing.lede': 'どちらのプランも同じ翻訳です。言語も診療科も安全のための決まりも同じで、違うのは話せる量だけです。',
  'plan.free.tag': '全員ここから始まります',
  'plan.free.name': '無料',
  'plan.free.price': '$0',
  'plan.free.per': ' / ずっと無料',
  'plan.free.sub': 'カードも、試用期間のカウントダウンもありません。登録するとこのプランになります。',
  'plan.free.f1': '毎週 <strong>{words}</strong> 語',
  'plan.free.f2': '毎週の無料枠は7日間の<strong>ローリング</strong>方式',
  'plan.free.f3': '25の言語と19の診療科すべて',
  'plan.free.f4': '安全のための決まり、数字の照合、聞き違いの修正すべて',
  'plan.free.f5': '読み上げと、診察記録の持ち帰り',
  'plan.free.cta': '無料アカウントを作る',
  'plan.free.foot': '自分の発言も医師の発言も、週の語数に入ります。',
  'plan.pro.tag': '通院が続くなら',
  'plan.pro.name': '無制限',
  'plan.pro.price': '$20',
  'plan.pro.per': ' / 月',
  'plan.pro.sub': 'Stripeで毎月20米ドルをお支払い。いつでも解約できます。',
  'plan.pro.f1': '語数<strong>無制限</strong>。週の上限なし',
  'plan.pro.f2': '無料プランの内容はそのまま',
  'plan.pro.f3': '救急外来で一晩過ごしても残量を気にせずに済みます',
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
  'faq.a1': '実際に声に出した言葉を、両方の側について数えます。訳文は数えません。一つの文が相手の言語で3語になっても30語になっても同じで、読み上げも無料です。中国語や日本語のように単語を分けて書かない言語は、文字数で数えます。',
  'faq.q9': '無料の1週間でどのくらい使えますか',
  'faq.a9': '人が話す速さはおおよそ1分間に130〜150語で、両方の側が数えられるので、{words} 語で短い外来診察1回ぶんくらいです。世間話ではなく、質問と説明の部分でその程度です。診察の途中で使い切るとアプリが知らせ、翌週にかけて少しずつ戻ります。',
  'faq.q2': '「ローリング」の1週間とは',
  'faq.a2': '決まった日にリセットするのではなく、今から7日さかのぼって数えます。月曜の診察で使った分は次の月曜に外れるので、使える量は少しずつ戻ります。リセットの時刻を待つ必要はありません。',
  'faq.q3': '病院の通訳者は頼んだほうがいいですか',
  'faq.a3': 'はい、そしてどちらか一方を選ぶ必要はありません。アメリカでは連邦の資金を受けている病院や診療所は、電話でも対面でも、専門の通訳者を無料で用意する義務があります。書類にサインする前、同意の説明、検査結果、悪い知らせのときは必ず頼んでください。このアプリは人の確認を経ていない機械翻訳なので、話の流れを追う、聞きたいことを整理する、記録を残す、という使い方をしてください。',
  'faq.q4': '音声と記録はどうなりますか',
  'faq.a4': '音声はこの環境に設定された音声認識と翻訳のサービスに送られ、文字が返ってきます。このサーバーは音声も記録も保存しません。診察の内容は、消すか保存するまでブラウザの中にあります。アカウントに残るのは、メールアドレス、契約の状態、各発言で使った語数です。',
  'faq.q5': 'ログインの方法は',
  'faq.a5': 'メールアドレスで行います。リンクをお送りするので、押すだけで入れます。決めたり忘れたりするパスワードはなく、初めて使うときは同じリンクでアカウントができ、リンクは一度だけ使えます。',
  'faq.q6': 'いつでも解約できますか',
  'faq.a6': 'できます。定期購入はアプリから入れるStripeの支払いページで管理し、誰かに連絡しなくても解約できます。解約するとアカウントは消えず、無料プランに戻ります。',
  'faq.q7': '待合室でスマホでも使えますか',
  'faq.a7': '使えます。ブラウザで動くのでインストールは不要で、診察を開いている間は画面が消えません。最初にブラウザがマイクの許可を尋ね、httpsの安全なアドレスでのみ許可されます。',

  'cta.h2': '次の受診に持って行ってください',
  'cta.p': 'メールアドレスだけで、1分かからずに使えるようになります。',
  'foot.disclaimer': 'これは診察でのやり取りを追うための機械翻訳です。認定された医療通訳ではなく、目にする前に人が確認することもありません。診療所や病院が専門の通訳者を用意してくれる場合は利用してください。ここに書かれている内容が理解した内容と違うときは、もう一度確認してください。',

  'nav.record': '残る記録',
  'record.h2': '家に帰ってからも、言われたことがそのまま残ります',
  'record.lede': '飲む量、次に来る日、こうなったらすぐ電話してほしいという話。たいていは最後の五分、もう立ち上がりかけているときに出てきます。二人のやり取りはその場で両方の言語で、時刻付きで記録されます。薬局でも家でも、何度でも読み返せます。',
  'record.1.h': '二つの言語を並べて',
  'record.1.p': '医師が言った通りの言葉と、その日本語の意味が両方残ります。あとで量がおかしいと思ったときは、記憶ではなくそのときの言葉を確かめられます。',
  'record.2.h': '翌日も残っています',
  'record.2.p': 'ページを閉じてもブラウザに残り、ファイルとして保存すれば印刷もメールも、薬局の窓口で見せることもできます。',
  'record.3.h': '一緒に来られなかった家族へ',
  'record.3.p': '薬を管理している娘さん、次の診察に車で連れて行く息子さん。玄関先で聞いた要約ではなく、医師が言ったことをそのまま日本語で読めます。',
  'record.sheet': '診察記録-2026-08-23.txt',
  'record.r1.said': 'Take one tablet twice a day, and stop the other one.',
  'record.r1.rendered': '1回1錠を1日2回飲んでください。もう一方はやめてください。',
  'record.r2.said': '飲むとめまいがしますか。',
  'record.r2.rendered': 'Will it make me dizzy?',
  'record.r3.said': 'It can at first. Come back in two weeks.',
  'record.r3.rendered': 'はじめはあるかもしれません。2週間後にまた来てください。',
  'faq.q8': '記録は持ち帰れますか',
  'faq.a8': 'そのための機能です。保存すると、すべてのやり取りが両方の言語と時刻付きでテキストファイルになります。誰が話し、何を言い、どういう意味かが入ります。診察の内容は消すまでブラウザにも残るので、帰る前に読み返せます。この間、サーバーには何も送られません。',

  'login.title': 'ログイン · 医療翻訳',
  'login.lede': '診察でのやり取りを日本語で追いかけ、終わったあとは記録として残せます。メールアドレスを入力していただくと、ログイン用のリンクをお送りします。決めたり忘れたりするパスワードはありません。',
  'login.email': 'メールアドレス',
  'login.placeholder': 'you@example.com',
  'login.submit': 'ログインリンクを送る',
  'login.sending': '送信中…',
  'login.foot': '初めてですか。同じリンクで登録できます。無料アカウントは毎週 <strong>{words}</strong> 語まで使え、月額の定期購入で上限がなくなります。',
  'login.sent': '{email} に届いたログインリンクをご確認ください。{minutes}分で期限切れになります。',
  'login.devlink': 'メールサービスが設定されていないため、リンクをここに表示します：<a href="{link}">ログイン</a>',
  'login.expired': 'このログインリンクは期限切れか、すでに使用済みです。新しく取得してください。',

  'app.title': '医療翻訳',
  'app.setup': '診察の設定',
  'app.specialty': '診療科',
  'app.specialty.hint': '音声認識と翻訳の両方をこの分野に合わせます',
  'app.clinicianSpeaks': '医療者の言語',
  'app.patientSpeaks': '患者の言語',
  'app.swap': '二つの言語を入れ替える',
  'app.roleHint': '話し手は各発話の言語から判定します。違っていれば、メッセージ上の「医療者 / 患者」ボタンで直してください。',
  'app.export': '書き出し',
  'app.clear': '消去',
  'app.empty': '診療科と二つの言語を選び、<strong>受信を開始</strong>を押してください。<br>各発話は書き起こされ、医療者か患者に割り当てられ、もう一方の言語に翻訳されます。',

  'app.mic.start': '受信を開始',
  'app.mic.stop': '受信を停止',
  'app.meter': 'マイク入力レベル',
  'app.status.idle': '待機中',
  'app.status.listening': '受信中',
  'app.status.speaking': '発話中…',
  'app.status.error': 'エラー',
  'app.status.loading': '音声検出モデルを読み込み中…',
  'app.err.mic': 'マイクのエラー：{message}',
  'app.err.https': 'マイクの利用には HTTPS が必要です。https:// のアドレス（Cloudflare トンネルなど）か localhost でこのページを開いてください。',
  'app.err.nomic': 'このブラウザはマイク API を提供していません。他のアプリ（チャット、QRリーダー）内やプライバシーブラウザでリンクを開いた場合は、Chrome で直接開いてください。',

  'app.turn.transcribing': '書き起こし中…',
  'app.turn.spoken': '発話',
  'app.turn.asSpoken': '{lang} · 話したまま',
  'app.turn.interpreted': '{lang} · 翻訳',
  'app.turn.failed': '書き起こしに失敗しました：{message}',
  'app.turn.whoSpoke': 'この発話を話した人',
  'app.turn.isSpeaker': 'この発話の話し手',
  'app.turn.reassign': 'この発話を割り当て直して翻訳をやり直す',
  'app.turn.substituted': '⚠ 認識結果は{detected}でしたが、{used}として扱いました',
  'app.turn.deviation': '⚠ {detected}のように聞こえます。想定は{expected}です',
  'app.turn.sameLang': '双方とも{lang}で話しているため、翻訳するものがありません。',
  'app.turn.readAloud': '読み上げる',
  'app.numbers': '数値をご確認ください：<b>{missing}</b> は発話にありましたが翻訳にはありません。数値を文字で書く言語もあるため、実行前にご確認ください。',
  'app.export.empty': 'まだ書き出せる内容がありません',

  'export.title': '診察の記録',
  'export.date': '日付：',
  'export.specialty': '診療科：',
  'export.languages': '言語：',
  'export.turns': '項目数：',
  'export.disclaimer': 'これは診察中に話された内容を機械が翻訳した記録です。人による確認は行われておらず、有資格の医療通訳者に代わるものではありません。分かりにくい点や記憶と異なる点があれば、そのとおりにする前に医療機関にご確認ください。',
  'export.into': '{lang}への翻訳：',
  'export.sameLang': '（双方がこの言語で話していたため、翻訳はしていません）',

  'app.plan.free': '無料プラン',
  'app.plan.pro': '無制限',
  'app.quota.left': '今週は {limit} 語中 {remaining} 語が残っています',
  'app.quota.hint': 'ローリング7日間：話してから7日が過ぎた語は数えられなくなります。',
  'app.quota.resets': ' {when} に一部の上限が戻ります。',
  'app.quota.spent': '<strong>今週の無料分を使い切りました。</strong>ローリング期間で上限が戻るまで翻訳を停止します。{when}',
  'app.quota.reached': '週の語数上限に達しました',
  'app.upgrade': '購読して無制限に',
  'app.manage': '購読を管理',
  'app.logout': 'ログアウト',
  'app.err.billing': '請求：{message}',
  'app.err.tts': '音声合成：{message}',
  'app.err.config': '設定の読み込みに失敗しました：{message}',
};
