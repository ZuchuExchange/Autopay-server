require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Catch malformed JSON bodies cleanly instead of returning HTML stack traces
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_JSON",
      message: "Request body contains invalid JSON."
    });
  }
  return next(err);
});

const PORT = process.env.PORT || 3000;
const PESAFLUX_BASE_URL = "https://api.pesaflux.co.ke/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.PESAFLUX_TIMEOUT_MS) || 15000;

// Stores latest state keyed by transaction_request_id
const transactions = new Map();

function getConfig() {
  const api_key = process.env.PESAFLUX_API_KEY?.trim();
  const email = process.env.PESAFLUX_EMAIL?.trim();

  if (!api_key || !email) {
    const error = new Error("Server configuration error: PESAFLUX_API_KEY or PESAFLUX_EMAIL is missing.");
    error.statusCode = 500;
    error.code = "MISSING_CREDENTIALS";
    throw error;
  }

  return { api_key, email };
}

function normalizePhone(msisdn) {
  const digits = String(msisdn || "").replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 10) {
    return `254${digits.slice(1)}`;
  }
  if ((digits.startsWith("7") || digits.startsWith("1")) && digits.length === 9) {
    return `254${digits}`;
  }
  return digits;
}

async function postToPesaflux(endpoint, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${PESAFLUX_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const rawText = await response.text();
    let data;

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      const parseError = new Error("Received non-JSON response from Pesaflux API.");
      parseError.statusCode = 502;
      parseError.code = "UPSTREAM_INVALID_JSON";
      parseError.details = { httpStatus: response.status, rawBody: rawText.slice(0, 300) };
      throw parseError;
    }

    return { httpStatus: response.status, ok: response.ok, data };
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutError = new Error(`Pesaflux request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
      timeoutError.statusCode = 504;
      timeoutError.code = "UPSTREAM_TIMEOUT";
      throw timeoutError;
    }

    if (!err.statusCode) {
      const networkError = new Error("Unable to reach Pesaflux API.");
      networkError.statusCode = 502;
      networkError.code = "UPSTREAM_NETWORK_ERROR";
      networkError.details = err.message;
      throw networkError;
    }

    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function upsertTransaction(requestId, patch) {
  if (!requestId) return null;
  const current = transactions.get(requestId) || {
    transaction_request_id: requestId,
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  transactions.set(requestId, next);
  return next;
}

// Health check for Render
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "pesaflux-backend",
    timestamp: new Date().toISOString()
  });
});

// 1. Initiate STK Push from frontend
// POST /stkpush  { "amount": "30", "msisdn": "254768783443", "reference": "6527990" }
app.post("/stkpush", async (req, res) => {
  try {
    const { api_key, email } = getConfig();
    const { amount, msisdn, reference } = req.body || {};

    const cleanAmount = String(amount ?? "").trim();
    const cleanPhone = normalizePhone(msisdn);
    const cleanRef = "FULIZABOOST";

    if (!cleanAmount || Number.isNaN(Number(cleanAmount)) || Number(cleanAmount) <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AMOUNT",
        message: "Provide a valid positive amount (e.g. \"30\")."
      });
    }

    if (!/^254[17]\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_MSISDN",
        message: "Provide a valid Kenyan phone number in 2547XXXXXXXX or 2541XXXXXXXX format."
      });
    }

    if (!cleanRef) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REFERENCE",
        message: "Reference cannot be empty."
      });
    }

    const upstream = await postToPesaflux("/initiatestk", {
      api_key,
      email,
      amount: cleanAmount,
      msisdn: cleanPhone,
      reference: cleanRef
    });

    const data = upstream.data || {};
    const requestId = data.transaction_request_id || null;
    const initiated = upstream.ok && String(data.success) === "200" && Boolean(requestId);

    if (requestId) {
      upsertTransaction(requestId, {
        amount: cleanAmount,
        msisdn: cleanPhone,
        reference: cleanRef,
        status: initiated ? "PromptSent" : "Failed",
        initiateResponse: data
      });
    }

    if (!initiated) {
      return res.status(upstream.ok ? 400 : 502).json({
        ok: false,
        error: "STK_INITIATE_FAILED",
        message: data.massage || data.message || "Pesaflux did not confirm STK push initiation.",
        transaction_request_id: requestId,
        data
      });
    }

    return res.status(200).json({
      ok: true,
      message: data.massage || data.message || "Request sent successfully.",
      transaction_request_id: requestId,
      reference: cleanRef,
      amount: cleanAmount,
      msisdn: cleanPhone,
      data
    });
  } catch (err) {
    console.error("[/stkpush] Error:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.code || "INTERNAL_SERVER_ERROR",
      message: err.message || "Failed to initiate STK push.",
      details: err.details || undefined
    });
  }
});

// 2. Check Transaction Status from frontend
// POST /status  { "transaction_request_id": "..." }  (also supports GET /status?transaction_request_id=...)
async function handleStatusCheck(req, res) {
  try {
    const { api_key, email } = getConfig();
    const transaction_request_id = String(
      req.body?.transaction_request_id || req.query?.transaction_request_id || ""
    ).trim();

    if (!transaction_request_id) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_REQUEST_ID",
        message: "transaction_request_id is required."
      });
    }

    const upstream = await postToPesaflux("/transactionstatus", {
      api_key,
      email,
      transaction_request_id
    });

    const data = upstream.data || {};
    const existing = transactions.get(transaction_request_id) || {};

    // Preserve a completed state if a callback already marked it Completed
    const incomingStatus = data.TransactionStatus || existing.status || "Pending";
    const resolvedStatus =
      existing.status === "Completed" && incomingStatus !== "Completed"
        ? "Completed"
        : incomingStatus;

    const record = upsertTransaction(transaction_request_id, {
      status: resolvedStatus,
      resultCode: data.ResultCode ?? existing.resultCode ?? null,
      resultDesc: data.ResultDesc ?? existing.resultDesc ?? null,
      transactionId: data.TransactionID ?? existing.transactionId ?? null,
      transactionCode: data.TransactionCode ?? existing.transactionCode ?? null,
      receipt: data.TransactionReceipt ?? existing.receipt ?? null,
      amount: data.TransactionAmount ?? existing.amount ?? null,
      msisdn: data.Msisdn ?? existing.msisdn ?? null,
      reference: data.TransactionReference ?? existing.reference ?? null,
      transactionDate: data.TransactionDate ?? existing.transactionDate ?? null,
      statusResponse: data
    });

    return res.status(upstream.ok ? 200 : 502).json({
      ok: upstream.ok,
      transaction_request_id,
      status: record.status,
      result_code: record.resultCode,
      result_desc: record.resultDesc,
      receipt: record.receipt,
      amount: record.amount,
      msisdn: record.msisdn,
      reference: record.reference,
      transaction_date: record.transactionDate,
      data
    });
  } catch (err) {
    console.error("[/status] Error:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.code || "INTERNAL_SERVER_ERROR",
      message: err.message || "Failed to fetch transaction status.",
      details: err.details || undefined
    });
  }
}

app.post("/status", handleStatusCheck);
app.get("/status", handleStatusCheck);

// 3. Callback receiver (for webhook/callback payloads pushed to your backend)
// POST /callback
app.post("/callback", (req, res) => {
  try {
    const payload = req.body;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CALLBACK_PAYLOAD",
        message: "Callback body must be a JSON object."
      });
    }

    const requestId = String(
      payload.transaction_request_id ||
        payload.TransactionRequestID ||
        payload.TransactionID ||
        ""
    ).trim();

    if (requestId) {
      upsertTransaction(requestId, {
        status: payload.TransactionStatus || payload.status || "CallbackReceived",
        resultCode: payload.ResultCode ?? null,
        resultDesc: payload.ResultDesc ?? null,
        receipt: payload.TransactionReceipt ?? payload.MpesaReceiptNumber ?? null,
        amount: payload.TransactionAmount ?? payload.Amount ?? null,
        msisdn: payload.Msisdn ?? payload.PhoneNumber ?? null,
        reference: payload.TransactionReference ?? payload.reference ?? null,
        callbackPayload: payload
      });
    }

    console.log("[/callback] Received:", JSON.stringify(payload));

    // Acknowledge receipt immediately so the caller gets a clean 200 response
    return res.status(200).json({
      ok: true,
      message: "Callback received",
      transaction_request_id: requestId || null
    });
  } catch (err) {
    console.error("[/callback] Error:", err);
    return res.status(500).json({
      ok: false,
      error: "CALLBACK_PROCESSING_ERROR",
      message: "Failed to process callback payload."
    });
  }
});

// 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    message: `Route ${req.method} ${req.originalUrl} does not exist.`
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
