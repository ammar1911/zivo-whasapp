// cardcom.js
// Integration with Cardcom's V11 JSON API for recurring subscription billing.
//
// Flow used here ("LowProfile" - Cardcom's hosted/PCI-compliant payment page):
//   1) createPaymentSession()   - server asks Cardcom for a hosted payment page URL.
//                                  The parent is redirected there to enter card details.
//                                  This can charge a first payment AND create a reusable
//                                  token in one step (Operation: "ChargeAndCreateToken").
//   2) getLowProfileResult()    - after the parent completes payment, Cardcom calls our
//                                  webhook (or we can poll this endpoint) with the result,
//                                  including the reusable card Token - this is what makes
//                                  future recurring charges possible without asking the
//                                  parent for their card again.
//   3) chargeToken()            - called once a month (e.g. by a cron job) using the saved
//                                  Token to charge the parent again - this IS the "הוראת קבע".
//
// IMPORTANT before going live:
//   - Test everything against Cardcom's sandbox terminal (TerminalNumber 1000) first.
//   - Cross-check every field name here against Cardcom's own live API reference at
//     https://secure.cardcom.solutions/Api/v11/Docs - this file was written from Cardcom's
//     published documentation, but payment integrations are exactly the kind of code worth
//     re-verifying against the live spec before real charges run through it.
//   - SuccessRedirectUrl / FailedRedirectUrl / WebHookUrl must be public HTTPS URLs -
//     localhost will not work, even in testing (use a tool like ngrok for local dev).

const CARDCOM_BASE = "https://secure.cardcom.solutions/api/v11";

const TERMINAL_NUMBER = Number(process.env.CARDCOM_TERMINAL_NUMBER || 1000); // 1000 = Cardcom's public test terminal
const API_NAME = process.env.PAYMENT_API_KEY;
const API_PASSWORD = process.env.PAYMENT_API_PASSWORD;

if (!API_NAME || !API_PASSWORD) {
  console.warn("[cardcom] PAYMENT_API_KEY / PAYMENT_API_PASSWORD are not set - Cardcom calls will fail.");
}

