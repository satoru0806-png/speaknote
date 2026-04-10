/**
 * Stripe Checkout完了後にAPIキー（= Stripe顧客ID）を返却
 * session_id を検証してからキーを発行
 * Note: Stripe SDKの接続問題を回避するため、fetch APIを直接使用
 */

const ALLOWED_ORIGINS = [
  'https://web-five-alpha-24.vercel.app',
  'https://speaknote.app',
];

export default async function handler(req, res) {
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

  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  // session_id バリデーション（Stripe Checkout Session IDは cs_ プレフィックス + 英数字）
  if (!/^cs_[a-zA-Z0-9_]+$/.test(session_id)) {
    return res.status(400).json({ error: 'Invalid session_id format' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Stripe not configured' });

  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session_id}`, {
      headers: {
        'Authorization': `Bearer ${secretKey}`,
      },
    });

    const session = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: 'Stripe session retrieval failed' });
    }

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    return res.status(200).json({
      apiKey: session.customer,
      email: session.customer_details?.email,
    });
  } catch (err) {
    console.error('[generate-key] Error:', err.message);
    return res.status(500).json({ error: 'キー取得に失敗しました' });
  }
}
