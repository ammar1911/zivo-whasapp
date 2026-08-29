// daiZ — WhatsApp production server (360dialog Cloud API + Claude API)
// -----------------------------------------------------------
// Minimal server for running a real WhatsApp service with a handful of
// families to start. No database, sessions live in memory (persisted to
// sessions.json on disk so a restart doesn't wipe everyone's progress).
// Good enough to test "does the teaching actually work" before investing
// in the full production backend.
//
// Content source: this shares the exact same knowledge base as the
// website (chat-route.js's KB/TOPICS/SUBJECTS) - one source of truth for
// both channels, by construction rather than by remembering to update both.
//
// WhatsApp provider: 360dialog's Cloud API (waba-v2.360dialog.io), not
// Twilio - see sendWhatsApp() and the webhook handler below. 360dialog
// speaks Meta's WhatsApp Cloud API message/webhook format directly, which
// is why the shapes here look like Meta's docs rather than Twilio's.
// Docs: docs.360dialog.com/docs/messaging/overview

const express = require("express");
const bodyParser = require("body-parser");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const chatRouter = require("./chat-route");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
// 360dialog's webhook body is JSON (Meta Cloud API format), not the
// form-encoded body Twilio used - both parsers are mounted since /api
// (chat-route.js) has its own expectations and multer handles the
// multipart image-upload case separately.
app.use(bodyParser.json());
app.use("/api", chatRouter);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// 360dialog authenticates with a single API key tied to your WABA/number -
// there's no separate "from" number to configure, unlike Twilio, since
// the key itself determines which number messages are sent from.
const D360_API_KEY = process.env.D360_API_KEY;
const D360_BASE_URL = "https://waba-v2.360dialog.io";

// Shared content + metadata, exported by chat-route.js - same data the
// website uses, so both channels always teach from the identical set.
const KB = chatRouter.KB;
const TOPICS = chatRouter.TOPICS;
const SUBJECTS = chatRouter.SUBJECTS;
const GRADES = chatRouter.GRADES;
const DOMAIN_AR = chatRouter.DOMAIN_AR;
const STUDENTS = chatRouter.STUDENTS;
const findUnitById = chatRouter.findUnitById;

function findUnit(topicMeta) {
  const idx = TOPICS.indexOf(topicMeta);
  return idx >= 0 ? KB.math_units[idx] : null;
}

// Subjects available per language track, mirroring the website's picker
// logic exactly (see /api/subjects in chat-route.js) - math/hebrew-grammar
// for Hebrew, arabic-grammar/hebrew-second-language/math-arabic for
// Arabic, english for both.
function subjectsForLang(lang) {
  return SUBJECTS.filter(s => (s.id === 'math' && lang === 'he')
    || (s.id === 'hebrew-grammar' && lang === 'he')
    || (s.id === 'arabic-grammar' && lang === 'ar')
    || (s.id === 'hebrew-second-language' && lang === 'ar')
    || (s.id === 'math-arabic' && lang === 'ar')
    || (s.id === 'english'));
}

function gradesForSubject(subjectObj) {
  return [...new Set(
    TOPICS
      .filter(t => { const u = KB.math_units[t.id]; return u && u.subject === subjectObj.kb_subject; })
      .map(t => t.grade)
  )].sort((a, b) => GRADES.indexOf(a) - GRADES.indexOf(b));
}

function topicsForSubjectGrade(subjectObj, grade) {
  return TOPICS.filter(t => {
    const u = KB.math_units[t.id];
    return u && u.subject === subjectObj.kb_subject && t.grade === grade;
  });
}

// ---- Abuse protection: message length cap + simple in-memory rate limit ----
// Same approach as chat-route.js's website endpoint - see the comment
// there for why in-memory is fine at this scale (single Node process).
const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX_REQUESTS = 30; // per window, per phone number
const rateLimitLog = new Map();

function checkRateLimit(identifier) {
  const now = Date.now();
  const timestamps = (rateLimitLog.get(identifier) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  rateLimitLog.set(identifier, timestamps);
  if (rateLimitLog.size > 5000) {
    for (const [key, times] of rateLimitLog) {
      if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) rateLimitLog.delete(key);
    }
  }
  return timestamps.length <= RATE_LIMIT_MAX_REQUESTS;
}

