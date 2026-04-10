/**
 * Stripe Customer Portal API
 * Proユーザーがサブスク管理（解約・カード変更）をするためのポータルURL生成
 */
import { securityCheck } from '../_security.js';

export default async function handler(req, res) {
  const security = securityCheck(req, res);
  if (security.handled) return;

  const customerId = req.headers['x-api-key'] || req.body?.customerId;
  if (!customerId) return res.status(400).json({ error: 'Customer ID required' });

  // customer IDバリデーション（cus_ プレフィックス + 英数字）
  if (!/^cus_[a-zA-Z0-9]+$/.test(customerId)) {
    return res.status(400).json({ error: 'Invalid customer ID format' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Stripe not configured' });

  const returnUrl = (req.headers.origin || 'https://web-five-alpha-24.vercel.app') + '/';

  try {
    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer: customerId,
        return_url: returnUrl,
      }).toString(),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[portal] Stripe error:', data);
      return res.status(500).json({ error: 'ポータルの作成に失敗しました' });
    }

    return res.status(200).json({ url: data.url });
  } catch (err) {
    console.error('[portal] Error:', err.message);
    return res.status(500).json({ error: 'ポータルの作成に失敗しました' });
  }
}
