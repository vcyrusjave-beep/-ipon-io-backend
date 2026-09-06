/**
 * Minimal backend for ipon.io's real GCash <-> Xendit connection.
 *
 * Why this exists: ipon_io-xendit-gcash.html is a static, client-side page. A Xendit
 * secret key must never be shipped to a browser, so every call that needs it (creating
 * the linked payment method, checking its status, charging it, receiving webhooks) has
 * to go through a server. This is that server.
 *
 * Scope / honesty check:
 *  - This tracks ONE linked GCash account in a flat JSON file (store.json). That's fine
 *    for a personal prototype or single-user demo. For multiple real users you'd swap
 *    store.json for a real database keyed by your own user IDs, and add real
 *    authentication in front of every /api/gcash/* route below.
 *  - Xendit does not expose a way to read a user's live GCash balance. Once linked, this
 *    backend can only ever PUSH a charge for an amount ipon.io decides to collect — it
 *    can't inspect the wallet. The frontend's "spare money" detection stays a local
 *    heuristic; only the actual money movement for a confirmed amount is real.
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  XENDIT_SECRET_KEY,
  XENDIT_WEBHOOK_VERIFICATION_TOKEN,
  APP_BASE_URL = "http://localhost:8787",
  PORT = 8787,
} = process.env;

if (!XENDIT_SECRET_KEY) {
  console.warn(
    "\n[WARN] XENDIT_SECRET_KEY is not set. Copy .env.example to .env and fill it in — " +
      "linking will fail until you do.\n"
  );
}

const XENDIT_API = "https://api.xendit.co";
const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------------------------- */
/* Tiny JSON-file store. Single demo/personal user. Replace with a real   */
/* database + per-user rows before letting more than one person use this. */
/* ---------------------------------------------------------------------- */
const DB_PATH = path.join(__dirname, "store.json");

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (e) {
    return { customerId: null, paymentMethodId: null, status: null, collections: [] };
  }
}
function writeStore(store) {
  fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
}

/* ---------------------------------------------------------------------- */
/* Thin Xendit REST client (HTTP Basic auth: secret key as username).     */
/* ---------------------------------------------------------------------- */
function xenditAuthHeader() {
  return "Basic " + Buffer.from(`${XENDIT_SECRET_KEY}:`).toString("base64");
}

