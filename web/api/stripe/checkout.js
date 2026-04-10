import { getUser, getUserProfile } from '../_supabase.js';
import { getStripe, getPriceId } from '../_stripe.js';
import { getSupabaseAdmin } from '../_supabase.js';
import { securityCheck } from '../_security.js';

export default async function handler(req, res) {
  const security = securityCheck(req, res);
  if (security.handled) return;

  const { user, error } = await getUser(req);
  if (error) return res.status(401).json({ error });

  const { plan } = req.body || {};
  if (!plan || !['lite', 'standard'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan. Choose: lite or standard' });
  }

  const priceId = getPriceId(plan);
  if (!priceId) {
    return res.status(500).json({ error: 'Stripe price not configured' });
  }

  const stripe = getStripe();
  const profile = await getUserProfile(user.id);

  // 既存のStripe顧客があればそれを使う
  let customerId = profile?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;

    // プロフィールにStripe顧客IDを保存
    const admin = getSupabaseAdmin();
    await admin
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('user_id', user.id);
  }

  // Checkout Session作成
  const baseUrl = process.env.APP_URL || 'https://web-five-alpha-24.vercel.app';
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/dashboard.html?payment=success`,
    cancel_url: `${baseUrl}/dashboard.html?payment=cancel`,
    metadata: { supabase_user_id: user.id, plan },
  });

  return res.status(200).json({ url: session.url });
}
