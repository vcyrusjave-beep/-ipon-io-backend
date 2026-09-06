# ipon.io — real GCash linking via Xendit

This backend + the updated `ipon_io-xendit-gcash.html` replace ipon.io's simulated
GCash linking with a real one, using Xendit's **Payment Methods API** (e-wallet
linked account, `reusability: MULTIPLE_USE`, `channel_code: GCASH`).

## Why a backend at all?

The HTML file is entirely client-side. A Xendit **secret key** can authorize real money
movement, so it can never sit in a browser-loadable file — anyone could view-source it.
This Express server holds the secret key and is the only thing that talks to Xendit
directly. The HTML talks to *this server*, never to Xendit.

## What's real vs. still simulated

- **Real:** linking GCash (Xendit's hosted authorization redirect), the linked
  payment method's status, and charging that payment method for a confirmed
  collection amount.
- **Still simulated:** "spare money" detection. Xendit and GCash don't expose an API
  to read a live wallet balance, so ipon.io's local heuristic (loose change above
  the last ₱100) stays exactly as it was — only the money movement for a *confirmed*
  amount is now real once GCash is linked.
- **Still simulated:** Google sign-in and Premium billing (unchanged, unrelated to Xendit).

## Setup

```bash
cd backend
npm install
cp .env.example .env
# edit .env: XENDIT_SECRET_KEY, XENDIT_WEBHOOK_VERIFICATION_TOKEN, APP_BASE_URL
npm start
```

The server listens on `http://localhost:8787` by default.

### Point the frontend at it

Open `ipon_io-xendit-gcash.html` with `?api=http://localhost:8787`, or set
`window.IPON_API_BASE = "http://localhost:8787"` in a `<script>` tag before the
app's own script runs, or just edit the `API_BASE` fallback in the file directly.

### Xendit Dashboard steps

1. **API key** — Settings → API Keys → copy your secret key (start with the **test**
   key, `sk_test_...`) into `XENDIT_SECRET_KEY`.
2. **Webhook** — Settings → Webhooks → add
   `https://<wherever-this-backend-is-publicly-reachable>/api/webhooks/xendit`,
   enable the *Payment Method* and *Payment Request* events, then copy the
   **Verification Token** shown there into `XENDIT_WEBHOOK_VERIFICATION_TOKEN`.
   (Xendit can't reach `localhost` — use a tunnel like `ngrok http 8787` while
   testing and use the tunnel's HTTPS URL both here and in `.env`'s `APP_BASE_URL`.)
3. **GCash channel** — GCash e-wallet linking may need to be enabled for your
   business on Xendit before `channel_code: GCASH` will work in live mode; test
   mode works out of the box with Xendit's e-wallet simulator.

## API this backend exposes to the frontend

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/gcash/link` | Creates the Xendit customer (once) + a `EWALLET`/`GCASH` payment method, returns the `authUrl` to send the user to. |
| `GET`  | `/api/gcash/status` | Current link status (`REQUIRES_ACTION`, `ACTIVE`, `FAILED`, …). |
| `POST` | `/api/gcash/disconnect` | Deactivates the payment method on Xendit and forgets it locally. |
| `POST` | `/api/gcash/collect` | Charges the linked GCash `{ amount, referenceId }` via a Payment Request. |
| `POST` | `/api/webhooks/xendit` | Receives Xendit's async status updates. |

## Before this touches real money

- `store.json` holds one linked account for one user — fine for a personal build,
  not for multiple real users. Swap it for a real database keyed by your own
  authenticated user IDs, and put real auth in front of every `/api/gcash/*` route.
- Test end-to-end in **test mode** first (Xendit's e-wallet simulator lets you
  approve/fail a linking attempt without a real GCash account).
- Only switch `XENDIT_SECRET_KEY` to a **live** key once you've confirmed the full
  link → webhook → collect flow works in test mode.
