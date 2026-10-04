// deepseekPricing.js — Single source of truth for DeepSeek billing rates.
//
// DeepSeek bills separate off-peak and peak rates (peak = 01:00-04:00 and
// 06:00-10:00 UTC, Monday-Friday; everything else is off-peak at half rate)
// and splits input tokens into cache "hit" vs "miss" rates.  Both the chat
// cache-savings chip (extension.js) and the token ledger
// (tokenUsageManager.js) import these helpers so the two rate cards can never
// drift apart.  All values are USD per 1M tokens.
//
// The legacy `deepseek-v4-flash` alias is retired and served by V4.1-Flash,
// so it shares Flash pricing.

export const DEEPSEEK_TIER_PRICING = {
    'deepseek-flash': {
        offPeak: { hit: 0.003, miss: 0.15, out: 0.6 },
        peak: { hit: 0.006, miss: 0.3, out: 1.2 },
    },
    'deepseek-v4-flash': {
        offPeak: { hit: 0.003, miss: 0.15, out: 0.6 },
        peak: { hit: 0.006, miss: 0.3, out: 1.2 },
    },
    'deepseek-v4-pro': {
        offPeak: { hit: 0.022, miss: 0.66, out: 1.98 },
        peak: { hit: 0.044, miss: 1.32, out: 3.96 },
    },
};

export const DEEPSEEK_DEFAULT_PRICING_MODEL = 'deepseek-flash';

const DEEPSEEK_PEAK_WINDOWS_UTC = [
    { startHour: 1, endHour: 4 },
    { startHour: 6, endHour: 10 },
];

/** Whether a given epoch (ms) falls inside DeepSeek's peak billing window. */
export function isDeepSeekPeakHour(epochMs = Date.now()) {
    const d = new Date(epochMs);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) {
        return false;
    }
    const hour = d.getUTCHours();
    return DEEPSEEK_PEAK_WINDOWS_UTC.some((w) => hour >= w.startHour && hour < w.endHour);
}

/** Resolve the effective rate card for a model id (falls back to Flash). */
export function deepseekPricingForModel(model) {
    const key = String(model || '').trim();
    return DEEPSEEK_TIER_PRICING[key] || DEEPSEEK_TIER_PRICING[DEEPSEEK_DEFAULT_PRICING_MODEL];
}

/** Resolve the rate card for the tier active at a given epoch (ms). */
export function deepseekPricingForTimestamp(model, epochMs = Date.now()) {
    const pricing = deepseekPricingForModel(model);
    const tier = isDeepSeekPeakHour(epochMs) ? 'peak' : 'offPeak';
    return { ...pricing[tier], tier };
}

/** Cost in USD for a single request at the tier active at epochMs. */
export function estimateDeepSeekCost(
    model,
    promptTokens,
    completionTokens,
    { epochMs = Date.now(), cachedHitTokens = 0 } = {},
) {
    const prompt = Math.max(0, Number(promptTokens) || 0);
    const completion = Math.max(0, Number(completionTokens) || 0);
    const hit = Math.min(prompt, Math.max(0, Number(cachedHitTokens) || 0));
    const {
        hit: hitRate,
        miss: missRate,
        out: outRate,
    } = deepseekPricingForTimestamp(model, epochMs);
    return (hit * hitRate + (prompt - hit) * missRate + completion * outRate) / 1_000_000;
}

/** Cost in USD from pre-bucketed per-tier token counts (ledger path). */
export function estimateDeepSeekCostFromTiers(model, tiers) {
    const pricing = deepseekPricingForModel(model);
    let total = 0;
    for (const tier of ['peak', 'offPeak']) {
        const t = (tiers && tiers[tier]) || {};
        const prompt = Math.max(0, Number(t.prompt) || 0);
        const completion = Math.max(0, Number(t.completion) || 0);
        const hit = Math.min(prompt, Math.max(0, Number(t.hit) || 0));
        const rates = pricing[tier];
        total +=
            (hit * rates.hit + (prompt - hit) * rates.miss + completion * rates.out) / 1_000_000;
    }
    return total;
}
