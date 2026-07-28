# Zivo — הרצת ניסיון וואטסאפ אמיתי (Twilio Sandbox)

מדריך הרצה למי שמתקין את זה (את/ה או מתכנת/ת). לוקח בערך שעה-שעתיים בפעם הראשונה.

## שלב 1 — הרשמה ל-Twilio (5 דקות)

1. הירשם/י ב-console.twilio.com (יש חשבון ניסיון חינמי)
2. בתפריט השמאלי: **Messaging → Try it out → Send a WhatsApp message**
3. תראה מספר טלפון של Twilio (למשל `+1 415 523 8886`) ומילת קוד (למשל `join happy-tiger`)
4. שמור את שני אלה — תצטרך אותם

## שלב 2 — פרטי חיבור (5 דקות)

מ-Twilio Console תעתיק שלושה ערכים:
- `Account SID`
- `Auth Token`
- מספר הוואטסאפ של הסנדבוקס (מהשלב הקודם, בפורמט `whatsapp:+14155238886`)

מ-Anthropic Console (`console.anthropic.com`) תעתיק:
- `ANTHROPIC_API_KEY` (מפתח API)

## שלב 3 — התקנה מקומית

```bash
npm install
```

צור קובץ בשם `.env` בתיקייה עם התוכן הבא (מלא את הערכים שלך):

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

הרץ מקומית לבדיקה ראשונית:
```bash
node -r dotenv/config server.js
```
(אם `dotenv` לא מותקן: `npm install dotenv`)

## שלב 4 — פריסה לאינטרנט (כדי ש-Twilio יוכל "לראות" את השרת שלך)

לא ניתן להריץ את זה רק על המחשב האישי בלי חשיפה לאינטרנט. שתי אופציות:

**אופציה מהירה לבדיקה (יומיים-שלושה, לא ליציבות ארוכת טווח):**
```bash
npx ngrok http 3000
```
זה ייתן לך כתובת זמנית כמו `https://abcd1234.ngrok.app` — זו הכתובת שתזין ב-Twilio (ראה שלב 5). חשוב: הכתובת הזו משתנה בכל הפעלה מחדש של ngrok.

**אופציה יציבה יותר לתקופת הניסיון כולה (מומלץ):**
פרוס ל-**Render.com** או **Railway.app** (יש רבדים חינמיים/זולים):
1. העלה את התיקייה הזו ל-GitHub repo
2. חבר את ה-repo ב-Render/Railway
3. הגדר שם את משתני הסביבה (מה-`.env`) בממשק שלהם
4. תקבל כתובת קבועה כמו `https://zivo-trial.onrender.com`

## שלב 5 — חיבור ה-Webhook ל-Twilio

ב-Twilio Console, באותו עמוד Sandbox:
- שדה **"WHEN A MESSAGE COMES IN"** — הדבק: `https://<הכתובת-שלך>/whatsapp-webhook`
- שיטה: `HTTP POST`
- שמור

## שלב 6 — בדיקה

כל מי שרוצה להצטרף לניסיון (משפחות הבטא) צריך/ה:
1. לשמור את מספר ה-Sandbox של Twilio באנשי קשר
2. לשלוח לו הודעת וואטסאפ עם מילת הקוד (למשל `join happy-tiger`) — **פעם אחת בלבד**
3. מרגע זה, כל הודעה שהם שולחים לאותו מספר תגיע לשרת שלך ותקבל תשובה מסוקרטס

## מגבלות חשובות של הגרסה הזו (לניסיון בלבד, לא לשימוש מסחרי)

- **Sandbox פג תוקף** כל 72 שעות מהצטרפות אם אין הודעה — צריך להזכיר למשפחות לשלוח הודעה מדי פעם, או לעבור בהמשך ל-WhatsApp Business API אמיתי (לא Sandbox) להשקה בפועל
- **אין סליקה/חיוב** בגרסה הזו כלל — זה נועד לבדוק את איכות ההוראה בלבד, לא תהליך תשלום
- **sessions.json** הוא קובץ מקומי פשוט, לא מסד נתונים אמיתי — מספיק לכמה עשרות משפחות בניסיון, לא לקנה מידה מסחרי
- כרגע רק 7 נושאים (ראה `kb.json`) — אם תלמיד/ה יבחר/תבחר נושא שעדיין לא בנוי, יקבל/תקבל רק את 7 האלה לבחירה
