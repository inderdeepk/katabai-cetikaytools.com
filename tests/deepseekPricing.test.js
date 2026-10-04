// deepseekPricing.test.js — Guards the single-source DeepSeek rate card and
// the tokenUsageManager re-exports that keep old import paths working.
import {
    DEEPSEEK_TIER_PRICING,
    deepseekPricingForModel,
    deepseekPricingForTimestamp,
    isDeepSeekPeakHour,
    estimateDeepSeekCost,
    estimateDeepSeekCostFromTiers,
} from '../src/usage/deepseekPricing.js';
import * as tokenUsage from '../src/usage/tokenUsageManager.js';
import { assert, assertEqual, runTests } from './testUtils.js';

// 2026-09-14 is a Monday. 12:00 UTC = off-peak; 02:00 UTC = peak.
const MONDAY_NOON_UTC = Date.UTC(2026, 8, 14, 12, 0, 0);
const MONDAY_2AM_UTC = Date.UTC(2026, 8, 14, 2, 0, 0);

const tests = [
    [
        'rate card: flash + pro tiers carry the expected rates',
        () => {
            assertEqual(
                DEEPSEEK_TIER_PRICING['deepseek-flash'].offPeak.miss,
                0.15,
                'flash off-peak miss',
            );
            assertEqual(DEEPSEEK_TIER_PRICING['deepseek-flash'].peak.out, 1.2, 'flash peak out');
            assertEqual(
                DEEPSEEK_TIER_PRICING['deepseek-v4-pro'].offPeak.hit,
                0.022,
                'pro off-peak hit',
            );
            assertEqual(DEEPSEEK_TIER_PRICING['deepseek-v4-pro'].peak.miss, 1.32, 'pro peak miss');
        },
    ],

    [
        'deepseekPricingForModel: unknown/empty model falls back to Flash',
        () => {
            assertEqual(
                deepseekPricingForModel('not-a-model'),
                DEEPSEEK_TIER_PRICING['deepseek-flash'],
                'unknown fallback',
            );
            assertEqual(
                deepseekPricingForModel(''),
                DEEPSEEK_TIER_PRICING['deepseek-flash'],
                'empty fallback',
            );
        },
    ],

    [
        'peak windows: Monday 02:00 UTC peak; noon and weekends off-peak',
        () => {
            assertEqual(isDeepSeekPeakHour(MONDAY_2AM_UTC), true, 'Monday 02:00 UTC is peak');
            assertEqual(isDeepSeekPeakHour(MONDAY_NOON_UTC), false, 'Monday noon UTC is off-peak');
            assertEqual(
                isDeepSeekPeakHour(Date.UTC(2026, 8, 13, 2, 0, 0)),
                false,
                'Sunday 02:00 UTC is off-peak',
            );
        },
    ],

    [
        'deepseekPricingForTimestamp: selects the tier card for the epoch',
        () => {
            assertEqual(
                deepseekPricingForTimestamp('deepseek-flash', MONDAY_2AM_UTC).tier,
                'peak',
                'peak tier',
            );
            assertEqual(
                deepseekPricingForTimestamp('deepseek-flash', MONDAY_2AM_UTC).miss,
                0.3,
                'peak miss rate',
            );
            assertEqual(
                deepseekPricingForTimestamp('deepseek-v4-pro', MONDAY_NOON_UTC).tier,
                'offPeak',
                'off-peak tier',
            );
            assertEqual(
                deepseekPricingForTimestamp('deepseek-v4-pro', MONDAY_NOON_UTC).out,
                1.98,
                'off-peak out rate',
            );
        },
    ],

    [
        'estimateDeepSeekCost: hit/miss split plus completion pricing',
        () => {
            // 400 hit @ 0.003 + 600 miss @ 0.15 + 500 out @ 0.60 = 0.0003912 USD
            const cost = estimateDeepSeekCost('deepseek-flash', 1000, 500, {
                epochMs: MONDAY_NOON_UTC,
                cachedHitTokens: 400,
            });
            assert(Math.abs(cost - 0.0003912) < 1e-12, `unexpected cost: ${cost}`);
        },
    ],

    [
        'estimateDeepSeekCostFromTiers: sums peak + off-peak buckets',
        () => {
            const cost = estimateDeepSeekCostFromTiers('deepseek-flash', {
                peak: { prompt: 0, completion: 0, hit: 0 },
                offPeak: { prompt: 1000, completion: 500, hit: 0 },
            });
            assert(Math.abs(cost - 0.00045) < 1e-12, `unexpected cost: ${cost}`);
        },
    ],

    [
        'tokenUsageManager re-exports the SAME helpers (no drift possible)',
        () => {
            assertEqual(
                tokenUsage.deepseekPricingForTimestamp,
                deepseekPricingForTimestamp,
                'timestamp helper identity',
            );
            assertEqual(tokenUsage.isDeepSeekPeakHour, isDeepSeekPeakHour, 'peak helper identity');
            assertEqual(
                tokenUsage.estimateDeepSeekCost,
                estimateDeepSeekCost,
                'cost helper identity',
            );
            assertEqual(
                tokenUsage.estimateDeepSeekCostFromTiers,
                estimateDeepSeekCostFromTiers,
                'tier cost identity',
            );
            assertEqual(
                tokenUsage.deepseekPricingForModel,
                deepseekPricingForModel,
                'model helper identity',
            );
        },
    ],
];

await runTests(tests);
