import { getSupabaseClient } from '../_supabase.js';
import { securityCheck } from '../_security.js';

export default async function handler(req, res) {
  const security = securityCheck(req, res);
  if (security.handled) return;

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({
    message: '登録完了。確認メールをご確認ください。',
    user: { id: data.user?.id, email: data.user?.email },
  });
}
