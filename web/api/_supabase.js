/**
 * Supabase クライアント + 認証ヘルパー
 * 環境変数: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY
 */
import { createClient } from '@supabase/supabase-js';

// 公開用クライアント（フロントエンド用）
export function getSupabaseClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
}

// 管理用クライアント（サーバー側のみ、RLS バイパス）
export function getSupabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

/**
 * リクエストからユーザーを取得（Authorization: Bearer <token>）
 * @returns {user, error} - ユーザー情報またはエラー
 */
export async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, error: 'Authorization header required' };
  }

  const token = authHeader.replace('Bearer ', '');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return { user: null, error: error?.message || 'Invalid token' };
  }

  return { user: data.user, error: null };
}

/**
 * ユーザーのプロフィール（プラン・使用量）を取得
 */
export async function getUserProfile(userId) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code === 'PGRST116') {
    // プロフィールが存在しない場合、作成
    const { data: newProfile } = await admin
      .from('profiles')
      .insert({
        user_id: userId,
        plan: 'free',
        monthly_usage: 0,
        usage_reset_at: getNextResetDate(),
      })
      .select()
      .single();
    return newProfile;
  }

  return data;
}

/**
 * 使用量をインクリメント（月間リセット付き）
 */
export async function incrementUsage(userId) {
  const admin = getSupabaseAdmin();
  const profile = await getUserProfile(userId);
  if (!profile) return { allowed: false, reason: 'Profile not found' };

  const now = new Date();
  const resetAt = new Date(profile.usage_reset_at);

  // 月間リセット
  if (now >= resetAt) {
    await admin
      .from('profiles')
      .update({
        monthly_usage: 1,
        usage_reset_at: getNextResetDate(),
      })
      .eq('user_id', userId);
    return { allowed: true, usage: 1, plan: profile.plan };
  }

  // プラン別制限チェック
  const limits = { free: 30, lite: 300, standard: -1 }; // -1 = 無制限
  const limit = limits[profile.plan] || 30;

  if (limit !== -1 && profile.monthly_usage >= limit) {
    return {
      allowed: false,
      reason: `月間上限（${limit}回）に達しました。プランをアップグレードしてください。`,
      usage: profile.monthly_usage,
      limit,
      plan: profile.plan,
    };
  }

  // インクリメント
  await admin
    .from('profiles')
    .update({ monthly_usage: profile.monthly_usage + 1 })
    .eq('user_id', userId);

  return {
    allowed: true,
    usage: profile.monthly_usage + 1,
    limit,
    plan: profile.plan,
  };
}

function getNextResetDate() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return next.toISOString();
}