async function cardcomPost(path, body) {
  const res = await fetch(CARDCOM_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data;
}

/**
 * Step 1: Create a hosted Cardcom payment page for a NEW subscriber.
 * Charges the first month AND creates a reusable token in the same step, so we
 * can charge the following months automatically without the parent re-entering
 * their card.
 *
 * @param {Object} params
 * @param {string} params.orderId       - your own unique id for this signup (e.g. studentId), returned to you later as ReturnValue
 * @param {number} params.amount        - amount to charge now, in ILS (e.g. 170)
 * @param {string} params.productName   - shown to the payer, e.g. "daiZ - מנוי חודשי"
 * @param {string} params.successUrl    - where the parent is sent after a successful payment
 * @param {string} params.failUrl       - where the parent is sent after a failed/cancelled payment
 * @param {string} params.webhookUrl    - your server endpoint Cardcom calls with the result (Step 2)
 * @param {"he"|"en"|"ar"} [params.language]
 * @param {string} [params.customerName]  - for the invoice; the whole Document block is skipped without an email
 * @param {string} [params.customerEmail] - if given (with customerName), Cardcom auto-generates and
 *   emails a tax invoice+receipt (חשבונית מס + קבלה) for this charge - no separate call needed.
 *   Without an email, no document is created at all for this charge.
 * @returns {Promise<{ok: boolean, url?: string, lowProfileCode?: string, raw: object}>}
 */
async function createPaymentSession({ orderId, amount, productName, successUrl, failUrl, webhookUrl, language = "he", customerName, customerEmail }) {
  const body = {
    TerminalNumber: TERMINAL_NUMBER,
    ApiName: API_NAME,
    Operation: "ChargeAndCreateToken",
    ReturnValue: orderId,
    Amount: amount,
    ProductName: productName,
    SuccessRedirectUrl: successUrl,
    FailedRedirectUrl: failUrl,
    WebHookUrl: webhookUrl,
    CoinID: 1, // 1 = ILS
    Language: language,
  };

  // Osek murshe (licensed dealer, charges VAT) -> TaxInvoiceAndReceipt.
  // If this business is ever an osek patur instead, this should be
  // "Receipt" only - an osek patur cannot issue tax invoices.
  if (customerEmail) {
    body.Document = {
      DocumentTypeToCreate: "TaxInvoiceAndReceipt",
      Name: customerName || "לקוח daiZ",
      Email: customerEmail,
      IsSendByEmail: true,
      Products: [
        { Description: productName, Quantity: 1, UnitCost: amount },
      ],
    };
  }

  const data = await cardcomPost("/LowProfile/Create", body);

  return {
    ok: data.ResponseCode === 0,
    url: data.Url,
    lowProfileCode: data.LowProfileCode,
    raw: data,
  };
}

/**
 * Step 2: Look up the result of a completed LowProfile session (e.g. from inside
 * your webhook handler, or to double-check a session by its code).
 * On success (DealResponse === 0), the response carries the reusable card token -
 * this is the value you must save (alongside its expiry month/year) to charge the
 * subscriber again next month.
 *
 * @param {string} lowProfileCode
 */
async function getLowProfileResult(lowProfileCode) {
  const data = await cardcomPost("/LowProfile/GetLpResult", {
    TerminalNumber: TERMINAL_NUMBER,
    ApiName: API_NAME,
    ApiPassword: API_PASSWORD,
    LowProfileCode: lowProfileCode,
  });

  const success = data.ResponseCode === 0 && data.TranzactionInfo && data.TranzactionInfo.ResponseCode === 0;
  const tokenInfo = data.TokenInfo || null;

  return {
    ok: success,
    orderId: data.ReturnValue,
    token: tokenInfo ? tokenInfo.Token : null,
    tokenExpiryMonth: tokenInfo ? tokenInfo.CardMonth : null,
    tokenExpiryYear: tokenInfo ? tokenInfo.CardYear : null,
    raw: data,
  };
}

/**
 * Step 3: Charge a previously-saved token - this is the actual monthly "הוראת קבע" charge.
 * Call this from a scheduled job (cron) once a month per active subscriber.
 *
 * @param {Object} params
 * @param {string} params.token
 * @param {string|number} params.expiryMonth  - MM, from the saved token info
 * @param {string|number} params.expiryYear   - YYYY, from the saved token info
 * @param {number} params.amount              - amount to charge this cycle, in ILS
 * @param {string} [params.orderId]           - your own reference id for this specific charge (e.g. `studentId-2026-11`)
 * @param {string} [params.productName]       - shown on the invoice line item, e.g. "daiZ - מנוי חודשי"
 * @param {string} [params.customerName]      - for the invoice; the whole Document block is skipped without an email
 * @param {string} [params.customerEmail]     - if given (with customerName), auto-generates+emails an
 *   invoice for this month's charge too, same as the first payment - see createPaymentSession above.
 */
async function chargeToken({ token, expiryMonth, expiryYear, amount, orderId, productName, customerName, customerEmail }) {
  const body = {
    TerminalNumber: TERMINAL_NUMBER,
    ApiName: API_NAME,
    ApiPassword: API_PASSWORD,
    Amount: amount,
    ReturnValue: orderId,
    CoinID: 1,
    TokenToCharge: {
      Token: token,
      CardExpirationMonth: Number(expiryMonth),
      CardExpirationYear: Number(expiryYear),
    },
  };

  if (customerEmail) {
    body.Document = {
      DocumentTypeToCreate: "TaxInvoiceAndReceipt",
      Name: customerName || "לקוח daiZ",
      Email: customerEmail,
      IsSendByEmail: true,
      Products: [
        { Description: productName || "daiZ - מנוי חודשי", Quantity: 1, UnitCost: amount },
      ],
    };
  }

  const data = await cardcomPost("/Transactions/Transaction", body);

  return {
    ok: data.ResponseCode === 0,
    internalDealNumber: data.InternalDealNumber,
    raw: data,
  };
}

module.exports = { createPaymentSession, getLowProfileResult, chargeToken };
