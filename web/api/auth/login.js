import { getSupabaseClient } from '../_supabase.js';
import { securityCheck } from '../_security.js';

export default async function handler(req, res) {
  const security = securityCheck(req, res);
  if (security.handled) return;

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません' });
  }

  return res.status(200).json({
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email },
  });
}
