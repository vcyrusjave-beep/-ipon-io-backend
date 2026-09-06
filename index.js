require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Xendit } = require('xendit-node');
const { pool, ensureSchema } = require('./db');

const app = express();
app.use(cors({ origin: process.env.APP_BASE_URL || '*' }));
app.use(express.json());

const xenditClient = new Xendit({ secretKey: process.env.XENDIT_SECRET_KEY });
const { EWallet } = xenditClient;

// --- Health check ---
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ipon-io-backend' });
});

// --- Create a cash-in / top-up ---
// Frontend calls this to start an e-wallet top-up (e.g. GCash, Maya).
// Expects: { userId, amount, channelCode } e.g. channelCode: "PH_GCASH" or "PH_PAYMAYA"
app.post('/api/topup', async (req, res) => {
  try {
    const { userId, amount, channelCode } = req.body;

    if (!userId || !amount || !channelCode) {
      return res.status(400).json({ error: 'userId, amount, and channelCode are required' });
    }

    const externalId = `topup-${userId}-${Date.now()}`;

    const charge = await EWallet.createEWalletCharge({
      data: {
        referenceId: externalId,
        currency: 'PHP',
        amount: Number(amount),
        checkoutMethod: 'ONE_TIME_PAYMENT',
        channelCode,
        channelProperties: {
          successRedirectUrl: `${process.env.APP_BASE_URL}/topup/success`,
          failureRedirectUrl: `${process.env.APP_BASE_URL}/topup/failed`,
        },
      },
    });

    await pool.query(
      `INSERT INTO topups (external_id, user_id, amount, channel_code, status, xendit_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [externalId, userId, amount, channelCode, charge.status, charge.id]
    );

    res.json({
      externalId,
      checkoutUrl: charge.actions?.mobileWebCheckoutUrl || charge.actions?.desktopWebCheckoutUrl,
      status: charge.status,
    });
  } catch (err) {
    console.error('Error creating top-up:', err);
    res.status(500).json({ error: 'Failed to create top-up' });
  }
});

// --- Check top-up status (frontend polling, optional) ---
app.get('/api/topup/:externalId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT external_id, user_id, amount, status, created_at, updated_at
       FROM topups WHERE external_id = $1`,
      [req.params.externalId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error fetching top-up:', err);
    res.status(500).json({ error: 'Failed to fetch top-up' });
  }
});

// --- Xendit webhook: fires when payment status changes ---
app.post('/api/webhook', async (req, res) => {
  const token = req.headers['x-callback-token'];

  if (token !== process.env.XENDIT_WEBHOOK_VERIFICATION_TOKEN) {
    console.warn('Rejected webhook: invalid verification token');
    return res.status(401).json({ error: 'Invalid verification token' });
  }

  try {
    const event = req.body;
    const externalId = event.reference_id || event.referenceId || event.external_id;
    const status = event.status;

    if (externalId && status) {
      await pool.query(
        `UPDATE topups SET status = $1, updated_at = now() WHERE external_id = $2`,
        [status, externalId]
      );
      console.log(`Top-up ${externalId} updated to ${status}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Error handling webhook:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

const PORT = process.env.PORT || 3000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`ipon-io-backend listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to set up database schema:', err);
    process.exit(1);
  });
