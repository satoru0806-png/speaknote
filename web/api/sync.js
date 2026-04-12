/**
 * 同期API - 辞書・メモ・履歴・設定をクラウド保存/読込
 * POST /api/sync
 *   body: { action: 'get' } → 全データ取得
 *   body: { action: 'put', data: { dict, memos, history, settings } } → 保存
 * Auth: Authorization: Bearer <access_token> (Supabase session)
 */
import { securityCheck } from './_security.js';
import { getUser, getSupabaseAdmin } from './_supabase.js';

export default async function handler(req, res) {
  const security = securityCheck(req, res);
  if (security.handled) return;

  const { user, error: authError } = await getUser(req);
  if (!user) return res.status(401).json({ error: authError || 'Unauthorized' });

  const { action, data } = req.body || {};
  const admin = getSupabaseAdmin();

  if (action === 'get') {
    const { data: row, error } = await admin
      .from('user_data')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code === 'PGRST116') {
      return res.status(200).json({
        dict: [], memos: [], history: [], settings: {}, updated_at: null,
      });
    }
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({
      dict: row.dict || [],
      memos: row.memos || [],
      history: row.history || [],
      settings: row.settings || {},
      updated_at: row.updated_at,
    });
  }

  if (action === 'put') {
    const d = data || {};
    const payload = {
      user_id: user.id,
      dict: Array.isArray(d.dict) ? d.dict.slice(0, 500) : [],
      memos: Array.isArray(d.memos) ? d.memos.slice(0, 200) : [],
      history: Array.isArray(d.history) ? d.history.slice(0, 100) : [],
      settings: typeof d.settings === 'object' && d.settings ? d.settings : {},
    };

    const { error } = await admin
      .from('user_data')
      .upsert(payload, { onConflict: 'user_id' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'invalid action' });
}
