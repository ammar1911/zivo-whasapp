// daiZ — WhatsApp trial server (Twilio Sandbox + Claude API)
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
const TOPICS = [{"id": 0, "grade": "ז", "he": "משתנים וביטויים אלגבריים", "ar": "المتغيرات والتعبيرات الجبرية"}, {"id": 1, "grade": "ט", "he": "גיאומטריה אנליטית בסיסית: מרחקים ותכונות משולש במערכת צירים", "ar": "الهندسة التحليلية: المسافات وخصائص المثلث في المحاور"}, {"id": 2, "grade": "ז", "he": "זוויות: סימון, מדידה, חוצה זווית, זוויות צמודות וקודקודיות", "ar": "الزوايا"}, {"id": 3, "grade": "ט", "he": "משוואות דו-ריבועיות ומשוואות אי-רציונליות", "ar": "معادلات ثنائية التربيع ومعادلات لاعقلانية"}, {"id": 4, "grade": "ח", "he": "מדדי מרכז: ממוצע, חציון, שכיח", "ar": "مقاييس النزعة المركزية"}, {"id": 5, "grade": "ז", "he": "היקף מעגל ושטח עיגול", "ar": "محيط الدائرة ومساحتها"}, {"id": 6, "grade": "ט", "he": "משפטי מעגל: זווית מרכזית וזווית היקפית", "ar": "نظريات الدائرة: الزاوية المركزية والمحيطية"}, {"id": 7, "grade": "ט", "he": "הסתברות מותנית ורצף ניסויים", "ar": "الاحتمال الشرطي وتتابع التجارب"}, {"id": 8, "grade": "ז", "he": "מערכת צירים", "ar": "المحاور الإحداثية"}, {"id": 9, "grade": "ח", "he": "גליל וחרוט", "ar": "الأسطوانة والمخروط"}, {"id": 10, "grade": "ט", "he": "יחס ישר ויחס הפוך", "ar": "التناسب الطردي والعكسي"}, {"id": 11, "grade": "ז", "he": "חזקות ושורש ריבועי", "ar": "الأسس والجذر التربيعي"}, {"id": 12, "grade": "ז", "he": "שכיחות ושכיחות יחסית", "ar": "التكرار والتكرار النسبي"}, {"id": 13, "grade": "ט", "he": "הזזות ומתיחות של פונקציות", "ar": "إزاحات وتمديدات الدوال"}, {"id": 14, "grade": "ז", "he": "הזזה, סיבוב ושיקוף", "ar": "الإزاحة والدوران والانعكاس"}, {"id": 15, "grade": "ח", "he": "אינטרפולציה ואקסטרפולציה", "ar": "الاستيفاء والاستقراء"}, {"id": 16, "grade": "ז", "he": "מבוא לפונקציות", "ar": "مدخل إلى الدوال"}, {"id": 17, "grade": "ט", "he": "מספרים אי-רציונליים", "ar": "الأعداد غير النسبية"}, {"id": 18, "grade": "ח", "he": "משולש שווה-שוקיים", "ar": "المثلث متساوي الساقين"}, {"id": 19, "grade": "ח", "he": "דלתון", "ar": "الطائرة الورقية"}, {"id": 20, "grade": "ט", "he": "כפולה משותפת מינימלית ומשוואות רציונליות", "ar": "المضاعف المشترك الأصغر والمعادلات الكسرية"}, {"id": 21, "grade": "ז", "he": "פתרון משוואות ממעלה ראשונה כולל מספרים מכוונים", "ar": "حل معادلات من الدرجة الأولى (معادلات خاصة)"}, {"id": 22, "grade": "ז", "he": "משוואות ממעלה ראשונה - התקדמות הדרגתית בארבע רמות", "ar": "معادلات - تدرّج بأربع مستويات"}, {"id": 23, "grade": "ח", "he": "פונקציה ליניארית ושיפוע", "ar": "الدالة الخطية والميل"}, {"id": 24, "grade": "ח", "he": "אי-שוויונות קוויים", "ar": "متباينات خطية"}, {"id": 25, "grade": "ח", "he": "حل معادلة من الدرجة الأولى بمجهول واحد", "ar": "حل معادلة من الدرجة الأولى بمجهول واحد"}, {"id": 26, "grade": "ח", "he": "مساحة المثلث ونظرية فيثاغورس", "ar": "مساحة المثلث ونظرية فيثاغورس"}, {"id": 27, "grade": "ח", "he": "תיכון במשולש", "ar": "المتوسط في المثلث"}, {"id": 28, "grade": "ז", "he": "כפל וחילוק מספרים מכוונים", "ar": "ضرب وقسمة الأعداد الموجّهة"}, {"id": 29, "grade": "ז", "he": "סדר פעולות החשבון", "ar": "ترتيب العمليات الحسابية"}, {"id": 30, "grade": "ז", "he": "שטח מקבילית וטרפז", "ar": "مساحة متوازي الأضلاع وشبه المنحرف"}, {"id": 31, "grade": "ח", "he": "אחוזים", "ar": "النسبة المئوية"}, {"id": 32, "grade": "ח", "he": "הסתברות: מושגים בסיסיים, מאורע משלים", "ar": "الاحتمال: مفاهيم أساسية"}, {"id": 33, "grade": "ט", "he": "משפט פיתגורס - הוכחה פורמלית", "ar": "نظرية فيثاغورس - إثبات رسمي"}, {"id": 34, "grade": "ט", "he": "פונקציה ריבועית (פרבולה)", "ar": "الدالة التربيعية (القطع المكافئ)"}, {"id": 35, "grade": "ט", "he": "שאלות מילוליות עם פונקציה ריבועית - חשיבה ונימוק", "ar": "مسائل لفظية بالدالة التربيعية"}, {"id": 36, "grade": "ט", "he": "הוכחות דדוקטיביות על מרובעים", "ar": "إثباتات استنتاجية حول الأشكال الرباعية"}, {"id": 37, "grade": "ח", "he": "יחס וקנה מידה", "ar": "النسبة ومقياس الرسم"}, {"id": 38, "grade": "ז", "he": "מלבן, ניצבות והקבלה", "ar": "المستطيل والتعامد والتوازي"}, {"id": 39, "grade": "ט", "he": "נוסחאות הכפל המקוצר ופירוק לגורמים", "ar": "صيغ الضرب المختصر والتحليل لعوامل"}, {"id": 40, "grade": "ז", "he": "חיבור וחיסור מספרים מכוונים", "ar": "جمع وطرح الأعداد الموجّهة"}, {"id": 41, "grade": "ט", "he": "משפטי דמיון משולשים - הוכחה פורמלית", "ar": "نظريات تشابه المثلثات - إثبات رسمي"}, {"id": 42, "grade": "ט", "he": "פתרון משוואה ריבועית", "ar": "حل المعادلة التربيعية"}, {"id": 43, "grade": "ח", "he": "מערכת משוואות ממעלה ראשונה בשני נעלמים", "ar": "جملة معادلتين خطيتين"}, {"id": 44, "grade": "ז", "he": "היכרות עם המשולש וסיווגו", "ar": "التعرف على المثلث وتصنيفه"}, {"id": 45, "grade": "ח", "he": "חפיפת משולשים", "ar": "تطابق المثلثات"}, {"id": 46, "grade": "ח", "he": "דמיון משולשים", "ar": "تشابه المثلثات"}, {"id": 47, "grade": "ז", "he": "מנסרה משולשת", "ar": "المنشور الثلاثي"}, {"id": 48, "grade": "ח", "he": "פירוש נתונים משני מקורות מידע", "ar": "تفسير بيانات من مصدرين"}, {"id": 49, "grade": "ז", "he": "משוואות בשני שלבים - משחק פענוח מילה", "ar": "معادلات - لعبة فك الشفرة"}, {"id": 50, "grade": "ט", "he": "פישוט וחישוב עם ביטויים הכוללים שורשים", "ar": "تبسيط وحساب تعبيرات تتضمن جذورًا"}];

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
  return `אתה סוקרטס, מורה פרטי סבלני למתמטיקה מבית daiZ (שירות הוראה פרטית בוואטסאפ, בעברית ובערבית, תחת הסלוגן "כל יום, לצידך"), שמלמד תלמיד/ה אחד-על-אחד בשיחת וואטסאפ.

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
        "שלום! 👋 אני סוקרטס, המורה הפרטי שלך למתמטיקה מבית daiZ 🎓 כל יום, לצידך — כאן כדי לעזור לך להתקדם ולהגיע לציון שתמיד רצית 💪\n\nבאיזו שפה תרצה/י ללמוד? השיבו 1 לעברית, 2 للعربية.\nأهلاً! أنا سقراط، معلّمك الخاص في الرياضيات من daiZ 🎓 كل يوم، بجانبك — أنا هنا لمساعدتك على التقدم والوصول للعلامة التي طالما أردتها 💪\n\nبأي لغة تحب التعلم؟ أجب 1 للعبرية، 2 للعربية."
      );
      session.stage = "wait_lang";
    } else if (session.stage === "wait_lang") {
      session.lang = body === "2" ? "ar" : "he";
      const msg =
        session.lang === "he"
          ? "מעולה! באיזו כיתה אתה/את? השיבו: ז, ח, או ט"
          : "ممتاز! في أي صف أنت؟ أجب: ز, ح, أو ط";
      await sendWhatsApp(from, msg);
      session.stage = "wait_grade";
    } else if (session.stage === "wait_grade") {
      const validGrades = { "ז": "ז", "ח": "ח", "ט": "ט" };
      let g = null;
      if (body.includes("ט")) g = "ט";
      else if (body.includes("ח")) g = "ח";
      else if (body.includes("ז")) g = "ז";

      if (!g) {
        const msg =
          session.lang === "he"
            ? "לא הבנתי, סליחה 🙏 תשיב/י רק אחת מהאותיות: ז, ח, או ט"
            : "لم أفهم، عذرًا 🙏 أجب فقط بأحد الأحرف: ز, ح, أو ط";
        await sendWhatsApp(from, msg);
      } else {
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
      }
    } else if (session.stage === "wait_topic") {
      const topicsForGrade = TOPICS.filter((t) => t.grade === session.grade);
      const idx = parseInt(body, 10) - 1;
      const chosen = topicsForGrade[idx];

      if (!chosen) {
        const msg =
          session.lang === "he"
            ? `זה לא אחד המספרים ברשימה 🙏 תשיב/י מספר בין 1 ל-${topicsForGrade.length}`
            : `هذا ليس رقمًا من القائمة 🙏 أجب برقم بين 1 و ${topicsForGrade.length}`;
        await sendWhatsApp(from, msg);
      } else {
        session.topic = chosen;
        const unit = findUnit(chosen);
        const welcome =
          session.lang === "he"
            ? `שלום! אני סוקרטס, המורה הפרטי שלך מבית daiZ. היום נתמקד ב"${chosen.he}". יש לך תרגיל שאתה תקוע עליו, או שנעבור על העקרונות מההתחלה?`
            : `أهلاً! أنا سقراط، معلّمك الخاص من daiZ. اليوم سنركّز على "${chosen.ar}". عندك تمرين عالق فيه، ولا نبدأ من الأساسيات؟`;
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
            ? 'daiZ 🎓 — "כל יום, לצידך". מורה פרטי דיגיטלי למתמטיקה בוואטסאפ, בעברית ובערבית, שמלמד בדיוק לפי תוכנית הלימודים הרשמית של משרד החינוך — לא עוד "עזר לימוד" סתמי מהאינטרנט. עוד פרטים: daiz.co.il\n\nרוצה להמשיך בתרגול? פשוט תכתוב/י את השאלה הבאה שלך 🙂'
            : 'daiZ 🎓 — "كل يوم، بجانبك". معلّم خاص رقمي في الرياضيات عبر واتساب، بالعبرية والعربية، يعلّم بالضبط حسب المنهاج الرسمي لوزارة التربية والتعليم — مش "مساعد دراسي" عشوائي من الإنترنت. تفاصيل أكثر: daiz.co.il\n\nبدك تكمل التمرين؟ فقط اكتب/ي سؤالك التالي 🙂';
        await sendWhatsApp(from, aboutMsg);
      } else if (["תפריט", "menu", "القائمة", "החלף נושא", "עזרה", "help", "مساعدة"].includes(bodyLower)) {
        session.stage = "wait_grade";
        session.topic = null;
        session.history = [];
        const msg = session.lang === "he" ? "באיזו כיתה אתה/את? השיבו: ז, ח, או ט" : "في أي صف أنت؟ أجب: ز, ح, أو ط";
        await sendWhatsApp(from, msg);
      } else {
        session.history.push({ role: "user", content: body });
        // Cap history so long conversations don't grow the API payload (and cost) forever —
        // keep the most recent 20 messages (10 exchanges), which is plenty of context for tutoring.
        if (session.history.length > 20) {
          session.history = session.history.slice(-20);
        }
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

app.get("/", (req, res) => res.send("daiZ WhatsApp trial server is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`daiZ WhatsApp server listening on port ${PORT}`));
