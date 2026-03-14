/**
 * Stripe Checkout Session 作成 API
 * Pro プラン ¥500/月（サブスクリプション）
 * 環境変数: STRIPE_SECRET_KEY, STRIPE_PRICE_PRO
 */
import Stripe from 'stripe';

export default async function handler(req, res) {
  // CORS ヘッダ
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Stripe not configured' });

  const stripe = new Stripe(secretKey);

  // Price ID: 環境変数 STRIPE_PRICE_PRO が未設定の場合は動的に月額500円プランを作成
  const priceId = process.env.STRIPE_PRICE_PRO;
  if (!priceId) {
    return res.status(500).json({ error: 'STRIPE_PRICE_PRO not configured' });
  }

  const origin = req.headers.origin || process.env.APP_URL || 'https://web-five-alpha-24.vercel.app';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/pro-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/lp.html`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout] Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
