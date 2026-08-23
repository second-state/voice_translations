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
  document.documentElement.lang = currentLocale === 'yue' ? 'zh-Hant' : currentLocale;
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
  'brand': 'Medical Interpreter',
  'lang.label': 'Language',
  'common.clinician': 'Clinician',
  'common.patient': 'Patient',

  // ── Landing page ────────────────────────────────────────────────────
  'home.title': 'Medical Interpreter — real-time interpreting for patient visits',
  'nav.how': 'How it works',
  'nav.features': 'Features',
  'nav.pricing': 'Pricing',
  'nav.faq': 'FAQ',
  'nav.signin': 'Sign in',
  'nav.start': 'Start free',
  'nav.open': 'Open the interpreter',

  'hero.eyebrow': '🎙️ Speak normally — it interprets both ways',
  'hero.h1': 'Every word your patient says, in a language <span class="hl">you both understand</span>.',
  'hero.lede': 'Live interpreting for a bilingual visit. Each turn is transcribed as it is spoken, cleaned of the stumbles nobody means to say, and rendered into the other person’s language — with the numbers, negations, and sides of the body that clinical meaning depends on kept intact.',
  'hero.seehow': 'See how it works',
  'hero.note': 'New accounts start on the free plan — <strong>{words}</strong> interpreted words a week, no card required.',
  'shot.bar': 'Listening · Cardiology · English ↔ Spanish',
  'shot.dir.cp': 'English → Spanish',
  'shot.dir.pc': 'Spanish → English',
  'shot.said1': 'Start Lasix, 40 milligrams every morning, and stop the fluid pills you were taking.',
  'shot.rendered1': 'Empiece a tomar Lasix, 40 miligramos todas las mañanas, y deje las pastillas para el líquido que estaba tomando.',
  'shot.said2': 'No he tomado nada desde el jueves porque me daba mareos.',
  'shot.rendered2': 'I haven’t taken anything since Thursday because it was making me dizzy.',
  'shot.flag': 'Every figure spoken is checked against the interpretation.',

  'how.h2': 'Three steps, then it stays out of the way',
  'how.lede': 'No handset to pass around, no third party to dial, no app to install on the patient’s phone.',
  'how.1.h': 'Pick the languages',
  'how.1.p': 'Choose what the care team speaks and what the patient speaks, plus the specialty for the visit. Both sides sit in front of one screen.',
  'how.2.h': 'Talk normally',
  'how.2.p': 'A speech detector running in your browser notices when someone starts and stops speaking, so nothing is sent while the room is quiet and nobody holds a button.',
  'how.3.h': 'Read or hear it back',
  'how.3.p': 'Each turn appears in both languages within a second or two, and can be read aloud in a different voice per side. The transcript exports as a timestamped file.',

  'feat.h2': 'Built for the ways clinical meaning goes missing',
  'feat.lede': 'A general translator optimizes for a smooth sentence. An interpreter has to optimize for nothing being added, dropped, or softened — which is a different target, and occasionally a less elegant one.',
  'feat.doses.h': 'Doses survive intact',
  'feat.doses.p': 'Numbers, units, routes, frequencies, and durations are reproduced exactly — never converted between unit systems, never rounded, never turned into “a few”. Any figure that goes missing from an interpretation is flagged for a second look.',
  'feat.neg.h': 'Negation stays negative',
  'feat.neg.p': '“No fever”, “not allergic”, “never smoked”, “don’t take it with food” cannot come out the other side as the opposite, and a positive statement cannot acquire a “not”.',
  'feat.side.h': 'Left stays left',
  'feat.side.p': 'Laterality and anatomical site are reproduced exactly, and never dropped to make a sentence read more naturally.',
  'feat.spec.h': '19 specialties',
  'feat.spec.p': 'Cardiology, oncology, OB/GYN, psychiatry, pharmacy, anesthesia and more, each with the terminology and the confusions specific to it — units versus millilitres for insulin, which eye the drops go in, curative versus palliative intent.',
  'feat.mishear.h': 'Mishearings repaired',
  'feat.mishear.p': 'Speech recognition writes <code>lay six</code> where a clinician said Lasix. The interpreter knows the specialty’s vocabulary and restores the intended term — while never “correcting” a number, which has no context to recover it from.',
  'feat.uncert.h': 'Uncertainty is preserved',
  'feat.uncert.p': '“Might be”, “we think”, “we need to rule out” stay tentative, and definite statements stay definite. That distinction is what a patient’s consent rests on.',
  'feat.langs.h': '25 languages',
  'feat.langs.p': 'Including Spanish, Mandarin, Hong Kong Cantonese, Vietnamese, Tagalog, Korean, Arabic, Haitian Creole, Somali and more — each rendered the way that language’s own healthcare settings actually speak.',
  'feat.disfl.h': 'Disfluency removed, meaning kept',
  'feat.disfl.p': 'Fillers, stutters and false starts come out; self-corrections resolve to what the speaker settled on. No number, drug name, negation or body part is touched while tidying.',
  'feat.privacy.h': 'Nothing is kept here',
  'feat.privacy.p': 'The server stores no recordings and no transcripts. The conversation lives in your browser tab until you clear or export it. What we do store is your email address and whether you are subscribed.',

  'pricing.h2': 'Start free. Subscribe when you outgrow it.',
  'pricing.lede': 'Both plans are the same interpreter — every specialty, every language, every safety rule. The only difference is how much you can say.',
  'plan.free.tag': 'You start here',
  'plan.free.name': 'Free',
  'plan.free.price': '$0',
  'plan.free.per': ' / forever',
  'plan.free.sub': 'No card, no trial clock. Signing up puts you on this plan.',
  'plan.free.f1': '<strong>{words}</strong> interpreted words a week',
  'plan.free.f2': 'A <strong>rolling</strong> seven-day window — words free up as they age out, with no reset day to wait for',
  'plan.free.f3': 'All 19 specialties and all 25 languages',
  'plan.free.f4': 'Every safety rule, the number check, and mishearing repair',
  'plan.free.f5': 'Read-aloud and transcript export',
  'plan.free.cta': 'Create a free account',
  'plan.free.foot': 'Both sides of the conversation count toward the weekly words.',
  'plan.pro.tag': 'For regular use',
  'plan.pro.name': 'Unlimited',
  'plan.pro.price': 'Monthly',
  'plan.pro.sub': 'Billed monthly through Stripe. Cancel any time.',
  'plan.pro.f1': '<strong>Unlimited</strong> interpreted words — no weekly ceiling',
  'plan.pro.f2': 'Everything in Free, unchanged',
  'plan.pro.f3': 'Full clinic days without watching a counter',
  'plan.pro.f4': 'Manage the card or cancel yourself, from inside the app',
  'plan.pro.f5': 'Access continues while a card is being retried',
  'plan.pro.cta': 'Start free, upgrade later',
  'plan.pro.foot': 'Upgrade from inside the app once you have an account.',
  'plan.pro.off': 'Not yet available',
  'plan.pro.offsub': 'Subscriptions are not enabled on this deployment.',
  'plan.pro.offfoot': 'Every account currently stays on the free plan.',
  'plan.pro.upgrade': 'Upgrade in the app',

  'faq.h2': 'Questions worth asking first',
  'faq.q1': 'What counts as a word?',
  'faq.a1': 'The words people actually speak, counted once per turn as they are transcribed — whichever side spoke them. Interpretations are free: one sentence costs the same whether the other language needs three words for it or thirty, and reading a turn aloud costs nothing. Languages that do not put spaces between words, like Chinese and Japanese, are counted character by character.',
  'faq.q2': 'What does “rolling” mean for the weekly limit?',
  'faq.a2': 'Usage is counted from right now backwards over seven days, rather than being reset on a fixed day. A long visit on Monday stops counting the following Monday, and your allowance returns gradually rather than all at once. There is no reset hour to wait up for and nothing to plan around.',
  'faq.q3': 'Is this a replacement for a qualified medical interpreter?',
  'faq.a3': 'No, and it should not be treated as one. It is a machine interpreter: fast, available at any hour, and unreviewed by anyone before you read it. For consent discussions, breaking bad news, and anything else where a mistranslation would change what a person agrees to, use a qualified human interpreter. Verify anything clinical against the source before acting on it or filing it.',
  'faq.q4': 'What happens to the audio and the transcript?',
  'faq.a4': 'Speech is sent to the speech-recognition and language services this deployment is configured to use, and interpreted text comes back. This server keeps neither the audio nor the transcript — the conversation lives in your browser tab until you clear it or export it. Your account record is your email address, your subscription state, and how many words each turn spent.',
  'faq.q5': 'How do I sign in?',
  'faq.a5': 'With your email address. We send a link, you click it, and you are in — there is no password to choose, forget, or have stolen. The same link creates your account the first time you use it, and each link works once.',
  'faq.q6': 'Can I cancel whenever I want?',
  'faq.a6': 'Yes. Subscriptions are managed in Stripe’s billing portal, reachable from the account bar inside the app, and cancelling takes effect without contacting anyone. Your account then returns to the free plan rather than disappearing.',
  'faq.q7': 'Does it work on a phone or tablet at the bedside?',
  'faq.a7': 'Yes — it runs in the browser with nothing to install, and the screen is kept awake while a session is open. A browser will only grant microphone access over HTTPS, so use the secure address of your deployment.',

  'cta.h2': 'Try it on your next bilingual visit',
  'cta.p': 'An email address is all it takes. You will be on the free plan in under a minute.',
  'foot.disclaimer': 'Machine interpreting is an aid for a bilingual encounter, not a certified medical interpretation, and its output is not reviewed by a person before you see it. Verify anything clinical against the source before acting on it or filing it.',

  // ── Sign-in page ────────────────────────────────────────────────────
  'login.title': 'Sign in · Medical Interpreter',
  'login.lede': 'Real-time interpreting between a patient and their care team. Enter your email and we will send you a sign-in link — no password to choose or forget.',
  'login.email': 'Email address',
  'login.placeholder': 'you@clinic.org',
  'login.submit': 'Email me a sign-in link',
  'login.sending': 'Sending…',
  'login.foot': 'New here? The same link signs you up. Free accounts include <strong>{words}</strong> interpreted words a week; a monthly subscription removes the limit.',
  'login.sent': 'Check {email} for a sign-in link. It expires in {minutes} minutes.',
  'login.devlink': 'No mail provider is configured, so here is your link: <a href="{link}">sign in</a>',
  'login.expired': 'That sign-in link has expired or was already used. Request a new one.',

  // ── Console: setup ──────────────────────────────────────────────────
  'app.title': 'Medical Interpreter',
  'app.setup': 'Encounter setup',
  'app.specialty': 'Specialty',
  'app.specialty.hint': 'Tunes both speech recognition and interpreting to this field',
  'app.clinicianSpeaks': 'Clinician speaks',
  'app.patientSpeaks': 'Patient speaks',
  'app.swap': 'Swap the two languages',
  'app.roleHint': 'The speaker is detected from the language of each turn — use the Clinician/Patient buttons on a message to correct it.',
  'app.export': 'Export',
  'app.clear': 'Clear',
  'app.empty': 'Pick the specialty and the two languages, then press <strong>Start listening</strong>.<br>Each utterance is transcribed, attributed to the clinician or the patient, and interpreted into the other language.',

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
  'app.turn.interpreted': '{lang} · interpreted',
  'app.turn.failed': 'Transcription failed: {message}',
  'app.turn.whoSpoke': 'Who spoke this turn',
  'app.turn.isSpeaker': 'Speaker of this turn',
  'app.turn.reassign': 'Reassign this turn and re-interpret',
  'app.turn.substituted': '⚠ recognizer said {detected}; treated as {used}',
  'app.turn.deviation': '⚠ sounds like {detected}, expected {expected}',
  'app.turn.sameLang': 'Both parties are speaking {lang} — nothing to interpret.',
  'app.turn.readAloud': 'Read aloud',
  'app.numbers': 'Check the numbers: <b>{missing}</b> appeared in the speech but not in the interpretation. Some languages write figures as words — confirm before acting on it.',
  'app.export.empty': 'Nothing to export yet',

  // ── Console: account bar ────────────────────────────────────────────
  'app.plan.free': 'Free plan',
  'app.plan.pro': 'Unlimited',
  'app.quota.left': '{remaining} of {limit} words left this week',
  'app.quota.hint': 'A rolling seven-day window: words stop counting seven days after they are spoken.',
  'app.quota.resets': ' Some allowance returns {when}.',
  'app.quota.spent': '<strong>This week’s free allowance is used up.</strong> Interpreting is paused until the rolling window frees up. {when}',
  'app.quota.reached': 'Weekly word allowance reached',
  'app.upgrade': 'Subscribe for unlimited',
  'app.manage': 'Manage subscription',
  'app.logout': 'Log out',
  'app.err.billing': 'Billing: {message}',
  'app.err.tts': 'TTS: {message}',
  'app.err.config': 'Config load failed: {message}',
};