async function xenditRequest(pathname, { method = "GET", body, extraHeaders } = {}) {
  const res = await fetch(`${XENDIT_API}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: xenditAuthHeader(),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error_code || `Xendit API error (HTTP ${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function ensureXenditCustomer() {
  const store = readStore();
  if (store.customerId) return store.customerId;

  const customer = await xenditRequest("/customers", {
    method: "POST",
    body: {
      reference_id: "ipon-io-demo-user",
      type: "INDIVIDUAL",
      individual_detail: { given_names: "Ipon", surname: "User" },
      email: "demo.user@ipon.io",
    },
  });

  store.customerId = customer.id;
  writeStore(store);
  return customer.id;
}

/* ---------------------------------------------------------------------- */
/* Routes                                                                  */
/* ---------------------------------------------------------------------- */

// 1) Start (or resume) linking GCash as a reusable Xendit payment method.
app.post("/api/gcash/link", async (req, res) => {
  try {
    const customerId = await ensureXenditCustomer();

    const paymentMethod = await xenditRequest("/v2/payment_methods", {
      method: "POST",
      body: {
        type: "EWALLET",
        reusability: "MULTIPLE_USE",
        customer_id: customerId,
        ewallet: {
          channel_code: "GCASH",
          channel_properties: {
            success_return_url: `${APP_BASE_URL}/gcash-return.html?status=success`,
            failure_return_url: `${APP_BASE_URL}/gcash-return.html?status=failure`,
            cancel_return_url: `${APP_BASE_URL}/gcash-return.html?status=cancel`,
          },
        },
      },
    });

    const store = readStore();
    store.paymentMethodId = paymentMethod.id;
    store.status = paymentMethod.status; // usually REQUIRES_ACTION
    writeStore(store);

    const authAction = (paymentMethod.actions || []).find((a) => a.action === "AUTH");
    res.json({
      paymentMethodId: paymentMethod.id,
      status: paymentMethod.status,
      authUrl: authAction ? authAction.url : null,
    });
  } catch (e) {
    console.error("[/api/gcash/link]", e.data || e.message);
    res.status(e.status || 500).json({ error: e.message, details: e.data });
  }
});

// 2) Poll (or check on load) whether the linked GCash is active yet.
app.get("/api/gcash/status", async (req, res) => {
  const store = readStore();
  if (!store.paymentMethodId) return res.json({ linked: false, status: null, paymentMethodId: null });

  try {
    const paymentMethod = await xenditRequest(`/v2/payment_methods/${store.paymentMethodId}`);
    store.status = paymentMethod.status;
    writeStore(store);
    res.json({
      linked: paymentMethod.status === "ACTIVE",
      status: paymentMethod.status,
      paymentMethodId: paymentMethod.id,
    });
  } catch (e) {
    console.error("[/api/gcash/status]", e.data || e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 3) Disconnect: deactivate on Xendit's side and forget it locally.
app.post("/api/gcash/disconnect", async (req, res) => {
  const store = readStore();
  if (!store.paymentMethodId) return res.json({ ok: true });

  try {
    await xenditRequest(`/v2/payment_methods/${store.paymentMethodId}`, {
      method: "PATCH",
      body: { status: "INACTIVE" },
    });
  } catch (e) {
    console.warn("[/api/gcash/disconnect] Xendit deactivation failed, clearing locally anyway:", e.message);
  }

  store.paymentMethodId = null;
  store.status = null;
  writeStore(store);
  res.json({ ok: true });
});

// 4) Charge the linked GCash for one confirmed spare-money collection.
app.post("/api/gcash/collect", async (req, res) => {
  const { amount, referenceId } = req.body || {};
  const store = readStore();

  if (!store.paymentMethodId || store.status !== "ACTIVE") {
    return res.status(400).json({ error: "GCash is not linked yet." });
  }
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) {
    return res.status(400).json({ error: "Invalid amount." });
  }

  const idempotencyKey = referenceId || crypto.randomUUID();
  try {
    const paymentRequest = await xenditRequest("/payment_requests", {
      method: "POST",
      extraHeaders: { "Idempotency-Key": idempotencyKey },
      body: {
        reference_id: idempotencyKey,
        type: "PAY",
        country: "PH",
        currency: "PHP",
        request_amount: parsedAmount,
        capture_method: "AUTOMATIC",
        payment_method_id: store.paymentMethodId,
        description: "ipon.io spare-money collection",
      },
    });

    store.collections = store.collections || [];
    store.collections.push({
      id: paymentRequest.id,
      referenceId: idempotencyKey,
      amount: parsedAmount,
      status: paymentRequest.status,
      createdAt: new Date().toISOString(),
    });
    writeStore(store);

    res.json({ id: paymentRequest.id, status: paymentRequest.status });
  } catch (e) {
    console.error("[/api/gcash/collect]", e.data || e.message);
    res.status(e.status || 500).json({ error: e.message, details: e.data });
  }
});

// 5) Webhook receiver — keeps status current even if the user never returns to the tab
//    that started linking, and confirms/fails collections asynchronously.
//    Point Xendit Dashboard > Settings > Webhooks at: <your-public-url>/api/webhooks/xendit
app.post("/api/webhooks/xendit", (req, res) => {
  const token = req.header("x-callback-token");
  if (!XENDIT_WEBHOOK_VERIFICATION_TOKEN || token !== XENDIT_WEBHOOK_VERIFICATION_TOKEN) {
    return res.status(401).send("invalid webhook token");
  }

  const event = req.body || {};
  const data = event.data || {};
  const store = readStore();

  if (data.id && data.id === store.paymentMethodId && data.status) {
    store.status = data.status;
  }

  const collection = (store.collections || []).find((c) => c.id === data.id);
  if (collection && data.status) {
    collection.status = data.status;
  }

  writeStore(store);
  res.sendStatus(200);
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ipon.io Xendit backend listening on http://localhost:${PORT}`);
});
