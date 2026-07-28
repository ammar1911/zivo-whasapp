// Zivo — WhatsApp trial server (Twilio Sandbox + Claude API)
// -----------------------------------------------------------
// Minimal server for running a real WhatsApp trial with a handful of families.
// Not meant for production scale — no database, sessions live in memory
// (they reset if the server restarts). Good enough to test "does the
// teaching actually work" before investing in the full production backend.

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886" (the sandbox number)

const KB = JSON.parse(fs.readFileSync("./kb.json", "utf8"));

// Topic picker metadata — matches knowledge-base-master.json topic_name fields
const TOPICS = [
  { id: 0, grade: "ז", he: "משתנים וביטויים אלגבריים", ar: "المتغيرات والتعبيرات الجبرية" },
  { id: 1, grade: "ז", he: "זוויות", ar: "الزوايا" },
  { id: 2, grade: "ז", he: "חיבור וחיסור מספרים מכוונים", ar: "جمع وطرح الأعداد الموجّهة" },
  { id: 3, grade: "ח", he: "חפיפת משולשים", ar: "تطابق المثلثات" },
  { id: 4, grade: "ח", he: "אחוזים", ar: "النسبة المئوية" },
  { id: 5, grade: "ח", he: "פתרון משוואות ממעלה ראשונה", ar: "حل معادلة من الدرجة الأولى" },
  { id: 6, grade: "ח", he: "שטח משולש ומשפט פיתגורס", ar: "مساحة المثلث ونظرية فيثاغورس" },
];

function findUnit(topicMeta) {
  return KB.math_units.find((u) => {
    const name = u.topic_name || u.topic_name_official || "";
    return name === topicMeta.he || name === topicMeta.ar;
  });
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
  return { stage: "ask_lang", lang: null, grade: null, topic: null, history: [] };
}

function buildSystemPrompt(unit, lang) {
  const langName = lang === "he" ? "עברית (Hebrew)" : "العربية (Arabic)";
  return `אתה סוקרטס, מורה פרטי סבלני למתמטיקה, שמלמד תלמיד/ה אחד-על-אחד בשיחת וואטסאפ.

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

async function askClaude(systemPrompt, history) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    system: systemPrompt,
    messages: history.map((m) => ({ role: m.role, content: m.content })),
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function sendWhatsApp(to, body) {
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to,
    body,
  });
}

// ---- Main webhook: Twilio calls this on every incoming WhatsApp message ----
app.post("/whatsapp-webhook", async (req, res) => {
  const from = req.body.From; // e.g. "whatsapp:+9725XXXXXXXX"
  const body = (req.body.Body || "").trim();

  if (!sessions[from]) sessions[from] = newSession();
  const session = sessions[from];

  try {
    if (session.stage === "ask_lang") {
      await sendWhatsApp(
        from,
        "שלום! 👋 באיזו שפה תרצה/י ללמוד? השיבו 1 לעברית, 2 للعربية.\nأهلاً! بأي لغة تحب التعلم؟ أجب 1 للعبرية، 2 للعربية."
      );
      session.stage = "wait_lang";
    } else if (session.stage === "wait_lang") {
      session.lang = body === "2" ? "ar" : "he";
      const msg =
        session.lang === "he"
          ? "מעולה! באיזו כיתה אתה/את? השיבו: ז או ח"
          : "ممتاز! في أي صف أنت؟ أجب: ز أو ح";
      await sendWhatsApp(from, msg);
      session.stage = "wait_grade";
    } else if (session.stage === "wait_grade") {
      const g = body.includes("ח") || body.toLowerCase() === "h" ? "ח" : "ז";
      session.grade = g;
      const topicsForGrade = TOPICS.filter((t) => t.grade === g);
      const list = topicsForGrade
        .map((t, i) => `${i + 1}. ${session.lang === "he" ? t.he : t.ar}`)
        .join("\n");
      const msg =
        session.lang === "he"
          ? `באיזה נושא נתרגל היום?\n${list}\n\nהשיבו במספר.`
          : `في أي موضوع نتدرّب اليوم؟\n${list}\n\nأجب بالرقم.`;
      await sendWhatsApp(from, msg);
      session.stage = "wait_topic";
    } else if (session.stage === "wait_topic") {
      const topicsForGrade = TOPICS.filter((t) => t.grade === session.grade);
      const idx = parseInt(body, 10) - 1;
      const chosen = topicsForGrade[idx] || topicsForGrade[0];
      session.topic = chosen;
      const unit = findUnit(chosen);
      const welcome =
        session.lang === "he"
          ? `שלום! אני סוקרטס, המורה הפרטי שלך. היום נתמקד ב"${chosen.he}". יש לך תרגיל שאתה תקוע עליו, או שנעבור על העקרונות מההתחלה?`
          : `أهلاً! أنا سقراط، معلّمك الخاص. اليوم سنركّز على "${chosen.ar}". عندك تمرين عالق فيه، ولا نبدأ من الأساسيات؟`;
      session.history.push({ role: "assistant", content: welcome });
      await sendWhatsApp(from, welcome);
      session.stage = "tutoring";
    } else if (session.stage === "tutoring") {
      // keyword to switch topic mid-conversation
      if (["תפריט", "menu", "القائمة", "החלף נושא"].includes(body)) {
        session.stage = "wait_grade";
        session.topic = null;
        session.history = [];
        const msg = session.lang === "he" ? "באיזו כיתה אתה/את? השיבו: ז או ח" : "في أي صف أنت؟ أجب: ز أو ح";
        await sendWhatsApp(from, msg);
      } else {
        session.history.push({ role: "user", content: body });
        const unit = findUnit(session.topic);
        const systemPrompt = buildSystemPrompt(unit, session.lang);
        const reply = await askClaude(systemPrompt, session.history);
        session.history.push({ role: "assistant", content: reply });
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
  res.status(200).send("<Response></Response>");
});

app.get("/", (req, res) => res.send("Zivo WhatsApp trial server is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zivo WhatsApp server listening on port ${PORT}`));
