import { getUser, getUserProfile } from '../_supabase.js';
import { securityCheck } from '../_security.js';
import { PLANS } from '../_stripe.js';

export default async function handler(req, res) {
  const security = securityCheck(req, res);
  if (security.handled) return;

  const { user, error } = await getUser(req);
  if (error) {
    return res.status(401).json({ error });
  }

  const profile = await getUserProfile(user.id);
  const plan = PLANS[profile?.plan || 'free'];

  return res.status(200).json({
    user: { id: user.id, email: user.email },
    plan: {
      name: profile?.plan || 'free',
      displayName: plan.name,
      monthlyLimit: plan.monthlyLimit,
      monthlyUsage: profile?.monthly_usage || 0,
      usageResetAt: profile?.usage_reset_at,
    },
  });
}