STRINGS.zh = {
  'brand': '医疗口译',
  'lang.label': '界面语言',
  'common.clinician': '医护',
  'common.patient': '患者',

  'home.title': '医疗口译 — 就诊现场的实时口译',
  'nav.how': '使用方法',
  'nav.features': '功能',
  'nav.pricing': '价格',
  'nav.faq': '常见问题',
  'nav.signin': '登录',
  'nav.start': '免费开始',
  'nav.open': '打开口译界面',

  'hero.eyebrow': '🎙️ 正常说话 — 双向自动口译',
  'hero.h1': '让患者说的每一句话，都变成<span class="hl">双方都听得懂</span>的语言。',
  'hero.lede': '为双语就诊提供实时口译。每一句话在说出的同时被转写，去掉无意义的口头语，再转换成对方的语言 — 数字、否定词、左右部位这些决定临床含义的内容一字不差。',
  'hero.seehow': '了解使用方法',
  'hero.note': '新账户默认使用免费方案 — 每周 <strong>{words}</strong> 个口译词数，无需信用卡。',
  'shot.bar': '正在聆听 · 心脏科 · 英语 ↔ 西班牙语',
  'shot.dir.cp': '英语 → 西班牙语',
  'shot.dir.pc': '西班牙语 → 英语',
  'shot.said1': '开始服用速尿（Lasix），每天早上 40 毫克，之前的利尿药停掉。',
  'shot.rendered1': 'Empiece a tomar Lasix, 40 miligramos todas las mañanas, y deje las pastillas para el líquido que estaba tomando.',
  'shot.said2': 'No he tomado nada desde el jueves porque me daba mareos.',
  'shot.rendered2': '我从星期四起就没吃过，因为吃了会头晕。',
  'shot.flag': '说出的每一个数字都会与口译结果核对。',

  'how.h2': '三步设置，之后它不再打扰你',
  'how.lede': '不用传递听筒，不用拨打第三方，患者手机上也不用装任何应用。',
  'how.1.h': '选择语言',
  'how.1.p': '选择医护方使用的语言、患者使用的语言，以及本次就诊的科室。双方共用一块屏幕。',
  'how.2.h': '正常说话',
  'how.2.p': '浏览器内运行的语音检测会判断谁在说话、何时停顿，因此安静时不会上传任何音频，也不需要按住按钮。',
  'how.3.h': '阅读或朗读',
  'how.3.p': '每句话在一两秒内以两种语言显示，并可用不同声音分别朗读双方的内容。记录可导出为带时间戳的文件。',

  'feat.h2': '针对临床含义最容易丢失的环节而设计',
  'feat.lede': '通用翻译追求句子通顺，口译追求的却是不增、不减、不软化 — 这是另一个目标，有时读起来也没那么优雅。',
  'feat.doses.h': '剂量原样保留',
  'feat.doses.p': '数字、单位、给药途径、频次和疗程都原样呈现 — 不做单位换算、不四舍五入、不会变成“一点点”。口译中缺失的任何数字都会被标记出来复核。',
  'feat.neg.h': '否定就是否定',
  'feat.neg.p': '“没有发烧”“不过敏”“从不吸烟”“不要与食物同服”不会在另一侧变成相反的意思，肯定句也不会凭空多出一个“不”。',
  'feat.side.h': '左就是左',
  'feat.side.p': '左右侧别和解剖部位原样呈现，绝不会为了句子通顺而省略。',
  'feat.spec.h': '19 个科室',
  'feat.spec.p': '心脏科、肿瘤科、妇产科、精神科、药房、麻醉等，每个科室都有各自的术语和易混点 — 胰岛素的“单位”与“毫升”、滴哪只眼睛、根治与姑息的区别。',
  'feat.mishear.h': '修复听错的词',
  'feat.mishear.p': '医生说的是 Lasix，语音识别却写成 <code>lay six</code>。系统知道该科室的词汇，会还原成本来的术语 — 但绝不会“修正”数字，因为数字没有可供还原的上下文。',
  'feat.uncert.h': '不确定性得以保留',
  'feat.uncert.p': '“可能是”“我们认为”“还需要排除”依然是推测语气，肯定的说法依然肯定。患者的知情同意正建立在这个区别之上。',
  'feat.langs.h': '25 种语言',
  'feat.langs.p': '包括西班牙语、普通话、香港粤语、越南语、他加禄语、韩语、阿拉伯语、海地克里奥尔语、索马里语等 — 每种语言都按当地医疗场景的真实说法来表达。',
  'feat.disfl.h': '去除杂音，保留含义',
  'feat.disfl.p': '语气词、结巴和说了一半的话会被清理，自我更正后只保留最终说定的内容。整理过程中不会改动任何数字、药名、否定词或身体部位。',
  'feat.privacy.h': '服务器不留存任何内容',
  'feat.privacy.p': '服务器不保存录音，也不保存转写记录。对话只存在于你的浏览器标签页中，直到你清除或导出。我们保存的只有你的邮箱地址和订阅状态。',

  'pricing.h2': '免费开始，不够用时再订阅。',
  'pricing.lede': '两种方案使用的是同一套口译能力 — 全部科室、全部语言、全部安全规则。区别只在于你能说多少。',
  'plan.free.tag': '默认方案',
  'plan.free.name': '免费',
  'plan.free.price': '￥0',
  'plan.free.per': ' / 永久',
  'plan.free.sub': '无需信用卡，没有试用倒计时。注册即为此方案。',
  'plan.free.f1': '每周 <strong>{words}</strong> 个口译词数',
  'plan.free.f2': '采用<strong>滚动</strong>七天窗口 — 词数随时间自动释放，不必等待某个重置日',
  'plan.free.f3': '全部 19 个科室与 25 种语言',
  'plan.free.f4': '全部安全规则、数字核对与听错修复',
  'plan.free.f5': '朗读与记录导出',
  'plan.free.cta': '创建免费账户',
  'plan.free.foot': '对话双方的词数都计入每周额度。',
  'plan.pro.tag': '适合常规使用',
  'plan.pro.name': '不限量',
  'plan.pro.price': '按月订阅',
  'plan.pro.sub': '通过 Stripe 按月扣款，可随时取消。',
  'plan.pro.f1': '口译词数<strong>不限量</strong> — 没有每周上限',
  'plan.pro.f2': '免费方案的全部功能，原样保留',
  'plan.pro.f3': '整天门诊都不必盯着计数器',
  'plan.pro.f4': '在应用内自行更换银行卡或取消订阅',
  'plan.pro.f5': '扣款重试期间服务不中断',
  'plan.pro.cta': '先免费使用，之后再升级',
  'plan.pro.foot': '注册后可在应用内升级。',
  'plan.pro.off': '暂未开放',
  'plan.pro.offsub': '本部署未启用订阅功能。',
  'plan.pro.offfoot': '目前所有账户都使用免费方案。',
  'plan.pro.upgrade': '在应用内升级',

  'faq.h2': '值得先问清楚的问题',
  'faq.q1': '什么算一个“词”？',
  'faq.a1': '只计算实际说出的话，在转写时按句计入一次，无论由哪一方说出。口译结果不计费：一句话无论对方语言需要三个词还是三十个词，消耗都一样，朗读也不消耗额度。中文、日文这类词与词之间不加空格的语言按字计算。',
  'faq.q2': '每周额度的“滚动”是什么意思？',
  'faq.a2': '用量是从当前时刻向前回溯七天统计的，而不是在固定某一天清零。周一的一次长时间就诊，到下周一就不再计入，额度是逐步恢复而不是一次性恢复。没有需要苦等的重置时刻，也无需刻意安排。',
  'faq.q3': '它能取代有资质的医疗口译员吗？',
  'faq.a3': '不能，也不应被当作替代品。这是机器口译：快速、随时可用，但在你看到之前没有任何人复核过。涉及知情同意、告知坏消息，以及任何误译会改变对方所同意内容的场合，请使用有资质的人工口译员。任何临床内容在执行或归档前，都应与原文核对。',
  'faq.q4': '音频和转写记录会怎么处理？',
  'faq.a4': '语音会发送到本部署所配置的语音识别与语言服务，并返回口译文本。本服务器既不保存音频也不保存转写记录 — 对话只存在于你的浏览器标签页中，直到你清除或导出。账户中保存的只有邮箱地址、订阅状态，以及每句话消耗的词数。',
  'faq.q5': '如何登录？',
  'faq.a5': '使用邮箱地址。我们发送一个链接，你点击即可登录 — 没有需要设置、遗忘或被盗的密码。首次使用该链接时会自动创建账户，每个链接只能使用一次。',
  'faq.q6': '可以随时取消吗？',
  'faq.a6': '可以。订阅通过 Stripe 的账单中心管理，从应用内的账户栏即可进入，取消无需联系任何人。取消后账户会回到免费方案，而不会被删除。',
  'faq.q7': '可以在床边用手机或平板使用吗？',
  'faq.a7': '可以 — 直接在浏览器中运行，无需安装，会话进行期间屏幕保持常亮。浏览器只在 HTTPS 下允许使用麦克风，请使用部署的安全地址。',

  'cta.h2': '在下一次双语就诊中试试',
  'cta.p': '只需一个邮箱地址，一分钟内即可开始使用免费方案。',
  'foot.disclaimer': '机器口译是双语沟通的辅助手段，不是有资质的医疗口译，其输出在你看到之前未经任何人复核。任何临床内容在执行或归档前，都应与原文核对。',

  'login.title': '登录 · 医疗口译',
  'login.lede': '为患者与医护团队提供实时口译。输入邮箱，我们会发送登录链接 — 无需设置或记住密码。',
  'login.email': '邮箱地址',
  'login.placeholder': 'you@clinic.org',
  'login.submit': '发送登录链接到邮箱',
  'login.sending': '发送中…',
  'login.foot': '第一次使用？同一个链接即可完成注册。免费账户每周包含 <strong>{words}</strong> 个口译词数；按月订阅可解除限制。',
  'login.sent': '请查收 {email} 的登录链接，{minutes} 分钟内有效。',
  'login.devlink': '未配置邮件服务，登录链接在此：<a href="{link}">登录</a>',
  'login.expired': '该登录链接已过期或已被使用，请重新获取。',

  'app.title': '医疗口译',
  'app.setup': '就诊设置',
  'app.specialty': '科室',
  'app.specialty.hint': '同时针对该科室优化语音识别与口译',
  'app.clinicianSpeaks': '医护使用',
  'app.patientSpeaks': '患者使用',
  'app.swap': '交换两种语言',
  'app.roleHint': '说话方根据每句话的语言自动判断 — 如需更正，请点击消息上的「医护 / 患者」按钮。',
  'app.export': '导出',
  'app.clear': '清空',
  'app.empty': '选择科室与两种语言，然后按<strong>开始聆听</strong>。<br>每句话都会被转写、归属到医护或患者，并口译成另一种语言。',

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
  'app.turn.interpreted': '{lang} · 口译',
  'app.turn.failed': '转写失败：{message}',
  'app.turn.whoSpoke': '这句话由谁说出',
  'app.turn.isSpeaker': '本句的说话方',
  'app.turn.reassign': '改为该说话方并重新口译',
  'app.turn.substituted': '⚠ 识别结果为{detected}，已按{used}处理',
  'app.turn.deviation': '⚠ 听起来像{detected}，预期为{expected}',
  'app.turn.sameLang': '双方都在使用{lang} — 无需口译。',
  'app.turn.readAloud': '朗读',
  'app.numbers': '请核对数字：<b>{missing}</b> 出现在原话中，但未出现在口译结果里。部分语言会用文字书写数字，执行前请先确认。',
  'app.export.empty': '暂无可导出的内容',

  'app.plan.free': '免费方案',
  'app.plan.pro': '不限量',
  'app.quota.left': '本周剩余 {remaining} / {limit} 词',
  'app.quota.hint': '滚动七天窗口：每个词在说出七天后不再计入。',
  'app.quota.resets': ' 部分额度将于 {when} 恢复。',
  'app.quota.spent': '<strong>本周免费额度已用完。</strong>口译暂停，需等待滚动窗口释放额度。{when}',
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
  'brand': '醫療傳譯',
  'lang.label': '介面語言',
  'common.clinician': '醫護',
  'common.patient': '病人',

  'home.title': '醫療傳譯 — 應診現場即時傳譯',
  'nav.how': '使用方法',
  'nav.features': '功能',
  'nav.pricing': '收費',
  'nav.faq': '常見問題',
  'nav.signin': '登入',
  'nav.start': '免費開始',
  'nav.open': '開啟傳譯介面',

  'hero.eyebrow': '🎙️ 照常講嘢 — 雙向即時傳譯',
  'hero.h1': '病人講嘅每一句，都變成<span class="hl">雙方都聽得明</span>嘅語言。',
  'hero.lede': '為雙語應診提供即時傳譯。每一句話一邊講一邊轉寫，去走冇意思嘅口頭語，再轉成對方嘅語言 — 數字、否定、左右邊呢啲決定臨床意思嘅內容，一個都唔會走樣。',
  'hero.seehow': '睇吓點用',
  'hero.note': '新帳戶預設用免費方案 — 每星期 <strong>{words}</strong> 個傳譯字數，唔使信用卡。',
  'shot.bar': '聆聽中 · 心臟科 · 英文 ↔ 西班牙文',
  'shot.dir.cp': '英文 → 西班牙文',
  'shot.dir.pc': '西班牙文 → 英文',
  'shot.said1': '開始食 Lasix，每朝 40 毫克，之前嗰隻去水丸就停咗佢。',
  'shot.rendered1': 'Empiece a tomar Lasix, 40 miligramos todas las mañanas, y deje las pastillas para el líquido que estaba tomando.',
  'shot.said2': 'No he tomado nada desde el jueves porque me daba mareos.',
  'shot.rendered2': '我由星期四開始就冇食過，因為食完會頭暈。',
  'shot.flag': '講出嚟嘅每個數字都會同傳譯結果核對。',

  'how.h2': '三步設定，之後佢唔會阻住你',
  'how.lede': '唔使傳聽筒，唔使打俾第三方，病人部電話都唔使裝任何嘢。',
  'how.1.h': '揀語言',
  'how.1.p': '揀醫護方講嘅語言、病人講嘅語言，同埋今次應診嘅專科。雙方共用一個螢幕。',
  'how.2.h': '照常講嘢',
  'how.2.p': '喺瀏覽器入面行嘅語音偵測會知邊個開始講、幾時停，所以靜嘅時候唔會傳送任何錄音，亦都唔使㩒住個掣。',
  'how.3.h': '睇或者聽返',
  'how.3.p': '每句話一兩秒內就會用兩種語言顯示，仲可以用唔同聲線分別讀出雙方嘅內容。紀錄可以匯出成帶時間嘅檔案。',

  'feat.h2': '針對臨床意思最容易走失嘅地方而設',
  'feat.lede': '一般翻譯追求句子順暢；傳譯追求嘅係唔加、唔減、唔淡化 — 目標唔同，有時讀落亦冇咁優雅。',
  'feat.doses.h': '劑量原封不動',
  'feat.doses.p': '數字、單位、服法、次數同療程全部原樣呈現 — 唔會換算單位、唔會四捨五入、唔會變成「少少」。傳譯中少咗嘅數字都會標示出嚟等你覆核。',
  'feat.neg.h': '否定就係否定',
  'feat.neg.p': '「冇發燒」「唔敏感」「從來冇食煙」「唔好同食物一齊食」唔會喺另一邊變成相反意思，肯定句亦唔會無端端多咗個「唔」。',
  'feat.side.h': '左邊就係左邊',
  'feat.side.p': '左右邊同身體部位原樣呈現，唔會為咗句子順暢而慳咗。',
  'feat.spec.h': '19 個專科',
  'feat.spec.p': '心臟科、腫瘤科、婦產科、精神科、藥房、麻醉等，每個專科都有自己嘅術語同易混淆位 — 胰島素嘅「單位」同「毫升」、滴邊隻眼、根治定紓緩。',
  'feat.mishear.h': '修正聽錯嘅字',
  'feat.mishear.p': '醫生講 Lasix，語音識別寫成 <code>lay six</code>。系統識得呢個專科嘅詞彙，會還原返正確嘅術語 — 但絕對唔會「改正」數字，因為數字冇上下文可以還原。',
  'feat.uncert.h': '不確定嘅語氣保留',
  'feat.uncert.p': '「可能係」「我哋估計」「仲要排除」依然係推測語氣，肯定嘅講法依然肯定。病人嘅知情同意就係建立喺呢個分別上。',
  'feat.langs.h': '25 種語言',
  'feat.langs.p': '包括西班牙文、普通話、香港粵語、越南文、他加祿文、韓文、阿拉伯文、海地克里奧爾文、索馬里文等 — 每種語言都用當地醫療場景真正嘅講法。',
  'feat.disfl.h': '去雜音，保意思',
  'feat.disfl.p': '語氣詞、口窒窒同講一半嘅說話會清走，自我更正之後只保留最後講定嗰個版本。整理途中唔會郁到任何數字、藥名、否定詞或者身體部位。',
  'feat.privacy.h': '伺服器唔會留低任何嘢',
  'feat.privacy.p': '伺服器唔會儲存錄音，亦唔會儲存轉寫紀錄。對話只係存喺你個瀏覽器分頁，直到你清除或者匯出。我哋儲存嘅只有你嘅電郵地址同訂閱狀態。',

  'pricing.h2': '免費開始，唔夠用先訂閱。',
  'pricing.lede': '兩個方案用嘅係同一套傳譯能力 — 所有專科、所有語言、所有安全規則。分別只在於你可以講幾多。',
  'plan.free.tag': '預設方案',
  'plan.free.name': '免費',
  'plan.free.price': 'HK$0',
  'plan.free.per': ' / 永久',
  'plan.free.sub': '唔使信用卡，冇試用倒數。註冊即用此方案。',
  'plan.free.f1': '每星期 <strong>{words}</strong> 個傳譯字數',
  'plan.free.f2': '採用<strong>滾動</strong>七日視窗 — 字數會隨時間自動釋放，唔使等某個重設日',
  'plan.free.f3': '全部 19 個專科同 25 種語言',
  'plan.free.f4': '全部安全規則、數字核對同聽錯修正',
  'plan.free.f5': '朗讀同紀錄匯出',
  'plan.free.cta': '建立免費帳戶',
  'plan.free.foot': '對話雙方嘅字數都會計入每星期額度。',
  'plan.pro.tag': '適合日常使用',
  'plan.pro.name': '無限字數',
  'plan.pro.price': '按月訂閱',
  'plan.pro.sub': '經 Stripe 按月收費，隨時可以取消。',
  'plan.pro.f1': '傳譯字數<strong>無上限</strong> — 冇每星期限制',
  'plan.pro.f2': '免費方案嘅全部功能，原樣保留',
  'plan.pro.f3': '成日應診都唔使睇住個計數器',
  'plan.pro.f4': '喺應用程式入面自己換卡或者取消',
  'plan.pro.f5': '扣款重試期間服務唔會中斷',
  'plan.pro.cta': '先免費用，之後再升級',
  'plan.pro.foot': '有咗帳戶之後可以喺應用程式入面升級。',
  'plan.pro.off': '暫未開放',
  'plan.pro.offsub': '呢個部署未啟用訂閱功能。',
  'plan.pro.offfoot': '目前所有帳戶都係用免費方案。',
  'plan.pro.upgrade': '喺應用程式入面升級',

  'faq.h2': '值得先問清楚嘅問題',
  'faq.q1': '點樣先叫一個「字」？',
  'faq.a1': '只計實際講出嚟嘅說話，轉寫時每句計一次，唔理邊一方講。傳譯結果唔收費：一句話無論對方語言要三個字定三十個字，消耗都一樣，朗讀亦唔會扣額度。中文、日文呢類字與字之間冇空格嘅語言，按字計算。',
  'faq.q2': '每星期額度嘅「滾動」係咩意思？',
  'faq.a2': '用量係由呢一刻向前數七日計嘅，唔係喺固定某一日清零。星期一一次長時間應診，到下個星期一就唔再計入，額度係逐步回復而唔係一次過。冇一個要等嘅重設時間，亦唔使刻意安排。',
  'faq.q3': '佢可唔可以取代有資格嘅醫療傳譯員？',
  'faq.a3': '唔可以，亦唔應該當佢係替代品。呢個係機器傳譯：快、隨時可用，但喺你睇到之前冇任何人覆核過。涉及知情同意、告知壞消息，同埋任何一句譯錯就會改變對方所同意內容嘅場合，請用有資格嘅人手傳譯員。任何臨床內容喺執行或者存檔之前，都要同原文核對。',
  'faq.q4': '錄音同轉寫紀錄會點處理？',
  'faq.a4': '語音會送去呢個部署所設定嘅語音識別同語言服務，再攞返傳譯文字。本伺服器既唔會儲存錄音，亦唔會儲存轉寫紀錄 — 對話只存喺你個瀏覽器分頁，直到你清除或者匯出。帳戶入面儲存嘅只有電郵地址、訂閱狀態，同埋每句話用咗幾多字。',
  'faq.q5': '點樣登入？',
  'faq.a5': '用電郵地址。我哋會寄一條連結俾你，㩒一下就登入到 — 冇密碼要諗、要記，亦冇得俾人偷。第一次用嗰條連結會自動幫你開帳戶，每條連結只可以用一次。',
  'faq.q6': '可唔可以隨時取消？',
  'faq.a6': '可以。訂閱喺 Stripe 嘅帳單中心管理，喺應用程式嘅帳戶列就入到，取消唔使聯絡任何人。取消之後帳戶會返去免費方案，唔會消失。',
  'faq.q7': '喺病床邊用手機或平板得唔得？',
  'faq.a7': '得 — 直接喺瀏覽器行，唔使裝嘢，開住嘅時候螢幕會保持唔熄。瀏覽器只會喺 HTTPS 之下俾用麥克風，所以請用部署嘅安全網址。',

  'cta.h2': '下次雙語應診試吓',
  'cta.p': '只需要一個電郵地址，一分鐘之內就可以用免費方案。',
  'foot.disclaimer': '機器傳譯係雙語溝通嘅輔助工具，唔係有資格嘅醫療傳譯，佢嘅輸出喺你睇到之前未經任何人覆核。任何臨床內容喺執行或者存檔之前，都要同原文核對。',

  'login.title': '登入 · 醫療傳譯',
  'login.lede': '為病人同醫護團隊提供即時傳譯。輸入電郵，我哋會寄登入連結俾你 — 唔使諗密碼，亦唔會記唔起。',
  'login.email': '電郵地址',
  'login.placeholder': 'you@clinic.org',
  'login.submit': '寄登入連結俾我',
  'login.sending': '寄緊…',
  'login.foot': '第一次用？同一條連結就可以完成註冊。免費帳戶每星期包含 <strong>{words}</strong> 個傳譯字數；按月訂閱可以解除限制。',
  'login.sent': '請查收 {email} 嘅登入連結，{minutes} 分鐘內有效。',
  'login.devlink': '未設定郵件服務，登入連結喺呢度：<a href="{link}">登入</a>',
  'login.expired': '呢條登入連結已經過期或者用咗，請重新攞一條。',

  'app.title': '醫療傳譯',
  'app.setup': '應診設定',
  'app.specialty': '專科',
  'app.specialty.hint': '同時針對呢個專科優化語音識別同傳譯',
  'app.clinicianSpeaks': '醫護講',
  'app.patientSpeaks': '病人講',
  'app.swap': '對調兩種語言',
  'app.roleHint': '講嘢嗰方會根據每句話嘅語言自動判斷 — 要更正就㩒訊息上面嘅「醫護 / 病人」掣。',
  'app.export': '匯出',
  'app.clear': '清除',
  'app.empty': '揀好專科同兩種語言，然後㩒<strong>開始聆聽</strong>。<br>每句話都會被轉寫、歸到醫護定病人，再傳譯成另一種語言。',

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
  'app.turn.interpreted': '{lang} · 傳譯',
  'app.turn.failed': '轉寫失敗：{message}',
  'app.turn.whoSpoke': '呢句話邊個講',
  'app.turn.isSpeaker': '本句嘅講者',
  'app.turn.reassign': '改為呢一方並重新傳譯',
  'app.turn.substituted': '⚠ 識別結果係{detected}，已當作{used}處理',
  'app.turn.deviation': '⚠ 聽落似{detected}，預期係{expected}',
  'app.turn.sameLang': '雙方都係講{lang} — 唔使傳譯。',
  'app.turn.readAloud': '朗讀',
  'app.numbers': '請核對數字：<b>{missing}</b> 喺原話出現過，但傳譯入面冇。有啲語言會用文字寫數字，執行之前請先確認。',
  'app.export.empty': '暫時冇嘢可以匯出',

  'app.plan.free': '免費方案',
  'app.plan.pro': '無限字數',
  'app.quota.left': '今個星期仲有 {remaining} / {limit} 字',
  'app.quota.hint': '滾動七日視窗：每個字喺講出七日之後就唔再計。',
  'app.quota.resets': ' 部分額度會喺 {when} 回復。',
  'app.quota.spent': '<strong>今個星期嘅免費額度用晒喇。</strong>傳譯暫停，要等滾動視窗釋放額度。{when}',
  'app.quota.reached': '已達每星期字數上限',
  'app.upgrade': '訂閱解除限制',
  'app.manage': '管理訂閱',
  'app.logout': '登出',
  'app.err.billing': '帳單：{message}',
  'app.err.tts': '語音合成：{message}',
  'app.err.config': '設定載入失敗：{message}',
};

