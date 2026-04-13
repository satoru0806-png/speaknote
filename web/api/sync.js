/**
 * 同期API - 辞書・メモ・履歴・設定をクラウド保存/読込
 *
 * 認証方式（2種類）:
 *   方式A: x-api-key ヘッダーにPro key（Stripe顧客ID or テスターキー or オーナーキー）
 *          → pro_dataテーブルを使用
 *   方式B: Authorization: Bearer <token>（Supabaseセッション）
 *          → user_dataテーブルを使用
 *
 * POST /api/sync
 *   body: { action: 'get' } → 全データ取得
 *   body: { action: 'put', data: { dict, memos, history, settings } } → 保存
 */
import { securityCheck } from './_security.js';
import { getUser, getSupabaseAdmin } from './_supabase.js';

// Pro key検証（clean.jsと同じロジック）
async function checkProApiKey(apiKey) {
  if (!apiKey) return false;

  // オーナーキー
  const ownerKey = process.env.OWNER_PRO_KEY;
  if (ownerKey && apiKey === ownerKey) return true;

  // テスターキー
  const testerKeys = (process.env.TESTER_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (testerKeys.includes(apiKey)) return true;

  // Stripe検証
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return false;
  try {
    const response = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${apiKey}&status=active&limit=1`, {
      headers: { 'Authorization': `Bearer ${secretKey}` },
    });
    const subs = await response.json();
    return (subs.data?.length || 0) > 0;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const security = securityCheck(req, res);
  if (security.handled) return;

  const admin = getSupabaseAdmin();
  const { action, data } = req.body || {};

  // === 方式A: Pro key ===
  const proKey = req.headers['x-api-key'];
  if (proKey) {
    const isPro = await checkProApiKey(proKey);
    if (!isPro) return res.status(401).json({ error: 'Invalid Pro key' });

    if (action === 'get') {
      const { data: row, error } = await admin
        .from('pro_data').select('*').eq('pro_key', proKey).single();
      if (error && error.code === 'PGRST116') {
        return res.status(200).json({ dict: [], memos: [], history: [], settings: {}, updated_at: null });
      }
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({
        dict: row.dict || [], memos: row.memos || [],
        history: row.history || [], settings: row.settings || {},
        updated_at: row.updated_at,
      });
    }

    if (action === 'put') {
      const d = data || {};
      const payload = {
        pro_key: proKey,
        dict: Array.isArray(d.dict) ? d.dict.slice(0, 500) : [],
        memos: Array.isArray(d.memos) ? d.memos.slice(0, 200) : [],
        history: Array.isArray(d.history) ? d.history.slice(0, 100) : [],
        settings: typeof d.settings === 'object' && d.settings ? d.settings : {},
      };
      const { error } = await admin.from('pro_data').upsert(payload, { onConflict: 'pro_key' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'invalid action' });
  }

  // === 方式B: Supabase token ===
  const { user, error: authError } = await getUser(req);
  if (!user) return res.status(401).json({ error: authError || 'Unauthorized' });

  if (action === 'get') {
    const { data: row, error } = await admin
      .from('user_data').select('*').eq('user_id', user.id).single();
    if (error && error.code === 'PGRST116') {
      return res.status(200).json({ dict: [], memos: [], history: [], settings: {}, updated_at: null });
    }
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({
      dict: row.dict || [], memos: row.memos || [],
      history: row.history || [], settings: row.settings || {},
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
    const { error } = await admin.from('user_data').upsert(payload, { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: 'invalid action' });
}