// ---- Very simple in-memory session store: phone number -> session state ----
// sessions.json is loaded/saved so a server restart during the trial doesn't
// wipe everyone's progress — good enough for a small trial, not a real DB.
const SESSIONS_FILE = "./sessions.json";
let sessions = fs.existsSync(SESSIONS_FILE) ? JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) : {};

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function newSession() {
  // weeklyLog is a SEPARATE, cross-topic record from history - it survives
  // topic/subject switches (unlike history, which resets on each switch -
  // see the menu-command handler below) so a student can ask "what did we
  // cover earlier this week" even after moving between several topics,
  // which matters most right when it matters most: exam week.
  return { stage: "ask_lang", lang: null, subject: null, grade: null, topic: null, history: [], weeklyLog: [] };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Hard cap independent of the time window - a very active student could
// rack up far more than a normal week's worth of messages; without a count
// cap the log (and therefore the token cost of every request) grows
// unbounded for as long as they keep chatting inside that same week.
const WEEKLY_LOG_MAX_ENTRIES = 80;

// Called once per incoming message, before anything else touches
// session.weeklyLog, so every code path (including ones added later) sees
// an already-pruned log rather than needing to remember to prune it itself.
function pruneWeeklyLog(session) {
  if (!Array.isArray(session.weeklyLog)) { session.weeklyLog = []; return; }
  const cutoff = Date.now() - WEEK_MS;
  session.weeklyLog = session.weeklyLog.filter(e => e.timestamp >= cutoff);
  if (session.weeklyLog.length > WEEKLY_LOG_MAX_ENTRIES) {
    session.weeklyLog = session.weeklyLog.slice(-WEEKLY_LOG_MAX_ENTRIES);
  }
}

// Builds the compact "what we covered this week" block injected into the
// system prompt. Grouped by topic so the model sees a clear timeline
// instead of one long undifferentiated transcript, and each message is
// truncated - full verbatim replay of a week's chat would be expensive
// and mostly redundant; a truncated excerpt is enough for the model to
// recognize and pick back up a specific earlier exchange when asked.
const WEEKLY_EXCERPT_MAX_CHARS = 160;
function buildWeeklyContextBlock(session, lang) {
  if (!session.weeklyLog || session.weeklyLog.length === 0) return '';
  const groups = [];
  let current = null;
  session.weeklyLog.forEach(e => {
    if (!current || current.topicName !== e.topicName) {
      current = { topicName: e.topicName, entries: [] };
      groups.push(current);
    }
    current.entries.push(e);
  });
  const dayFormatter = (ts) => new Date(ts).toLocaleDateString(lang === 'ar' ? 'ar' : 'he-IL', { month: 'numeric', day: 'numeric' });
  const lines = groups.map(g => {
    const header = `--- ${g.topicName} (${dayFormatter(g.entries[0].timestamp)}) ---`;
    const body = g.entries.map(e => {
      const who = e.role === 'user' ? (lang === 'ar' ? 'الطالب' : 'התלמיד') : (lang === 'ar' ? 'المعلّم' : 'המורה');
      const text = e.text.length > WEEKLY_EXCERPT_MAX_CHARS ? e.text.slice(0, WEEKLY_EXCERPT_MAX_CHARS) + '...' : e.text;
      return `${who}: ${text}`;
    }).join('\n');
    return header + '\n' + body;
  });
  const title = lang === 'ar'
    ? 'ملخص ما تمت مناقشته هذا الأسبوع (للرجوع إليه فقط - الموضوع الحالي هو الأساس):'
    : 'סיכום מה שנדון השבוע (לעיון בלבד - הנושא הנוכחי הוא הבסיס לשיחה):';
  return '\n\n' + title + '\n' + lines.join('\n\n');
}

const PERSONAS = {
  'מתמטיקה': { name: 'סוקרטס', role: 'מורה פרטי סבלני למתמטיקה' },
  'ערבית': { name: 'المتنبي', role: 'معلّم خاص صبور لقواعد اللغة العربية' },
  'עברית': { name: 'המורה', role: 'מורה פרטי סבלני לדקדוק עברי' },
  'עברית כשפה שנייה': { name: 'المعلّم', role: 'معلّم خاص صبور للعبرية كلغة ثانية للناطقين بالعربية' },
  'الرياضيات': { name: 'سقراط', role: 'معلّم خاص صبور للرياضيات' },
  'אנגלית': {
    he: { name: 'טומאס', role: 'מורה פרטי סבלני לאנגלית' },
    ar: { name: 'توماس', role: 'معلّم خاص صبور للإنجليزية' },
  },
};

function resolvePersona(subject, lang) {
  // Mirrors chat-route.js's PERSONAS logic exactly, so the same tutor
  // identity (name + role) shows up on both channels - see the comment
  // there for why arabic-grammar/hebrew-L2/math-arabic force Arabic,
  // and why English alone has a per-interface-language name variant.
  const effectiveLang = (subject === 'ערבית' || subject === 'עברית כשפה שנייה' || subject === 'الرياضيات') ? 'ar' : lang;
  const raw = PERSONAS[subject] || PERSONAS['מתמטיקה'];
  return (raw.he || raw.ar) ? (raw[effectiveLang] || raw.he) : raw;
}

function buildSystemPrompt(unit, lang) {
  const langName = lang === "he" ? "עברית (Hebrew)" : "العربية (Arabic)";
  const persona = resolvePersona(unit.subject, lang);
  return `אתה ${persona.name}, ${persona.role} מבית daiZ (שירות הוראה פרטית בוואטסאפ, בעברית ובערבית, תחת הסלוגן "כל יום, לצידך"), שמלמד תלמיד/ה אחד-על-אחד בשיחת וואטסאפ.

חומר הלימוד הרשמי שסופק לך (מקור: תוכניות לימודים של משרד החינוך) - זהו המקור היחיד למונחים, נוסחאות ושיטת ההסבר:
"""
${JSON.stringify(unit, null, 1)}
"""

הנחיות התנהגות:
- ענה תמיד ב${langName}, גם אם חלק מהחומר המקורי כתוב בשפה אחרת.
- זו שיטת הוראה, לא שאלות ותשובות: נסה להבין איפה התלמיד תקוע, תן הנחיה קצרה אחת, ורק אם עדיין תקוע/ה - תן את הצעד הבא.
- אל תיתן פתרון מלא מיד, גם אם מתבקש. פרק לצעדים קטנים.
- כשמסבירים פתרון מדורג, מספר כל שלב (1. 2. 3.) בשורה נפרדת.
- טון: חם, מעודד, סבלני. הודעות קצרות המתאימות לצ'אט וואטסאפ.
- אם התלמיד עונה נכון - חזק בקצרה ועבור הלאה.`;
}

// General-chat mode (the "0. שיחה כללית" pinned menu option below) has no
// single KB unit to lock onto, so it needs its own prompt - mirrors
// chat-route.js's buildGeneralSystemPrompt (used by the website) so the
// two channels behave the same way: draw on the topics already prepared
// for this subject+grade as a reference, but don't refuse material that
// isn't in that list yet, as long as it's genuinely at this grade/subject
// level - that's the whole point of offering this mode over a locked topic.
function buildGeneralSystemPrompt(subjectId, grade, lang) {
  const subjectMeta = SUBJECTS.find(s => s.id === subjectId) || SUBJECTS[0];
  const kbSubject = subjectMeta.kb_subject;
  const persona = resolvePersona(kbSubject, lang);
  const effectiveLang = (kbSubject === 'ערבית' || kbSubject === 'עברית כשפה שנייה' || kbSubject === 'الرياضيات') ? 'ar' : lang;
  const langName = effectiveLang === "he" ? "עברית (Hebrew)" : "العربية (Arabic)";
  const availableTopicNames = chatRouter.TOPICS
    .filter(t => { const u = chatRouter.KB.math_units[t.id]; return u && u.subject === kbSubject && t.grade === grade; })
    .map(t => (effectiveLang === 'ar' ? t.ar : t.he))
    .filter(Boolean);
  const topicListText = availableTopicNames.length
    ? availableTopicNames.map(n => `- ${n}`).join('\n')
    : (effectiveLang === 'ar' ? '(لا توجد بعد مواضيع محضّرة خصيصاً لهذا المزيج من المادة والصف)' : '(אין עדיין נושאים מוכנים ספציפית לצירוף הזה של מקצוע וכיתה)');

  const topicsTitle = effectiveLang === 'ar'
    ? 'هذه المواضيع جاهزة خصيصاً لصفك في هذه المادة - إذا كان سؤال الطالب يتوافق مع أحدها، استند إليه:'
    : 'הנה הנושאים שכבר מוכנים במיוחד לכיתה הזו במקצוע הזה - אם שאלת התלמיד/ה מתאימה לאחד מהם, תעדיף/י להתבסס עליו:';
  const flexibilityNote = effectiveLang === 'ar'
    ? 'إذا سأل الطالب عن موضوع ليس في القائمة أعلاه (بما في ذلك مادة جديدة تعلّموها هذا الأسبوع) - ساعد/ي مع ذلك، لكن ابق/ي ضمن حدود ما يناسب فعلاً هذا الصف بالمنهج الرسمي، ولا تعلّم/ي مادة من صف أعلى بكثير أو من مادة أخرى تماماً.'
    : 'אם התלמיד/ה שואל/ת על נושא שלא ברשימה למעלה (כולל חומר חדש שנלמד השבוע) - עדיין עזור/י, אבל הישאר/י בגבולות מה שבאמת מתאים לכיתה הזו בתוכנית הלימודים הרשמית, ואל תלמד/י חומר מכיתה גבוהה משמעותית או ממקצוע אחר לגמרי.';

  return `אתה ${persona.name}, ${persona.role} מבית daiZ (שירות הוראה פרטית בוואטסאפ, בעברית ובערבית, תחת הסלוגן "כל יום, לצידך"), שמלמד תלמיד/ה אחד-על-אחד בשיחת וואטסאפ.

כיתה: ${grade}'

התלמיד/ה בחר/ה "שיחה כללית" - לא נושא ספציפי מוכן מראש, אלא שיחה חופשית על מה שהוא/היא צריך/ה.

${topicsTitle}
${topicListText}

${flexibilityNote}

הנחיות התנהגות:
- ענה תמיד ב${langName}, גם אם התלמיד/ה כתב/ה בשפה אחרת.
- זו שיטת הוראה, לא שאלות ותשובות: נסה להבין איפה התלמיד/ה תקוע/ה, תן/י הנחיה קצרה אחת, ורק אם עדיין תקוע/ה - תן/י את הצעד הבא.
- אל תיתן/י פתרון מלא מיד, גם אם מתבקש. פרק/י לצעדים קטנים.
- כשמסבירים פתרון מדורג, מספר/י כל שלב (1. 2. 3.) בשורה נפרדת.
- טון: חם, מעודד, סבלני. הודעות קצרות המתאימות לצ'אט וואטסאפ.
- אם התלמיד/ה עונה נכון - חזק/י בקצרה ועבור/י הלאה.`;
}

const SMART_MODEL = "claude-sonnet-4-6";
const CHEAP_MODEL = "claude-haiku-4-5-20251001";

// Model routing: most of the "administrative" flow (greeting, subject/grade/
// topic pickers, the about/menu quick-replies) already never calls the AI at
// all - those are template strings, so there's no cost to redirect there.
// The real opportunity is INSIDE the tutoring exchanges themselves: a short,
// routine reply from the student ("thanks", "got it", "ok") doesn't need the
// same careful reasoning as a message containing an actual answer, equation,
// or question that might need catching a subtle error - so route those to
// the cheap model, and keep anything substantive on the smart one. When in
// doubt, this stays on the smart model - a wrongly-cheap routing risks
// exactly the kind of subtle error the سجع incident already taught us to
// watch for; a wrongly-smart routing just costs a bit more, which is the
// safer side to err on.
const ROUTINE_REPLY_PATTERNS = [
  /^(תודה|תודה רבה|תודה לך|מעולה|יופי|סבבה|אוקיי|אוקי|בסדר|כן|לא|נכון|הבנתי)[!.\s]*$/i,
  /^(شكراً|شكرا|تمام|ماشي|أوكي|أوكيه|نعم|لا|صح|فهمت|مفهوم)[!.\s]*$/i,
  /^(thanks|thank you|ok|okay|got it|great|cool|yes|no)[!.\s]*$/i,
];

function isRoutineReply(text) {
  const trimmed = (text || "").trim();
  if (trimmed.length === 0 || trimmed.length > 25) return false; // short only - a longer message likely has real content
  return ROUTINE_REPLY_PATTERNS.some(p => p.test(trimmed));
}

async function askClaude(systemPrompt, history, model) {
  const response = await anthropic.messages.create({
    model: model || SMART_MODEL,
    max_tokens: 800,
    system: systemPrompt,
    messages: history.map((m) => ({ role: m.role, content: m.content })),
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// Internal phone-number format stays "whatsapp:+972501234567" everywhere
// in this file (STUDENTS keys, session keys, etc.) for continuity with
// what was already built - only these two functions know that 360dialog's
// actual API wants the bare digits with no "+" and no prefix.
function toD360Number(internalNumber) {
  return internalNumber.replace(/^whatsapp:\+?/, "");
}
function fromD360Number(rawNumber) {
  return "whatsapp:+" + rawNumber.replace(/^\+/, "");
}

async function sendWhatsApp(to, body) {
  const res = await fetch(`${D360_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "D360-API-KEY": D360_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toD360Number(to),
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`360dialog send failed (${res.status}) for ${to}:`, errText);
  }
}

// ---------------------------------------------------------------
// Weekly motivational message
// ---------------------------------------------------------------
// This is an unprompted message - almost always sent outside the 24-hour
// window after a student's last text - so WhatsApp requires it go out as
// an approved Template, not a free-form text (see sendWhatsApp above).
// One template ("weekly_boost", one variable slot for the body) covers
// all five rotating messages below - the variable is filled with
// whichever message is due that week, so only one template needs Meta's
// approval rather than five.
const WEEKLY_BOOST_TEMPLATE_NAME = "weekly_boost";

async function sendTemplateWhatsApp(to, templateName, langCode, bodyText) {
  const res = await fetch(`${D360_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "D360-API-KEY": D360_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toD360Number(to),
      type: "template",
      template: {
        name: templateName,
        language: { code: langCode },
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: bodyText }],
          },
        ],
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`360dialog template send failed (${res.status}) for ${to}:`, errText);
  }
}

// Five rotating messages, one pair per calendar week (index = ISO week
// number mod 5) - see getISOWeek below. Keep this array's order stable:
// reordering it shifts which message every student sees on which week.
const WEEKLY_MESSAGES = [
  {
    he: "השבוע הזה הוא עוד הזדמנות להתקדם, גם אם רק צעד קטן. ההצלחה לא נמדדת רק בציון - היא נמדדת בכל פעם שבחרת לא לוותר. אנחנו כאן איתך, בכל שלב.",
    ar: "هذا الأسبوع فرصة جديدة للتقدم، حتى لو بخطوة صغيرة. النجاح لا يُقاس فقط بالعلامة - بل يُقاس في كل مرة تختار فيها ألا تستسلم. نحن هنا معك، في كل خطوة.",
  },
  {
    he: "טעות היא לא כישלון - היא חלק מהדרך ללמוד. תן/י לעצמך רשות לטעות השבוע, ולנסות שוב. זה בדיוק מה שהופך תלמיד למבין אמיתי.",
    ar: "الخطأ ليس فشلاً - هو جزء من طريق التعلّم. اسمح/ي لنفسك أن تخطئ هذا الأسبوع، وتحاول من جديد. هذا بالضبط ما يجعل الطالب يفهم فهماً حقيقياً.",
  },
  {
    he: "מי שאתה כבן אדם - הסבלנות שלך, הלב שלך, הרצון שלך להשתפר - חשוב בדיוק כמו כל ציון. תזכור/י את זה השבוע, ותהיה גאה בעצמך.",
    ar: "من أنت كإنسان - صبرك، قلبك، رغبتك في التحسّن - مهم تماماً مثل أي علامة. تذكّر/ي هذا الأسبوع، وكن/ي فخوراً بنفسك.",
  },
  {
    he: "בוקר טוב! מאחלים לך שבוע נהדר, מלא בלמידה, סבלנות עצמית, וגאווה בכל התקדמות - גם הקטנה ביותר.",
    ar: "صباح الخير! نتمنى لك أسبوعاً رائعاً، مليئاً بالتعلّم، والصبر مع نفسك، والفخر بكل تقدّم - حتى لو كان صغيراً.",
  },
  {
    he: "הצלחה לא קורית ביום אחד - היא נבנית שבוע אחרי שבוע, כמו שאתה עושה עכשיו. תמשיך/י כך, אנחנו גאים בך.",
    ar: "النجاح لا يحدث في يوم واحد - بل يُبنى أسبوعاً بعد أسبوع، تماماً كما تفعل/ين الآن. استمر/ي هكذا، نحن فخورون بك.",
  },
];

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Israel is UTC+2 (winter) / UTC+3 (summer, roughly late March-late
// October) - Render's clock runs in UTC, so this converts before reading
// the day-of-week and hour. Approximate DST window rather than exact
// Israeli law dates; being off by an hour or a few days around the
// transition only shifts the send time slightly, never sends twice.
function nowInIsrael() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const dstStart = new Date(Date.UTC(year, 2, 25));
  const dstEnd = new Date(Date.UTC(year, 9, 25));
  const offsetHours = (now >= dstStart && now < dstEnd) ? 3 : 2;
  return new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
}

const WEEKLY_SENT_FILE = "weekly-sent.json";
let weeklySent = fs.existsSync(WEEKLY_SENT_FILE) ? JSON.parse(fs.readFileSync(WEEKLY_SENT_FILE, "utf8")) : {};
function saveWeeklySent() {
  fs.writeFileSync(WEEKLY_SENT_FILE, JSON.stringify(weeklySent, null, 2));
}

// Checked hourly (see setInterval below) rather than with a single
// once-a-week timer, because Render's free tier can spin the server down
// between requests - a timer set for "next Sunday at 8am" would simply
// never fire if the server happens to be asleep at that exact moment.
// Checking hourly and tracking per-student "already sent this ISO week"
// state means a late wake-up still catches the send within the same hour
// window, without ever double-sending.
async function checkAndSendWeeklyMessages() {
  const israelNow = nowInIsrael();
  const day = israelNow.getUTCDay(); // 0=Sunday, 1=Monday, ...
  const hour = israelNow.getUTCHours();
  const isSendWindow = hour === 8; // 08:00-08:59 Israel time
  if (!isSendWindow) return;
  // Hebrew-track schools start Sunday (day 0), Arabic-track schools start
  // Monday (day 1) - see the conversation this was confirmed in.
  const targetLang = day === 0 ? "he" : day === 1 ? "ar" : null;
  if (!targetLang) return;

  const isoWeek = getISOWeek(israelNow);
  const messageIndex = isoWeek % WEEKLY_MESSAGES.length;
  const message = WEEKLY_MESSAGES[messageIndex];

  for (const [phone, student] of Object.entries(STUDENTS)) {
    if (!phone.startsWith("whatsapp:")) continue; // skip "owner-full-access" and similar non-phone keys
    if (student.lang !== targetLang) continue;
    const sentKey = `${phone}:${isoWeek}`;
    if (weeklySent[sentKey]) continue;
    try {
      const langCode = targetLang === "he" ? "he" : "ar";
      const bodyText = targetLang === "he" ? message.he : message.ar;
      await sendTemplateWhatsApp(phone, WEEKLY_BOOST_TEMPLATE_NAME, langCode, bodyText);
      weeklySent[sentKey] = true;
      saveWeeklySent();
    } catch (err) {
      console.error(`Weekly message failed for ${phone}:`, err);
    }
  }
}
setInterval(checkAndSendWeeklyMessages, 60 * 60 * 1000); // check every hour

// ---- Main webhook: 360dialog calls this on every incoming WhatsApp message ----
// Payload shape is Meta's WhatsApp Cloud API format - see the comment at
// the top of this file. 360dialog also delivers "statuses" notifications
// (delivered/read receipts for messages we sent) to this same URL; those
// have no "messages" array, so they're detected and skipped below rather
// than mistaken for an incoming chat message.
app.post("/whatsapp-webhook", async (req, res) => {
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const incomingMessage = value?.messages?.[0];
  if (!incomingMessage) {
    // Status notification (sent/delivered/read) or another event type we
    // don't act on - 360dialog requires a fast 200 regardless.
    return res.status(200).json({ received: true });
  }
  if (incomingMessage.type !== "text") {
    // Non-text (image, audio, location, etc.) - out of scope for now,
    // acknowledge without processing so it doesn't retry forever.
    return res.status(200).json({ received: true });
  }
  const from = fromD360Number(incomingMessage.from);
  const body = (incomingMessage.text?.body || "").trim();

  // Rate limit: per phone number, before any other work happens.
  if (!checkRateLimit(from)) {
    // Silently drop rather than reply, to avoid spending a send
    // (and encouraging more traffic) on someone who is already spamming.
    console.warn(`Rate limit hit for ${from}`);
    saveSessions();
    return res.status(200).json({ received: true });
  }

  // Message length cap - reject before it reaches the model.
  if (body.length > MAX_MESSAGE_LENGTH) {
    const session0 = sessions[from];
    const lang0 = session0 && session0.lang ? session0.lang : "he";
    const msg = lang0 === "he"
      ? `ההודעה ארוכה מדי (מקסימום ${MAX_MESSAGE_LENGTH} תווים) - נסה/י לקצר ולשלוח שוב.`
      : `الرسالة طويلة جدًا (الحد الأقصى ${MAX_MESSAGE_LENGTH} حرفًا) - حاول/ي التقصير والإرسال مجددًا.`;
    await sendWhatsApp(from, msg);
    return res.status(200).json({ received: true });
  }

  // Access control: unlike the website (which still has an open pilot
  // flag), WhatsApp has no live users yet, so it starts enforced from
  // day one. An unrecognized number gets pointed to registration instead
  // of a free tutoring session - see the STUDENTS comment in chat-route.js
  // for how to register a new WhatsApp number.
  const student = STUDENTS[from];
  if (!student) {
    console.warn(`Unregistered WhatsApp number tried to chat: ${from}`);
    await sendWhatsApp(
      from,
      "שלום! 👋 המספר הזה עוד לא רשום ל-daiZ. כדי להתחיל, יש להירשם קודם באתר: daiz.co.il\n\nأهلاً! 👋 هذا الرقم غير مسجّل بعد في daiZ. للبدء، يرجى التسجيل أولاً على الموقع: daiz.co.il"
    );
    return res.status(200).json({ received: true });
  }

  if (!sessions[from]) sessions[from] = newSession();
  const session = sessions[from];
  // Sessions loaded from sessions.json predate weeklyLog for any student
  // active before this feature shipped - backfill so pruneWeeklyLog and
  // everything downstream can assume the array always exists.
  if (!Array.isArray(session.weeklyLog)) session.weeklyLog = [];
  pruneWeeklyLog(session);

  try {
    if (session.stage === "ask_lang") {
      await sendWhatsApp(
        from,
        "היי! ברוך הבא ל-daiZ 🌟\nאני כאן איתך – שותף לדרך הלימודית שלך. בכל נושא, שאלה או שיעורי בית שתרצה לעבור עליהם, נעשה את זה ביחד, צעד אחר צעד.\nתזכור: אין שאלות לא נכונות, ואין דבר שאי אפשר להבין כשמסבירים אותו בסבלנות ואהבה.\nעבורנו, חינוך ותרבות איכותיים הולכים יד ביד – כי ללמוד ולהתפתח כבן אדם חשובים בדיוק כמו להצליח במבחן.\n\nבאיזו שפה תרצה/י ללמוד? השיבו 1 לעברית, 2 للعربية.\n\nمرحباً بك في daiZ\nأنا هنا معك – شريكك في مسارك التعليمي. في أي موضوع، سؤال، أو واجبات مدرسية ترغب في مراجعتها، سنفعل ذلك معاً خطوة بخطوة.\nتذكّر دائماً: لا توجد أسئلة خاطئة، ولا يوجد شيء يصعب فهمه عندما نشرحه بصبر وحب.\nبالنسبة لنا، التربية والثقافة يسيران يداً بيد مع التعليم – فالبناء الإنساني لا يقل أهمية عن النجاح الدراسي.\n\nبأي لغة تحب التعلم؟ أجب 1 للعبرية، 2 للعربية."
      );
      session.stage = "wait_lang";
    } else if (session.stage === "wait_lang") {
      session.lang = body === "2" ? "ar" : "he";
      let subjects = subjectsForLang(session.lang);
      // A registered (non-owner) student only sees the subjects they paid
      // for. Owner (student.owner) and the not-yet-registered-check above
      // having already passed means `student` here is always a real entry.
      if (!student.owner) {
        subjects = subjects.filter(s => student.subjects.includes(s.id));
      }
      session.availableSubjects = subjects; // remember the filtered list for the next stage
      const list = subjects
        .map((s, i) => `${i + 1}. ${session.lang === "he" ? s.he : s.ar}`)
        .join("\n");
      const msg =
        session.lang === "he"
          ? `מעולה! באיזה מקצוע נתרגל היום?\n${list}\n\nהשיבו במספר.`
          : `ممتاز! في أي مادة نتدرّب اليوم؟\n${list}\n\nأجب بالرقم.`;
      await sendWhatsApp(from, msg);
      session.stage = "wait_subject";
    } else if (session.stage === "wait_subject") {
      const subjects = session.availableSubjects || subjectsForLang(session.lang);
      const idx = parseInt(body, 10) - 1;
      const chosenSubject = subjects[idx];

      if (!chosenSubject) {
        const msg =
          session.lang === "he"
            ? `זה לא אחד המספרים ברשימה 🙏 תשיב/י מספר בין 1 ל-${subjects.length}`
            : `هذا ليس رقمًا من القائمة 🙏 أجب برقم بين 1 و ${subjects.length}`;
        await sendWhatsApp(from, msg);
      } else {
        session.subject = chosenSubject.id;
        // A registered (non-owner) student's grade is already fixed by
        // their registration - skip asking and go straight to topics.
        if (!student.owner) {
          session.grade = student.grade;
          const topicsForGrade = topicsForSubjectGrade(chosenSubject, session.grade);
          const generalLabel = session.lang === "he" ? "שיחה כללית עם המורה" : "محادثة عامة مع المعلّم";
          const list = "0. " + generalLabel + "\n" + topicsForGrade
            .map((t, i) => `${i + 1}. ${session.lang === "he" ? t.he : t.ar}`)
            .join("\n");
          const msg =
            session.lang === "he"
              ? `באיזה נושא נתרגל היום?\n${list}\n\nהשיבו במספר.`
              : `في أي موضوع نتدرّب اليوم؟\n${list}\n\nأجب بالرقم.`;
          await sendWhatsApp(from, msg);
          session.stage = "wait_topic";
        } else {
          const grades = gradesForSubject(chosenSubject);
          const msg =
            session.lang === "he"
              ? `מעולה בחירה! 😊 באיזו כיתה אתה/את? השיבו: ${grades.join(", ")}`
              : `اختيار ممتاز! 😊 في أي صف أنت؟ أجب: ${grades.join(", ")}`;
          await sendWhatsApp(from, msg);
          session.stage = "wait_grade";
        }
      }
    } else if (session.stage === "wait_grade") {
      const subjectObj = SUBJECTS.find(s => s.id === session.subject);
      const validGrades = gradesForSubject(subjectObj);
      // match the longest valid grade label present in the reply (handles
      // both single-letter grades like ז and two-letter ones like יא/יב)
      const g = validGrades
        .slice()
        .sort((a, b) => b.length - a.length)
        .find(vg => body.includes(vg));

      if (!g) {
        const msg =
          session.lang === "he"
            ? `לא הבנתי, סליחה 🙏 תשיב/י אחת מהאותיות: ${validGrades.join(", ")}`
            : `لم أفهم، عذرًا 🙏 أجب بأحد الأحرف: ${validGrades.join(", ")}`;
        await sendWhatsApp(from, msg);
      } else {
        session.grade = g;
        const topicsForGrade = topicsForSubjectGrade(subjectObj, g);
        const generalLabel = session.lang === "he" ? "שיחה כללית עם המורה" : "محادثة عامة مع المعلّم";
        const list = "0. " + generalLabel + "\n" + topicsForGrade
          .map((t, i) => `${i + 1}. ${session.lang === "he" ? t.he : t.ar}`)
          .join("\n");
        const msg =
          session.lang === "he"
            ? `באיזה נושא נתרגל היום?\n${list}\n\nהשיבו במספר.`
            : `في أي موضوع نتدرّب اليوم؟\n${list}\n\nأجب بالرقم.`;
        await sendWhatsApp(from, msg);
        session.stage = "wait_topic";
      }
    } else if (session.stage === "wait_topic") {
      const subjectObj = SUBJECTS.find(s => s.id === session.subject);
      const topicsForGrade = topicsForSubjectGrade(subjectObj, session.grade);
      const isGeneralChatChoice = body.trim() === "0";
      const chosen = isGeneralChatChoice
        ? { id: "general-chat", he: "שיחה כללית עם המורה", ar: "محادثة عامة مع المعلّم" }
        : topicsForGrade[parseInt(body, 10) - 1];

      if (!chosen) {
        const msg =
          session.lang === "he"
            ? `זה לא אחד המספרים ברשימה 🙏 תשיב/י מספר בין 0 ל-${topicsForGrade.length}`
            : `هذا ليس رقمًا من القائمة 🙏 أجب برقم بين 0 و ${topicsForGrade.length}`;
        await sendWhatsApp(from, msg);
      } else {
        session.topic = chosen;
        const unit = isGeneralChatChoice ? null : findUnit(chosen);
        const persona = isGeneralChatChoice
          ? resolvePersona((SUBJECTS.find(s => s.id === session.subject) || {}).kb_subject, session.lang)
          : resolvePersona(unit ? unit.subject : session.subject, session.lang);
        // Hebrew grammar has no proper name (persona.name is just "the
        // teacher") - for that one case, skip the name+role phrasing (which
        // would read as "I am the teacher, your private teacher...") and
        // use the plain "hello, I'm your teacher" the persona implies.
        const isGenericPersona = persona.name === "המורה" || persona.name === "المعلّم";
        // General-chat mode gets its own natural greeting - the normal
        // "today we'll focus on <topic>" phrasing would be redundant when
        // the topic itself IS "general conversation" (mirrors chat.html's
        // selectTopic on the website for the same reason).
        const welcome = isGeneralChatChoice
          ? (session.lang === "he"
              ? (isGenericPersona
                  ? `שלום! אני המורה שלך מבית daiZ. שאל/י אותי על כל דבר שקשור למקצוע - גם אם זה נושא חדש שלמדתם לאחרונה בכיתה.`
                  : `שלום! אני ${persona.name}, המורה הפרטי שלך מבית daiZ. שאל/י אותי על כל דבר שקשור למקצוע - גם אם זה נושא חדש שלמדתם לאחרונה בכיתה.`)
              : (isGenericPersona
                  ? `أهلاً! أنا معلّمك من daiZ. اسألني عن أي شي متعلق بالمادة - حتى لو كان موضوع جديد تعلمتوه أخيراً بالصف.`
                  : `أهلاً! أنا ${persona.name}، معلّمك الخاص من daiZ. اسألني عن أي شي متعلق بالمادة - حتى لو كان موضوع جديد تعلمتوه أخيراً بالصف.`))
          : (session.lang === "he"
              ? (isGenericPersona
                  ? `שלום! אני המורה שלך מבית daiZ. היום נתמקד ב"${chosen.he}". יש לך תרגיל שאתה תקוע עליו, או שנעבור על העקרונות מההתחלה?`
                  : `שלום! אני ${persona.name}, המורה הפרטי שלך מבית daiZ. היום נתמקד ב"${chosen.he}". יש לך תרגיל שאתה תקוע עליו, או שנעבור על העקרונות מההתחלה?`)
              : (isGenericPersona
                  ? `أهلاً! أنا معلّمك من daiZ. اليوم سنركّز على "${chosen.ar}". عندك تمرين عالق فيه، ولا نبدأ من الأساسيات؟`
                  : `أهلاً! أنا ${persona.name}، معلّمك الخاص من daiZ. اليوم سنركّز على "${chosen.ar}". عندك تمرين عالق فيه، ولا نبدأ من الأساسيات؟`));
        session.history.push({ role: "assistant", content: welcome });
        await sendWhatsApp(from, welcome);
        session.stage = "tutoring";
      }
    } else if (session.stage === "tutoring") {
      // keyword to switch topic mid-conversation
      const bodyLower = body.trim().toLowerCase();
      if (["אודות", "מי אתם", "about", "من نحن", "daiz", "דייז"].includes(bodyLower)) {
        const aboutMsg =
          session.lang === "he"
            ? 'daiZ 🎓 — "כל יום, לצידך". מורה פרטי דיגיטלי בוואטסאפ, בעברית ובערבית, שמלמד בדיוק לפי תוכנית הלימודים הרשמית של משרד החינוך — לא עוד "עזר לימוד" סתמי מהאינטרנט. עוד פרטים: daiz.co.il\n\nרוצה להמשיך בתרגול? פשוט תכתוב/י את השאלה הבאה שלך 🙂'
            : 'daiZ 🎓 — "كل يوم، بجانبك". معلّم خاص رقمي عبر واتساب، بالعبرية والعربية، يعلّم بالضبط حسب المنهاج الرسمي لوزارة التربية والتعليم — مش "مساعد دراسي" عشوائي من الإنترنت. تفاصيل أكثر: daiz.co.il\n\nبدك تكمل التمرين؟ فقط اكتب/ي سؤالك التالي 🙂';
        await sendWhatsApp(from, aboutMsg);
      } else if (["תפריט", "menu", "القائمة", "החלף נושא", "עזרה", "help", "مساعدة"].includes(bodyLower)) {
        session.stage = "wait_subject";
        session.subject = null;
        session.grade = null;
        session.topic = null;
        // Only the current topic's live conversation resets here -
        // weeklyLog is intentionally left untouched so a student can still
        // ask about something from earlier this week after switching.
        session.history = [];
        let subjects = subjectsForLang(session.lang);
        if (!student.owner) {
          subjects = subjects.filter(s => student.subjects.includes(s.id));
        }
        session.availableSubjects = subjects;
        const list = subjects
          .map((s, i) => `${i + 1}. ${session.lang === "he" ? s.he : s.ar}`)
          .join("\n");
        const msg = session.lang === "he" ? `בטח! 🙂 בוא/י נבחר נושא חדש. באיזה מקצוע נתרגל היום?\n${list}\n\nהשיבו במספר.` : `أكيد! 🙂 يلا نختار موضوع جديد. في أي مادة نتدرّب اليوم؟\n${list}\n\nأجب بالرقم.`;
        await sendWhatsApp(from, msg);
      } else {
        session.history.push({ role: "user", content: body });
        // Cap history so long conversations don't grow the API payload (and cost) forever —
        // keep the most recent 20 messages (10 exchanges), which is plenty of context for tutoring.
        if (session.history.length > 20) {
          session.history = session.history.slice(-20);
        }
        const isGeneralChat = session.topic && session.topic.id === "general-chat";
        const unit = isGeneralChat ? null : findUnit(session.topic);
        const topicDisplayName = session.lang === "ar" ? session.topic.ar : session.topic.he;
        const weeklyContext = buildWeeklyContextBlock(session, session.lang);
        const systemPrompt = (isGeneralChat
          ? buildGeneralSystemPrompt(session.subject, session.grade, session.lang)
          : buildSystemPrompt(unit, session.lang)) + weeklyContext;
        // Route: a short routine reply ("thanks", "ok") goes to the cheap
        // model - anything with actual content (an answer, a question, a
        // number) stays on the smart one. See the comment above askClaude
        // for why this defaults to smart whenever it's unsure.
        const model = isRoutineReply(body) ? CHEAP_MODEL : SMART_MODEL;
        const reply = await askClaude(systemPrompt, session.history, model);
        session.history.push({ role: "assistant", content: reply });
        // weeklyLog is separate from history - it's what survives a topic
        // switch (see the menu handler above), so it's appended here too,
        // not swapped in for history's per-topic role.
        session.weeklyLog.push({ role: "user", text: body, timestamp: Date.now(), topicName: topicDisplayName });
        session.weeklyLog.push({ role: "assistant", text: reply, timestamp: Date.now(), topicName: topicDisplayName });
        pruneWeeklyLog(session);
        await sendWhatsApp(from, reply);
      }
    }
  } catch (err) {
    console.error("Error handling message:", err);
    await sendWhatsApp(
      from,
      session.lang === "ar" ? "حدثت مشكلة، حاول مرة أخرى." : "אירעה שגיאה, נסה/י שוב."
    );
  }

  saveSessions();
  res.status(200).json({ received: true });
});

app.get("/", (req, res) => res.send("daiZ WhatsApp trial server is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`daiZ WhatsApp server listening on port ${PORT}`));