STRINGS.es = {
  'brand': 'Intérprete Médico',
  'lang.label': 'Idioma',
  'common.clinician': 'Personal clínico',
  'common.patient': 'Paciente',

  'home.title': 'Intérprete Médico: interpretación en tiempo real para consultas',
  'nav.how': 'Cómo funciona',
  'nav.features': 'Funciones',
  'nav.pricing': 'Precios',
  'nav.faq': 'Preguntas',
  'nav.signin': 'Iniciar sesión',
  'nav.start': 'Empezar gratis',
  'nav.open': 'Abrir el intérprete',

  'hero.eyebrow': '🎙️ Hable con normalidad: interpreta en ambos sentidos',
  'hero.h1': 'Cada palabra de su paciente, en un idioma <span class="hl">que ambos entiendan</span>.',
  'hero.lede': 'Interpretación en directo para una consulta bilingüe. Cada intervención se transcribe mientras se habla, se limpia de los tropiezos que nadie pretende decir y se traslada al idioma de la otra persona, conservando intactos los números, las negaciones y la lateralidad de los que depende el significado clínico.',
  'hero.seehow': 'Ver cómo funciona',
  'hero.note': 'Las cuentas nuevas empiezan en el plan gratuito: <strong>{words}</strong> palabras interpretadas por semana, sin tarjeta.',
  'shot.bar': 'Escuchando · Cardiología · Inglés ↔ Español',
  'shot.dir.cp': 'Inglés → Español',
  'shot.dir.pc': 'Español → Inglés',
  'shot.said1': 'Start Lasix, 40 milligrams every morning, and stop the fluid pills you were taking.',
  'shot.rendered1': 'Empiece a tomar Lasix, 40 miligramos todas las mañanas, y deje las pastillas para el líquido que estaba tomando.',
  'shot.said2': 'No he tomado nada desde el jueves porque me daba mareos.',
  'shot.rendered2': 'I haven’t taken anything since Thursday because it was making me dizzy.',
  'shot.flag': 'Cada cifra pronunciada se coteja con la interpretación.',

  'how.h2': 'Tres pasos y después no estorba',
  'how.lede': 'Sin auricular que pasarse, sin llamar a un tercero, sin instalar nada en el teléfono del paciente.',
  'how.1.h': 'Elija los idiomas',
  'how.1.p': 'Seleccione el idioma del equipo clínico, el del paciente y la especialidad de la consulta. Ambas partes comparten una sola pantalla.',
  'how.2.h': 'Hable con normalidad',
  'how.2.p': 'Un detector de voz que se ejecuta en su navegador reconoce cuándo alguien empieza y termina de hablar, así que no se envía nada mientras la sala está en silencio y nadie tiene que mantener pulsado un botón.',
  'how.3.h': 'Léalo o escúchelo',
  'how.3.p': 'Cada intervención aparece en ambos idiomas en uno o dos segundos y puede leerse en voz alta con una voz distinta para cada lado. La transcripción se exporta como archivo con marcas de tiempo.',

  'feat.h2': 'Pensado para donde se pierde el significado clínico',
  'feat.lede': 'Un traductor general busca una frase fluida. Un intérprete tiene que buscar que nada se añada, se pierda ni se suavice, que es un objetivo distinto y a veces menos elegante.',
  'feat.doses.h': 'Las dosis se mantienen intactas',
  'feat.doses.p': 'Cifras, unidades, vías, frecuencias y duraciones se reproducen exactamente: nunca se convierten entre sistemas, nunca se redondean, nunca se vuelven «unos pocos». Cualquier cifra que falte en la interpretación se señala para revisarla.',
  'feat.neg.h': 'La negación sigue siendo negación',
  'feat.neg.p': '«Sin fiebre», «no es alérgico», «nunca ha fumado», «no lo tome con comida» no pueden salir del otro lado como lo contrario, y una afirmación no puede adquirir un «no».',
  'feat.side.h': 'Izquierda sigue siendo izquierda',
  'feat.side.p': 'La lateralidad y la localización anatómica se reproducen con exactitud y nunca se omiten para que la frase suene mejor.',
  'feat.spec.h': '19 especialidades',
  'feat.spec.p': 'Cardiología, oncología, ginecología y obstetricia, psiquiatría, farmacia, anestesia y más, cada una con su terminología y sus confusiones propias: unidades frente a mililitros en insulina, en qué ojo van las gotas, intención curativa frente a paliativa.',
  'feat.mishear.h': 'Se reparan los errores de audición',
  'feat.mishear.p': 'El reconocimiento de voz escribe <code>lay six</code> donde el clínico dijo Lasix. El intérprete conoce el vocabulario de la especialidad y restituye el término correcto, sin «corregir» jamás una cifra, que no tiene contexto del que recuperarse.',
  'feat.uncert.h': 'La incertidumbre se conserva',
  'feat.uncert.p': '«Podría ser», «creemos», «hay que descartar» siguen siendo tentativos, y lo afirmado sigue siendo firme. Sobre esa distinción se sostiene el consentimiento del paciente.',
  'feat.langs.h': '25 idiomas',
  'feat.langs.p': 'Español, mandarín, cantonés de Hong Kong, vietnamita, tagalo, coreano, árabe, criollo haitiano, somalí y más, cada uno expresado como se habla realmente en la sanidad de ese idioma.',
  'feat.disfl.h': 'Se quitan las muletillas, se mantiene el sentido',
  'feat.disfl.p': 'Muletillas, tartamudeos y frases abandonadas desaparecen; las autocorrecciones se resuelven en lo que la persona quiso decir. Al pulir no se toca ninguna cifra, nombre de fármaco, negación ni parte del cuerpo.',
  'feat.privacy.h': 'Aquí no se guarda nada',
  'feat.privacy.p': 'El servidor no almacena grabaciones ni transcripciones. La conversación vive en la pestaña de su navegador hasta que la borre o la exporte. Lo que sí guardamos es su correo electrónico y si está suscrito.',

  'pricing.h2': 'Empiece gratis. Suscríbase cuando se le quede corto.',
  'pricing.lede': 'Ambos planes son el mismo intérprete: todas las especialidades, todos los idiomas, todas las reglas de seguridad. La única diferencia es cuánto puede hablar.',
  'plan.free.tag': 'Aquí empieza',
  'plan.free.name': 'Gratis',
  'plan.free.price': '0 €',
  'plan.free.per': ' / para siempre',
  'plan.free.sub': 'Sin tarjeta ni cuenta atrás de prueba. Al registrarse entra en este plan.',
  'plan.free.f1': '<strong>{words}</strong> palabras interpretadas por semana',
  'plan.free.f2': 'Una ventana <strong>móvil</strong> de siete días: las palabras se liberan al caducar, sin día de reinicio que esperar',
  'plan.free.f3': 'Las 19 especialidades y los 25 idiomas',
  'plan.free.f4': 'Todas las reglas de seguridad, la comprobación de cifras y la reparación de errores de audición',
  'plan.free.f5': 'Lectura en voz alta y exportación de la transcripción',
  'plan.free.cta': 'Crear una cuenta gratuita',
  'plan.free.foot': 'Ambos lados de la conversación cuentan para las palabras semanales.',
  'plan.pro.tag': 'Para uso habitual',
  'plan.pro.name': 'Ilimitado',
  'plan.pro.price': 'Mensual',
  'plan.pro.sub': 'Facturación mensual mediante Stripe. Cancele cuando quiera.',
  'plan.pro.f1': 'Palabras interpretadas <strong>ilimitadas</strong>, sin tope semanal',
  'plan.pro.f2': 'Todo lo del plan gratuito, sin cambios',
  'plan.pro.f3': 'Jornadas completas de consulta sin mirar un contador',
  'plan.pro.f4': 'Gestione la tarjeta o cancele usted mismo, desde la aplicación',
  'plan.pro.f5': 'El acceso continúa mientras se reintenta un cobro',
  'plan.pro.cta': 'Empiece gratis y mejore después',
  'plan.pro.foot': 'Podrá mejorar el plan desde la aplicación una vez tenga cuenta.',
  'plan.pro.off': 'Aún no disponible',
  'plan.pro.offsub': 'Las suscripciones no están habilitadas en esta instalación.',
  'plan.pro.offfoot': 'Por ahora todas las cuentas permanecen en el plan gratuito.',
  'plan.pro.upgrade': 'Mejorar desde la aplicación',

  'faq.h2': 'Preguntas que conviene hacerse antes',
  'faq.q1': '¿Qué cuenta como palabra?',
  'faq.a1': 'Las palabras que se pronuncian realmente, contadas una vez por intervención al transcribirlas, hable quien hable. Las interpretaciones no cuestan: una frase cuesta lo mismo tanto si el otro idioma necesita tres palabras como treinta, y leerla en voz alta no consume nada. Los idiomas que no separan palabras con espacios, como el chino y el japonés, se cuentan carácter a carácter.',
  'faq.q2': '¿Qué significa que el límite semanal sea «móvil»?',
  'faq.a2': 'El uso se cuenta hacia atrás desde este mismo instante a lo largo de siete días, en lugar de reiniciarse un día fijo. Una consulta larga del lunes deja de contar el lunes siguiente, y su asignación vuelve poco a poco en vez de de golpe. No hay una hora de reinicio que esperar ni nada que planificar.',
  'faq.q3': '¿Sustituye a un intérprete médico cualificado?',
  'faq.a3': 'No, y no debe tratarse como tal. Es un intérprete automático: rápido, disponible a cualquier hora y sin que nadie lo revise antes de que usted lo lea. Para el consentimiento informado, para dar malas noticias y para cualquier situación en la que un error de traducción cambiaría aquello a lo que alguien accede, recurra a un intérprete humano cualificado. Contraste cualquier contenido clínico con el original antes de actuar o de registrarlo.',
  'faq.q4': '¿Qué ocurre con el audio y la transcripción?',
  'faq.a4': 'La voz se envía a los servicios de reconocimiento y de lenguaje que esta instalación tenga configurados, y vuelve el texto interpretado. Este servidor no conserva ni el audio ni la transcripción: la conversación vive en la pestaña de su navegador hasta que la borre o la exporte. De su cuenta guardamos el correo, el estado de la suscripción y cuántas palabras consumió cada intervención.',
  'faq.q5': '¿Cómo inicio sesión?',
  'faq.a5': 'Con su correo electrónico. Le enviamos un enlace, lo pulsa y ya está dentro: no hay contraseña que elegir, olvidar ni que le roben. Ese mismo enlace crea su cuenta la primera vez, y cada enlace funciona una sola vez.',
  'faq.q6': '¿Puedo cancelar cuando quiera?',
  'faq.a6': 'Sí. Las suscripciones se gestionan en el portal de facturación de Stripe, accesible desde la barra de cuenta dentro de la aplicación, y la cancelación surte efecto sin hablar con nadie. Su cuenta vuelve entonces al plan gratuito en lugar de desaparecer.',
  'faq.q7': '¿Funciona en un móvil o una tableta junto a la cama?',
  'faq.a7': 'Sí: funciona en el navegador sin instalar nada, y la pantalla se mantiene encendida mientras la sesión está abierta. El navegador solo concede acceso al micrófono por HTTPS, así que use la dirección segura de su instalación.',

  'cta.h2': 'Pruébelo en su próxima consulta bilingüe',
  'cta.p': 'Basta un correo electrónico. Estará en el plan gratuito en menos de un minuto.',
  'foot.disclaimer': 'La interpretación automática es una ayuda para un encuentro bilingüe, no una interpretación médica certificada, y nadie revisa su resultado antes de que usted lo vea. Contraste cualquier contenido clínico con el original antes de actuar o de registrarlo.',

  'login.title': 'Iniciar sesión · Intérprete Médico',
  'login.lede': 'Interpretación en tiempo real entre un paciente y su equipo clínico. Escriba su correo y le enviaremos un enlace de acceso: no hay contraseña que elegir ni que olvidar.',
  'login.email': 'Correo electrónico',
  'login.placeholder': 'usted@clinica.org',
  'login.submit': 'Enviarme un enlace de acceso',
  'login.sending': 'Enviando…',
  'login.foot': '¿Es nuevo? El mismo enlace le da de alta. Las cuentas gratuitas incluyen <strong>{words}</strong> palabras interpretadas por semana; la suscripción mensual quita el límite.',
  'login.sent': 'Busque en {email} un enlace de acceso. Caduca en {minutes} minutos.',
  'login.devlink': 'No hay proveedor de correo configurado, así que aquí tiene su enlace: <a href="{link}">iniciar sesión</a>',
  'login.expired': 'Ese enlace de acceso ha caducado o ya se usó. Solicite uno nuevo.',

  'app.title': 'Intérprete Médico',
  'app.setup': 'Configuración de la consulta',
  'app.specialty': 'Especialidad',
  'app.specialty.hint': 'Ajusta a este campo tanto el reconocimiento de voz como la interpretación',
  'app.clinicianSpeaks': 'El personal clínico habla',
  'app.patientSpeaks': 'El paciente habla',
  'app.swap': 'Intercambiar los dos idiomas',
  'app.roleHint': 'Quién habla se deduce del idioma de cada intervención; use los botones Personal clínico/Paciente de un mensaje para corregirlo.',
  'app.export': 'Exportar',
  'app.clear': 'Borrar',
  'app.empty': 'Elija la especialidad y los dos idiomas y pulse <strong>Empezar a escuchar</strong>.<br>Cada intervención se transcribe, se atribuye al personal clínico o al paciente y se interpreta al otro idioma.',

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
  'app.turn.interpreted': '{lang} · interpretado',
  'app.turn.failed': 'Fallo al transcribir: {message}',
  'app.turn.whoSpoke': 'Quién habló en esta intervención',
  'app.turn.isSpeaker': 'Quien habla en esta intervención',
  'app.turn.reassign': 'Reasignar esta intervención y volver a interpretar',
  'app.turn.substituted': '⚠ el reconocedor dijo {detected}; tratado como {used}',
  'app.turn.deviation': '⚠ suena a {detected}, se esperaba {expected}',
  'app.turn.sameLang': 'Ambas partes hablan {lang}: no hay nada que interpretar.',
  'app.turn.readAloud': 'Leer en voz alta',
  'app.numbers': 'Compruebe las cifras: <b>{missing}</b> aparecía en lo dicho pero no en la interpretación. Algunos idiomas escriben las cifras con letras; confírmelo antes de actuar.',
  'app.export.empty': 'Todavía no hay nada que exportar',

  'app.plan.free': 'Plan gratuito',
  'app.plan.pro': 'Ilimitado',
  'app.quota.left': 'Quedan {remaining} de {limit} palabras esta semana',
  'app.quota.hint': 'Ventana móvil de siete días: las palabras dejan de contar siete días después de decirse.',
  'app.quota.resets': ' Parte de la asignación vuelve el {when}.',
  'app.quota.spent': '<strong>La asignación gratuita de esta semana se ha agotado.</strong> La interpretación queda en pausa hasta que la ventana móvil libere palabras. {when}',
  'app.quota.reached': 'Límite semanal de palabras alcanzado',
  'app.upgrade': 'Suscribirse para ilimitado',
  'app.manage': 'Gestionar la suscripción',
  'app.logout': 'Cerrar sesión',
  'app.err.billing': 'Facturación: {message}',
  'app.err.tts': 'Voz: {message}',
  'app.err.config': 'No se pudo cargar la configuración: {message}',
};

