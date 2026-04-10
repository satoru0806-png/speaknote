/**
 * Stripe 決済ヘルパー
 * 環境変数: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 */
import Stripe from 'stripe';

let stripeInstance = null;

export function getStripe() {
  if (!stripeInstance) {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeInstance;
}

// プラン定義（Stripe Price IDは後で設定）
export const PLANS = {
  free: {
    name: '無料プラン',
    price: 0,
    monthlyLimit: 30,
    stripePriceId: null,
  },
  lite: {
    name: 'ライトプラン',
    price: 490,
    monthlyLimit: 300,
    stripePriceId: process.env.STRIPE_PRICE_LITE,
  },
  standard: {
    name: 'スタンダードプラン',
    price: 980,
    monthlyLimit: -1, // 無制限
    stripePriceId: process.env.STRIPE_PRICE_STANDARD,
  },
};

/**
 * プラン名からStripe Price IDを取得
 */
export function getPriceId(planName) {
  const plan = PLANS[planName];
  return plan ? plan.stripePriceId : null;
}

/**
 * Stripe Price IDからプラン名を取得
 */
export function getPlanByPriceId(priceId) {
  for (const [key, plan] of Object.entries(PLANS)) {
    if (plan.stripePriceId === priceId) return key;
  }
  return 'free';
}
