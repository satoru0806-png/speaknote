/**
 * Stripe Webhook エンドポイント
 * 環境変数: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 */
import Stripe from 'stripe';

// Vercel: raw body を有効化（署名検証に必要）
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    console.error('[webhook] Missing env: STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const stripe = new Stripe(secretKey);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log('[webhook] Event received:', event.type, event.id);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log('[webhook] checkout.session.completed:', {
        customer: session.customer,
        subscription: session.subscription,
        customerEmail: session.customer_email,
        metadata: session.metadata,
      });
      // TODO: DBにサブスク状態を保存（Supabase等）
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      console.log('[webhook] customer.subscription.deleted:', {
        id: subscription.id,
        customer: subscription.customer,
        status: subscription.status,
      });
      // TODO: DBのサブスク状態を解除
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      console.log('[webhook] customer.subscription.updated:', {
        id: subscription.id,
        customer: subscription.customer,
        status: subscription.status,
      });
      break;
    }

    default:
      console.log('[webhook] Unhandled event type:', event.type);
  }

  return res.status(200).json({ received: true });
}