STRINGS.ko = {
  'brand': '의료 통역',
  'lang.label': '언어',
  'common.clinician': '의료진',
  'common.patient': '환자',

  'home.title': '의료 통역 — 진료 현장을 위한 실시간 통역',
  'nav.how': '이용 방법',
  'nav.features': '기능',
  'nav.pricing': '요금',
  'nav.faq': '자주 묻는 질문',
  'nav.signin': '로그인',
  'nav.start': '무료로 시작',
  'nav.open': '통역 화면 열기',

  'hero.eyebrow': '🎙️ 평소처럼 말하세요 — 양방향으로 통역합니다',
  'hero.h1': '환자의 모든 말을 <span class="hl">두 분 모두 아는 언어</span>로.',
  'hero.lede': '이중 언어 진료를 위한 실시간 통역입니다. 말하는 즉시 받아쓰고, 의도하지 않은 군더더기를 걷어낸 뒤 상대의 언어로 옮깁니다. 임상적 의미를 좌우하는 숫자와 부정 표현, 좌우 구분은 그대로 지킵니다.',
  'hero.seehow': '이용 방법 보기',
  'hero.note': '새 계정은 무료 요금제로 시작합니다 — 주당 <strong>{words}</strong> 단어, 카드 등록 없이.',
  'shot.bar': '듣는 중 · 심장내과 · 영어 ↔ 스페인어',
  'shot.dir.cp': '영어 → 스페인어',
  'shot.dir.pc': '스페인어 → 영어',
  'shot.said1': '라식스(Lasix)를 매일 아침 40밀리그램 복용하시고, 드시던 이뇨제는 중단하세요.',
  'shot.rendered1': 'Empiece a tomar Lasix, 40 miligramos todas las mañanas, y deje las pastillas para el líquido que estaba tomando.',
  'shot.said2': 'No he tomado nada desde el jueves porque me daba mareos.',
  'shot.rendered2': '어지러워서 목요일부터는 아무것도 먹지 않았어요.',
  'shot.flag': '말한 모든 숫자를 통역 결과와 대조합니다.',

  'how.h2': '세 단계면 끝, 그다음엔 방해하지 않습니다',
  'how.lede': '수화기를 주고받을 필요도, 제삼자에게 전화할 필요도, 환자 휴대폰에 무언가를 설치할 필요도 없습니다.',
  'how.1.h': '언어를 고릅니다',
  'how.1.p': '의료진이 쓰는 언어, 환자가 쓰는 언어, 그리고 이번 진료의 진료과를 선택합니다. 양쪽이 한 화면을 함께 봅니다.',
  'how.2.h': '평소처럼 말합니다',
  'how.2.p': '브라우저에서 동작하는 음성 감지가 말이 시작되고 끝나는 지점을 알아채므로, 조용할 때는 아무것도 전송되지 않고 버튼을 누르고 있을 필요도 없습니다.',
  'how.3.h': '읽거나 들려줍니다',
  'how.3.p': '각 발화가 1~2초 안에 두 언어로 표시되고, 양쪽을 서로 다른 목소리로 읽어 줄 수 있습니다. 기록은 시간이 표시된 파일로 내보낼 수 있습니다.',

  'feat.h2': '임상적 의미가 사라지는 지점을 겨냥해 만들었습니다',
  'feat.lede': '일반 번역기는 매끄러운 문장을 목표로 합니다. 통역은 아무것도 더해지거나 빠지거나 누그러지지 않는 것을 목표로 해야 하며, 이는 다른 목표이자 때로는 덜 우아한 목표입니다.',
  'feat.doses.h': '용량은 그대로 남습니다',
  'feat.doses.p': '숫자, 단위, 투여 경로, 횟수, 기간을 그대로 옮깁니다. 단위를 환산하지 않고, 반올림하지 않으며, "조금"으로 바꾸지 않습니다. 통역에서 빠진 숫자는 재확인하도록 표시됩니다.',
  'feat.neg.h': '부정은 부정으로',
  'feat.neg.p': '"열은 없다", "알레르기가 없다", "담배를 피운 적 없다", "음식과 함께 드시지 마세요"가 반대 뜻으로 나갈 수 없고, 긍정문에 "않다"가 붙지도 않습니다.',
  'feat.side.h': '왼쪽은 왼쪽 그대로',
  'feat.side.p': '좌우와 해부학적 부위를 정확히 옮기며, 문장을 매끄럽게 하려고 생략하지 않습니다.',
  'feat.spec.h': '19개 진료과',
  'feat.spec.p': '심장내과, 종양내과, 산부인과, 정신건강의학과, 약제, 마취 등 각 과의 용어와 혼동 지점을 담았습니다 — 인슐린의 단위와 밀리리터, 어느 쪽 눈에 넣는 안약인지, 완치 목적인지 완화 목적인지.',
  'feat.mishear.h': '잘못 들은 말을 바로잡습니다',
  'feat.mishear.p': '의료진은 Lasix라고 말했는데 음성 인식은 <code>lay six</code>로 적습니다. 시스템은 해당 진료과의 어휘를 알고 원래 용어로 되돌립니다. 다만 숫자는 되살릴 문맥이 없으므로 절대 "고치지" 않습니다.',
  'feat.uncert.h': '불확실함은 불확실한 대로',
  'feat.uncert.p': '"일 수도 있다", "저희 생각에는", "배제해 봐야 한다"는 추정으로 남고, 단정적인 말은 단정적으로 남습니다. 환자의 동의는 바로 이 차이 위에 성립합니다.',
  'feat.langs.h': '25개 언어',
  'feat.langs.p': '스페인어, 중국어, 홍콩 광둥어, 베트남어, 타갈로그어, 한국어, 아랍어, 아이티 크리올어, 소말리어 등 — 각 언어의 의료 현장에서 실제로 쓰는 말투로 옮깁니다.',
  'feat.disfl.h': '군더더기는 덜고 의미는 남깁니다',
  'feat.disfl.p': '군말과 더듬은 부분, 하다 만 말은 걷어내고, 스스로 고쳐 말한 경우 최종적으로 말한 쪽만 남깁니다. 다듬는 과정에서 숫자, 약 이름, 부정 표현, 신체 부위는 건드리지 않습니다.',
  'feat.privacy.h': '서버에는 남지 않습니다',
  'feat.privacy.p': '서버는 녹음도 대화 기록도 저장하지 않습니다. 대화는 지우거나 내보내기 전까지 브라우저 탭 안에만 있습니다. 저장하는 것은 이메일 주소와 구독 여부뿐입니다.',

  'pricing.h2': '무료로 시작하고, 부족해지면 구독하세요.',
  'pricing.lede': '두 요금제 모두 같은 통역입니다. 모든 진료과, 모든 언어, 모든 안전 규칙이 동일하며 차이는 얼마나 말할 수 있는지뿐입니다.',
  'plan.free.tag': '여기서 시작합니다',
  'plan.free.name': '무료',
  'plan.free.price': '₩0',
  'plan.free.per': ' / 계속',
  'plan.free.sub': '카드도, 체험 기간 카운트다운도 없습니다. 가입하면 이 요금제입니다.',
  'plan.free.f1': '주당 <strong>{words}</strong> 단어 통역',
  'plan.free.f2': '<strong>슬라이딩</strong> 7일 기준 — 오래된 단어부터 자동으로 풀리며, 기다려야 할 초기화 날짜가 없습니다',
  'plan.free.f3': '19개 진료과와 25개 언어 전부',
  'plan.free.f4': '모든 안전 규칙, 숫자 확인, 오인식 교정',
  'plan.free.f5': '소리 내어 읽기와 기록 내보내기',
  'plan.free.cta': '무료 계정 만들기',
  'plan.free.foot': '대화 양쪽의 말이 모두 주간 단어 수에 포함됩니다.',
  'plan.pro.tag': '상시 사용에 적합',
  'plan.pro.name': '무제한',
  'plan.pro.price': '월 구독',
  'plan.pro.sub': 'Stripe를 통해 매월 결제되며 언제든 해지할 수 있습니다.',
  'plan.pro.f1': '통역 단어 <strong>무제한</strong> — 주간 상한 없음',
  'plan.pro.f2': '무료 요금제의 모든 기능 그대로',
  'plan.pro.f3': '카운터를 신경 쓰지 않고 하루 진료를 그대로',
  'plan.pro.f4': '앱 안에서 직접 카드 변경이나 해지',
  'plan.pro.f5': '결제 재시도 중에도 이용이 끊기지 않습니다',
  'plan.pro.cta': '무료로 시작하고 나중에 전환',
  'plan.pro.foot': '계정을 만든 뒤 앱 안에서 전환할 수 있습니다.',
  'plan.pro.off': '아직 제공되지 않음',
  'plan.pro.offsub': '이 설치본에서는 구독이 활성화되어 있지 않습니다.',
  'plan.pro.offfoot': '현재 모든 계정이 무료 요금제로 유지됩니다.',
  'plan.pro.upgrade': '앱에서 전환하기',

  'faq.h2': '먼저 짚어 볼 만한 질문',
  'faq.q1': '무엇을 한 단어로 세나요?',
  'faq.a1': '실제로 말한 단어만, 받아쓸 때 발화당 한 번 셉니다. 누가 말했든 동일합니다. 통역 결과는 세지 않습니다. 한 문장이 상대 언어에서 세 단어가 되든 서른 단어가 되든 소모량은 같고, 소리 내어 읽는 것도 소모하지 않습니다. 중국어나 일본어처럼 단어를 띄어 쓰지 않는 언어는 글자 단위로 셉니다.',
  'faq.q2': '주간 한도가 "슬라이딩"이라는 것은 무슨 뜻인가요?',
  'faq.a2': '정해진 요일에 초기화되는 대신, 지금 이 순간부터 7일을 거슬러 올라가 사용량을 셉니다. 월요일의 긴 진료는 다음 월요일이 되면 더 이상 세지 않으며, 한도는 한꺼번에가 아니라 조금씩 돌아옵니다. 기다려야 할 초기화 시각도, 따로 계획할 것도 없습니다.',
  'faq.q3': '자격을 갖춘 의료 통역사를 대체하나요?',
  'faq.a3': '아닙니다. 그렇게 취급해서도 안 됩니다. 이것은 기계 통역이며, 빠르고 언제든 쓸 수 있지만 여러분이 읽기 전에 아무도 검토하지 않습니다. 동의 취득, 나쁜 소식 전달처럼 오역이 상대가 동의하는 내용을 바꿀 수 있는 상황에서는 자격을 갖춘 사람 통역사를 이용하세요. 임상적인 내용은 실행하거나 기록에 남기기 전에 원문과 대조하십시오.',
  'faq.q4': '음성과 대화 기록은 어떻게 되나요?',
  'faq.a4': '음성은 이 설치본에 설정된 음성 인식·언어 서비스로 전송되고 통역된 텍스트가 돌아옵니다. 이 서버는 음성도 기록도 보관하지 않습니다. 대화는 지우거나 내보내기 전까지 브라우저 탭 안에만 있습니다. 계정에 남는 것은 이메일 주소, 구독 상태, 그리고 각 발화가 사용한 단어 수입니다.',
  'faq.q5': '어떻게 로그인하나요?',
  'faq.a5': '이메일 주소로 합니다. 링크를 보내드리면 눌러서 바로 들어옵니다. 정하거나 잊어버리거나 도난당할 비밀번호가 없습니다. 처음 사용할 때 같은 링크가 계정을 만들어 주며, 각 링크는 한 번만 작동합니다.',
  'faq.q6': '언제든 해지할 수 있나요?',
  'faq.a6': '네. 구독은 Stripe 결제 포털에서 관리하며 앱 안 계정 표시줄에서 바로 들어갈 수 있고, 누구에게 연락하지 않아도 해지됩니다. 해지 후 계정은 사라지지 않고 무료 요금제로 돌아갑니다.',
  'faq.q7': '병상 옆에서 휴대폰이나 태블릿으로 쓸 수 있나요?',
  'faq.a7': '네. 설치 없이 브라우저에서 동작하고, 세션이 열려 있는 동안 화면이 꺼지지 않습니다. 브라우저는 HTTPS에서만 마이크를 허용하므로 설치본의 보안 주소를 사용하세요.',

  'cta.h2': '다음 이중 언어 진료에서 사용해 보세요',
  'cta.p': '이메일 주소 하나면 됩니다. 1분 안에 무료 요금제로 시작합니다.',
  'foot.disclaimer': '기계 통역은 이중 언어 진료를 돕는 보조 수단이며, 자격을 갖춘 의료 통역이 아니고, 여러분이 보기 전에 사람이 검토하지 않습니다. 임상적인 내용은 실행하거나 기록에 남기기 전에 원문과 대조하십시오.',

  'login.title': '로그인 · 의료 통역',
  'login.lede': '환자와 의료진 사이의 실시간 통역입니다. 이메일을 입력하시면 로그인 링크를 보내드립니다. 정하거나 잊을 비밀번호가 없습니다.',
  'login.email': '이메일 주소',
  'login.placeholder': 'you@clinic.org',
  'login.submit': '로그인 링크 보내기',
  'login.sending': '보내는 중…',
  'login.foot': '처음이신가요? 같은 링크로 가입까지 됩니다. 무료 계정은 주당 <strong>{words}</strong> 단어를 제공하며, 월 구독은 이 한도를 없앱니다.',
  'login.sent': '{email}에서 로그인 링크를 확인하세요. {minutes}분 후 만료됩니다.',
  'login.devlink': '메일 서비스가 설정되어 있지 않아 링크를 여기 드립니다: <a href="{link}">로그인</a>',
  'login.expired': '이 로그인 링크는 만료되었거나 이미 사용되었습니다. 새로 요청하세요.',

  'app.title': '의료 통역',
  'app.setup': '진료 설정',
  'app.specialty': '진료과',
  'app.specialty.hint': '음성 인식과 통역을 이 분야에 맞게 조정합니다',
  'app.clinicianSpeaks': '의료진 언어',
  'app.patientSpeaks': '환자 언어',
  'app.swap': '두 언어 바꾸기',
  'app.roleHint': '말한 사람은 각 발화의 언어로 판단합니다. 잘못되었으면 메시지의 「의료진 / 환자」 버튼으로 바로잡으세요.',
  'app.export': '내보내기',
  'app.clear': '지우기',
  'app.empty': '진료과와 두 언어를 고른 뒤 <strong>듣기 시작</strong>을 누르세요.<br>각 발화는 받아쓰기되어 의료진 또는 환자에게 귀속되고, 다른 언어로 통역됩니다.',

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
  'app.turn.interpreted': '{lang} · 통역',
  'app.turn.failed': '받아쓰기 실패: {message}',
  'app.turn.whoSpoke': '이 발화를 말한 사람',
  'app.turn.isSpeaker': '이 발화의 화자',
  'app.turn.reassign': '이 발화를 재지정하고 다시 통역',
  'app.turn.substituted': '⚠ 인식 결과는 {detected}였으나 {used}(으)로 처리했습니다',
  'app.turn.deviation': '⚠ {detected}처럼 들립니다. 예상 언어는 {expected}입니다',
  'app.turn.sameLang': '양쪽 모두 {lang}(으)로 말하고 있어 통역할 것이 없습니다.',
  'app.turn.readAloud': '소리 내어 읽기',
  'app.numbers': '숫자를 확인하세요: <b>{missing}</b>이(가) 말한 내용에는 있었지만 통역에는 없습니다. 숫자를 글자로 쓰는 언어도 있으니 실행 전에 확인하세요.',
  'app.export.empty': '아직 내보낼 내용이 없습니다',

  'app.plan.free': '무료 요금제',
  'app.plan.pro': '무제한',
  'app.quota.left': '이번 주 {limit} 단어 중 {remaining} 단어 남음',
  'app.quota.hint': '슬라이딩 7일 기준: 말한 지 7일이 지난 단어는 더 이상 세지 않습니다.',
  'app.quota.resets': ' {when}에 일부 한도가 돌아옵니다.',
  'app.quota.spent': '<strong>이번 주 무료 한도를 모두 사용했습니다.</strong> 슬라이딩 기간이 한도를 돌려줄 때까지 통역이 중단됩니다. {when}',
  'app.quota.reached': '주간 단어 한도에 도달했습니다',
  'app.upgrade': '구독하고 무제한 사용',
  'app.manage': '구독 관리',
  'app.logout': '로그아웃',
  'app.err.billing': '결제: {message}',
  'app.err.tts': '음성 합성: {message}',
  'app.err.config': '설정을 불러오지 못했습니다: {message}',
};

