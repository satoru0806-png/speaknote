/**
 * Stripe Checkout Session 作成 API
 * Pro プラン ¥500/月（サブスクリプション）
 * 環境変数: STRIPE_SECRET_KEY, STRIPE_PRICE_PRO
 * Note: Stripe SDKの接続問題を回避するため、fetch APIを直接使用
 */

const ALLOWED_ORIGINS = [
  'https://web-five-alpha-24.vercel.app',
  'https://speaknote.app',
];

export default async function handler(req, res) {
  // CORS ヘッダ
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (origin) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return res.status(500).json({ error: 'Stripe not configured' });

  const priceId = process.env.STRIPE_PRICE_PRO?.trim();
  if (!priceId) return res.status(500).json({ error: 'STRIPE_PRICE_PRO not configured' });

  const origin = req.headers.origin || process.env.APP_URL || 'https://web-five-alpha-24.vercel.app';

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'payment_method_types[]': 'card',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'success_url': `${origin}/pro-success.html?session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `${origin}/lp.html`,
      }).toString(),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[create-checkout] Stripe API error:', data);
      return res.status(500).json({ error: data.error?.message || 'Stripe error' });
    }

    return res.status(200).json({ url: data.url });
  } catch (err) {
    console.error('[create-checkout] Error:', err.message);
    return res.status(500).json({ error: '決済セッションの作成に失敗しました' });
  }
}
