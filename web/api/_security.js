/**
 * SpeakNote API Security Middleware
 * - CORS制限（許可ドメインのみ）
 * - レート制限（IP単位、インメモリ + 定期クリーンアップ）
 * - 入力バリデーション（テキスト長・サイズ制限）
 * - APIキー認証（オプション、将来のSaaS用）
 */

// 許可するオリジン
const ALLOWED_ORIGINS = [
  'https://web-five-alpha-24.vercel.app',
  'https://speaknote.app',
  'http://localhost:3000',
  'http://localhost:5173',
];

// Android/PCアプリからのリクエスト（Originなし）も許可
const ALLOW_NO_ORIGIN = true;

// レート制限設定
const RATE_LIMITS = {
  default: { maxRequests: 30, windowMs: 60 * 1000 },    // 30回/分
  authenticated: { maxRequests: 60, windowMs: 60 * 1000 }, // 60回/分（APIキー付き）
};

// テキスト制限
const MAX_TEXT_LENGTH = 5000;
const MAX_BODY_SIZE = 50 * 1024; // 50KB

// レート制限ストア（インメモリ、Vercel cold start ごとにリセット）
const rateLimitStore = new Map();
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5分ごとにクリーンアップ
let lastCleanup = Date.now();

function cleanupStore() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, data] of rateLimitStore.entries()) {
    if (now - data.windowStart > RATE_LIMITS.default.windowMs * 2) {
      rateLimitStore.delete(key);
    }
  }
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

function checkRateLimit(ip, isAuthenticated) {
  cleanupStore();
  const now = Date.now();
  const limit = isAuthenticated ? RATE_LIMITS.authenticated : RATE_LIMITS.default;
  const key = `${ip}:${isAuthenticated ? 'auth' : 'anon'}`;

  let data = rateLimitStore.get(key);
  if (!data || now - data.windowStart > limit.windowMs) {
    data = { count: 0, windowStart: now };
    rateLimitStore.set(key, data);
  }

  data.count++;
  const remaining = Math.max(0, limit.maxRequests - data.count);
  const resetAt = data.windowStart + limit.windowMs;

  return {
    allowed: data.count <= limit.maxRequests,
    remaining,
    resetAt,
    limit: limit.maxRequests,
  };
}

/**
 * セキュリティチェックを実行
 * @returns {null} 問題なし、または {status, body} エラー
 */
export function securityCheck(req, res) {
  const origin = req.headers.origin;

  // 1. CORS設定
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
    }
  } else if (ALLOW_NO_ORIGIN) {
    // Androidアプリ等、Originなしのリクエストを許可
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');

  // セキュリティヘッダー
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // 2. OPTIONSプリフライト
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return { handled: true };
  }

  // 3. POST以外を拒否
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return { handled: true };
  }

  // 4. APIキー認証チェック（オプション）
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.SPEAKNOTE_API_KEY;
  const isAuthenticated = validApiKey && apiKey === validApiKey;

  // 5. レート制限
  const ip = getClientIP(req);
  const rateResult = checkRateLimit(ip, isAuthenticated);

  res.setHeader('X-RateLimit-Limit', rateResult.limit.toString());
  res.setHeader('X-RateLimit-Remaining', rateResult.remaining.toString());
  res.setHeader('X-RateLimit-Reset', Math.ceil(rateResult.resetAt / 1000).toString());

  if (!rateResult.allowed) {
    res.status(429).json({
      error: 'レート制限を超えました。しばらく待ってから再試行してください。',
      retryAfter: Math.ceil((rateResult.resetAt - Date.now()) / 1000),
    });
    return { handled: true };
  }

  return { handled: false, isAuthenticated, ip };
}

/**
 * テキスト入力のバリデーション
 */
export function validateTextInput(req, res, fieldName = 'text') {
  const body = req.body || {};
  const text = body[fieldName];

  // Content-Typeチェック
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    res.status(400).json({ error: 'Content-Type must be application/json' });
    return null;
  }

  // テキスト存在チェック
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: `${fieldName} is required` });
    return null;
  }

  // テキスト長制限
  if (text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({
      error: `テキストが長すぎます（最大${MAX_TEXT_LENGTH}文字）`,
      maxLength: MAX_TEXT_LENGTH,
      actualLength: text.length,
    });
    return null;
  }

  return text.trim();
}