STRINGS.ja = {
  'brand': '医療通訳',
  'lang.label': '表示言語',
  'common.clinician': '医療者',
  'common.patient': '患者',

  'home.title': '医療通訳 — 診察の場のためのリアルタイム通訳',
  'nav.how': '使い方',
  'nav.features': '機能',
  'nav.pricing': '料金',
  'nav.faq': 'よくある質問',
  'nav.signin': 'ログイン',
  'nav.start': '無料で始める',
  'nav.open': '通訳画面を開く',

  'hero.eyebrow': '🎙️ ふだんどおり話すだけ — 双方向に通訳します',
  'hero.h1': '患者さんの一言一句を、<span class="hl">おたがいに分かる言葉</span>で。',
  'hero.lede': '二言語の診察のためのリアルタイム通訳です。話すそばから書き起こし、言うつもりのなかった言いよどみを取り除いて、相手の言語に移します。臨床的な意味を左右する数値・否定・左右の別は、そのまま保ちます。',
  'hero.seehow': '使い方を見る',
  'hero.note': '新規アカウントは無料プランから始まります — 週 <strong>{words}</strong> 語、カード登録は不要です。',
  'shot.bar': '受信中 · 循環器科 · 英語 ↔ スペイン語',
  'shot.dir.cp': '英語 → スペイン語',
  'shot.dir.pc': 'スペイン語 → 英語',
  'shot.said1': 'ラシックス（Lasix）を毎朝40ミリグラム開始し、これまでの利尿薬は中止してください。',
  'shot.rendered1': 'Empiece a tomar Lasix, 40 miligramos todas las mañanas, y deje las pastillas para el líquido que estaba tomando.',
  'shot.said2': 'No he tomado nada desde el jueves porque me daba mareos.',
  'shot.rendered2': 'めまいがしたので、木曜日から何も飲んでいません。',
  'shot.flag': '話された数値はすべて通訳結果と照合されます。',

  'how.h2': '設定は三つ、あとは邪魔をしません',
  'how.lede': '受話器を渡し合う必要も、第三者に電話する必要も、患者さんの端末に何かを入れる必要もありません。',
  'how.1.h': '言語を選ぶ',
  'how.1.p': '医療者側の言語、患者さん側の言語、そして今回の診療科を選びます。双方が一つの画面を見ます。',
  'how.2.h': 'ふだんどおり話す',
  'how.2.p': 'ブラウザ内で動く音声検出が、話し始めと話し終わりを見分けます。静かなあいだは何も送信されず、ボタンを押し続ける必要もありません。',
  'how.3.h': '読む、または聞く',
  'how.3.p': '各発話は一、二秒で両方の言語に表示され、双方を別々の声で読み上げられます。記録はタイムスタンプ付きのファイルとして書き出せます。',

  'feat.h2': '臨床的な意味が失われる場所に合わせて作りました',
  'feat.lede': '一般の翻訳はなめらかな文を目指します。通訳が目指すのは、足さない・落とさない・和らげないこと。目標が違い、ときに優雅さでは劣ります。',
  'feat.doses.h': '用量はそのまま残る',
  'feat.doses.p': '数値、単位、投与経路、回数、期間をそのまま再現します。単位を換算せず、丸めず、「少し」に置き換えません。通訳から抜け落ちた数値は、確認のために印が付きます。',
  'feat.neg.h': '否定は否定のまま',
  'feat.neg.p': '「熱はない」「アレルギーはない」「喫煙歴なし」「食後に飲まないでください」が反対の意味で出ることはなく、肯定文に「ない」が加わることもありません。',
  'feat.side.h': '左は左のまま',
  'feat.side.p': '左右の別と解剖学的部位を正確に再現し、文を自然にするために省くことはありません。',
  'feat.spec.h': '19の診療科',
  'feat.spec.p': '循環器科、腫瘍内科、産婦人科、精神科、薬剤、麻酔ほか。各科の用語と紛らわしい点を押さえています — インスリンの「単位」とミリリットル、点眼はどちらの目か、根治か緩和か。',
  'feat.mishear.h': '聞き違いを直す',
  'feat.mishear.p': '医師が Lasix と言っても、音声認識は <code>lay six</code> と書きます。本システムはその診療科の語彙を知っており、本来の用語に戻します。ただし数値は文脈から復元できないため、決して「訂正」しません。',
  'feat.uncert.h': '不確かさを保つ',
  'feat.uncert.p': '「かもしれない」「私たちの考えでは」「除外する必要がある」は推量のまま、断定は断定のまま残ります。患者さんの同意は、この違いの上に成り立っています。',
  'feat.langs.h': '25言語',
  'feat.langs.p': 'スペイン語、中国語、香港広東語、ベトナム語、タガログ語、韓国語、アラビア語、ハイチ・クレオール語、ソマリ語ほか。それぞれの言語の医療現場で実際に使われる言い方で表現します。',
  'feat.disfl.h': '言いよどみは削り、意味は残す',
  'feat.disfl.p': 'フィラーや言い直し、途中でやめた言い回しは取り除き、言い直した場合は最終的に言い切った内容だけを残します。整える過程で数値・薬剤名・否定・身体部位には手を触れません。',
  'feat.privacy.h': 'サーバーには残りません',
  'feat.privacy.p': 'サーバーは録音も書き起こしも保存しません。会話は消すか書き出すまで、ブラウザのタブの中だけにあります。保存するのはメールアドレスと購読状態だけです。',

  'pricing.h2': '無料で始め、足りなくなったら購読を。',
  'pricing.lede': 'どちらのプランも同じ通訳です。すべての診療科、すべての言語、すべての安全規則が同じで、違いは話せる量だけです。',
  'plan.free.tag': 'ここから始まります',
  'plan.free.name': '無料',
  'plan.free.price': '¥0',
  'plan.free.per': ' / ずっと',
  'plan.free.sub': 'カード不要、試用期間のカウントダウンもありません。登録するとこのプランになります。',
  'plan.free.f1': '週 <strong>{words}</strong> 語の通訳',
  'plan.free.f2': '<strong>ローリング</strong>7日間 — 古い語から自動的に戻り、待つべきリセット日はありません',
  'plan.free.f3': '19診療科と25言語のすべて',
  'plan.free.f4': 'すべての安全規則、数値の照合、聞き違いの修復',
  'plan.free.f5': '読み上げと記録の書き出し',
  'plan.free.cta': '無料アカウントを作成',
  'plan.free.foot': '会話の双方の語数が週の上限に算入されます。',
  'plan.pro.tag': '日常的に使う方へ',
  'plan.pro.name': '無制限',
  'plan.pro.price': '月額',
  'plan.pro.sub': 'Stripe で毎月請求されます。いつでも解約できます。',
  'plan.pro.f1': '通訳語数は<strong>無制限</strong> — 週の上限なし',
  'plan.pro.f2': '無料プランの内容はそのまま',
  'plan.pro.f3': 'カウンターを気にせず一日の外来を通して',
  'plan.pro.f4': 'カードの変更も解約もアプリ内でご自身で',
  'plan.pro.f5': '決済の再試行中も利用は止まりません',
  'plan.pro.cta': 'まず無料で、あとから切り替え',
  'plan.pro.foot': 'アカウント作成後、アプリ内で切り替えられます。',
  'plan.pro.off': '現在ご利用いただけません',
  'plan.pro.offsub': 'この環境では購読が有効になっていません。',
  'plan.pro.offfoot': '現在すべてのアカウントが無料プランのままです。',
  'plan.pro.upgrade': 'アプリ内で切り替える',

  'faq.h2': '先に確かめておきたいこと',
  'faq.q1': '何を1語として数えますか？',
  'faq.a1': '実際に話された言葉だけを、書き起こしの時点で発話ごとに一度数えます。どちらが話しても同じです。通訳結果は数えません。一つの文が相手の言語で3語になっても30語になっても消費は同じで、読み上げも消費しません。中国語や日本語のように語を空白で区切らない言語は、文字単位で数えます。',
  'faq.q2': '週の上限が「ローリング」とはどういう意味ですか？',
  'faq.a2': '決まった曜日にリセットするのではなく、今この瞬間から7日さかのぼって使用量を数えます。月曜の長い診察は翌週の月曜には数えられなくなり、上限は一度にではなく少しずつ戻ります。待つべきリセット時刻も、計画すべきこともありません。',
  'faq.q3': '有資格の医療通訳者の代わりになりますか？',
  'faq.a3': 'なりませんし、代わりとして扱うべきでもありません。これは機械通訳です。速く、いつでも使えますが、ご覧になる前に誰も確認していません。同意の取得、悪い知らせを伝える場面など、誤訳が相手の同意内容を変えてしまう場面では、有資格の人の通訳者をご利用ください。臨床的な内容は、実行や記録の前に原文と照合してください。',
  'faq.q4': '音声と書き起こしはどうなりますか？',
  'faq.a4': '音声はこの環境に設定された音声認識・言語サービスへ送られ、通訳されたテキストが返ります。本サーバーは音声も書き起こしも保持しません。会話は消すか書き出すまでブラウザのタブの中だけにあります。アカウントに残るのは、メールアドレス、購読状態、各発話が使った語数です。',
  'faq.q5': 'ログインはどうしますか？',
  'faq.a5': 'メールアドレスで行います。リンクをお送りしますので、押せばそのまま入れます。決める必要も、忘れる心配も、盗まれる恐れもあるパスワードはありません。初回はそのリンクがアカウントを作成し、各リンクは一度だけ有効です。',
  'faq.q6': 'いつでも解約できますか？',
  'faq.a6': 'はい。購読は Stripe の請求ポータルで管理し、アプリ内のアカウント欄から開けます。解約は誰かに連絡しなくても反映されます。解約後、アカウントは消えるのではなく無料プランに戻ります。',
  'faq.q7': 'ベッドサイドでスマートフォンやタブレットでも使えますか？',
  'faq.a7': 'はい。インストール不要でブラウザから動き、セッション中は画面が消えません。ブラウザは HTTPS でのみマイクを許可するため、環境の安全なアドレスをお使いください。',

  'cta.h2': '次の二言語の診察で試してみてください',
  'cta.p': '必要なのはメールアドレスだけ。1分もかからず無料プランで始められます。',
  'foot.disclaimer': '機械通訳は二言語の診察を助ける手段であり、有資格の医療通訳ではありません。その出力はご覧になる前に人が確認していません。臨床的な内容は、実行や記録の前に原文と照合してください。',

  'login.title': 'ログイン · 医療通訳',
  'login.lede': '患者さんと医療チームのあいだのリアルタイム通訳です。メールアドレスを入力いただくと、ログイン用のリンクをお送りします。決めるパスワードも、忘れるパスワードもありません。',
  'login.email': 'メールアドレス',
  'login.placeholder': 'you@clinic.org',
  'login.submit': 'ログインリンクを送る',
  'login.sending': '送信中…',
  'login.foot': 'はじめてですか？ 同じリンクで登録も完了します。無料アカウントには週 <strong>{words}</strong> 語が含まれ、月額購読で上限がなくなります。',
  'login.sent': '{email} に届いたログインリンクをご確認ください。{minutes}分で期限切れになります。',
  'login.devlink': 'メールサービスが設定されていないため、リンクをここに表示します：<a href="{link}">ログイン</a>',
  'login.expired': 'このログインリンクは期限切れか、すでに使用済みです。新しく取得してください。',

  'app.title': '医療通訳',
  'app.setup': '診察の設定',
  'app.specialty': '診療科',
  'app.specialty.hint': '音声認識と通訳の両方をこの分野に合わせます',
  'app.clinicianSpeaks': '医療者の言語',
  'app.patientSpeaks': '患者の言語',
  'app.swap': '二つの言語を入れ替える',
  'app.roleHint': '話し手は各発話の言語から判定します。違っていれば、メッセージ上の「医療者 / 患者」ボタンで直してください。',
  'app.export': '書き出し',
  'app.clear': '消去',
  'app.empty': '診療科と二つの言語を選び、<strong>受信を開始</strong>を押してください。<br>各発話は書き起こされ、医療者か患者に割り当てられ、もう一方の言語に通訳されます。',

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
  'app.turn.interpreted': '{lang} · 通訳',
  'app.turn.failed': '書き起こしに失敗しました：{message}',
  'app.turn.whoSpoke': 'この発話を話した人',
  'app.turn.isSpeaker': 'この発話の話し手',
  'app.turn.reassign': 'この発話を割り当て直して通訳をやり直す',
  'app.turn.substituted': '⚠ 認識結果は{detected}でしたが、{used}として扱いました',
  'app.turn.deviation': '⚠ {detected}のように聞こえます。想定は{expected}です',
  'app.turn.sameLang': '双方とも{lang}で話しているため、通訳するものがありません。',
  'app.turn.readAloud': '読み上げる',
  'app.numbers': '数値をご確認ください：<b>{missing}</b> は発話にありましたが通訳にはありません。数値を文字で書く言語もあるため、実行前にご確認ください。',
  'app.export.empty': 'まだ書き出せる内容がありません',

  'app.plan.free': '無料プラン',
  'app.plan.pro': '無制限',
  'app.quota.left': '今週は {limit} 語中 {remaining} 語が残っています',
  'app.quota.hint': 'ローリング7日間：話してから7日が過ぎた語は数えられなくなります。',
  'app.quota.resets': ' {when} に一部の上限が戻ります。',
  'app.quota.spent': '<strong>今週の無料分を使い切りました。</strong>ローリング期間で上限が戻るまで通訳を停止します。{when}',
  'app.quota.reached': '週の語数上限に達しました',
  'app.upgrade': '購読して無制限に',
  'app.manage': '購読を管理',
  'app.logout': 'ログアウト',
  'app.err.billing': '請求：{message}',
  'app.err.tts': '音声合成：{message}',
  'app.err.config': '設定の読み込みに失敗しました：{message}',
};
