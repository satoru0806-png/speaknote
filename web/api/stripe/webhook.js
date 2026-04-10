import { getStripe, getPlanByPriceId } from '../_stripe.js';
import { getSupabaseAdmin } from '../_supabase.js';

// Vercel: raw bodyを有効化
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

  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return res.status(400).json({ error: 'Missing signature or webhook secret' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const admin = getSupabaseAdmin();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.supabase_user_id;
      const plan = session.metadata?.plan;
      if (userId && plan) {
        await admin
          .from('profiles')
          .update({
            plan,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
          })
          .eq('user_id', userId);
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      // プラン変更を反映
      const priceId = subscription.items?.data?.[0]?.price?.id;
      const newPlan = getPlanByPriceId(priceId);

      const { data: profiles } = await admin
        .from('profiles')
        .select('user_id')
        .eq('stripe_customer_id', customerId);

      if (profiles?.length > 0) {
        await admin
          .from('profiles')
          .update({ plan: newPlan })
          .eq('stripe_customer_id', customerId);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      // 解約 → freeプランに戻す
      await admin
        .from('profiles')
        .update({
          plan: 'free',
          stripe_subscription_id: null,
        })
        .eq('stripe_customer_id', customerId);
      break;
    }
  }

  return res.status(200).json({ received: true });
}
