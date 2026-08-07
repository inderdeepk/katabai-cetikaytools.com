import { PET_PROVIDERS } from '../src/pets/petCollection.js';
import {
    TokenUsageManager,
    formatTokenCount,
    formatCost,
    estimateCost,
    estimateSummaryCost,
    isLocalModelEndpoint,
} from '../src/usage/tokenUsageManager.js';
import { assert, assertEqual, runTests } from './testUtils.js';

TokenUsageManager._scheduleFlush = () => { TokenUsageManager._dirty = true; };

function providerBucket(total, { completed = 0, stopped = 0, toolCalls = 0 } = {}) {
    return {
        prompt: total,
        completion: 0,
        reasoning: 0,
        cachedHit: 0,
        total,
        exact: total,
        estimated: 0,
        local: 0,
        remote: total,
        events: completed + stopped + toolCalls,
        statuses: { completed, stopped, 'tool-call-turn': toolCalls },
        sources: {},
        models: {},
    };
}

function versionTwoStore(days) {
    return {
        version: 2,
        trackingStartedAt: 1_700_000_000,
        lastUpdatedAt: 1_700_100_000,
        recentEventIds: [],
        milestonesCelebrated: [],
        days,
    };
}

const tests = [
    ['fresh store', () => {
        const store = TokenUsageManager._freshStore();
        assertEqual(store.version, 3, 'store version');
        assertEqual(Object.keys(store.collection.pets).length, 5, 'five provider pets');
        assertEqual(store.collection.pets.openai.xp, 0, 'fresh pet XP');
    }],
    ['version 2 provider migration', () => {
        const store = versionTwoStore({
            '2026-01-01': {
                total: 18_000,
                statuses: { completed: 3, stopped: 0, 'tool-call-turn': 1 },
                providers: {
                    openai: providerBucket(8_000, { completed: 2, toolCalls: 1 }),
                    ollama: providerBucket(10_000, { completed: 1 }),
                },
            },
            '2026-01-02': {
                total: 2_000,
                statuses: { completed: 0, stopped: 1, 'tool-call-turn': 0 },
                providers: {
                    openai: providerBucket(2_000, { stopped: 1 }),
                },
            },
        });

        const migrated = TokenUsageManager._migrateStore(store);
        assertEqual(migrated.version, 3, 'migrated version');
        assertEqual(migrated.collection.pets.openai.xp, 10_000, 'OpenAI XP sum');
        assertEqual(migrated.collection.pets.openai.replyCount, 3, 'tool call excluded from replies');
        assertEqual(migrated.collection.pets.ollama.xp, 10_000, 'Ollama XP sum');
        assert(migrated.collection.pets.openai.hatchedAt > 0, 'hatch timestamp derived');
        assert(migrated.collection.pets.openai.lastFedAt > migrated.collection.pets.openai.hatchedAt, 'last-fed timestamp derived');
        assert(migrated.collection.pets.openai.celebratedStages.includes('sprout'), 'migrated stage acknowledged');
    }],
    ['all-provider migration sums XP correctly', () => {
        const providers = {};
        for (const provider of PET_PROVIDERS) providers[provider] = providerBucket(10_000, { completed: 1 });
        const migrated = TokenUsageManager._migrateStore(versionTwoStore({
            '2026-02-01': {
                total: 50_000,
                statuses: { completed: 5, stopped: 0, 'tool-call-turn': 0 },
                providers,
            },
        }));

        assertEqual(Object.keys(migrated.collection.pets).length, 5, 'all five pets exist');
        for (const provider of PET_PROVIDERS) {
            assertEqual(migrated.collection.pets[provider].xp, 10_000, `${provider} XP migrated`);
        }
    }],
    ['version 3 partial collection normalizes', () => {
        const store = versionTwoStore({});
        store.version = 3;
        store.collection = { pets: { openai: { xp: 25 } } };
        const migrated = TokenUsageManager._migrateStore(store);
        assertEqual(Object.keys(migrated.collection.pets).length, 5, 'missing pets restored');
        assertEqual(migrated.collection.pets.openai.xp, 25, 'existing XP preserved');
        assertEqual(migrated.collection.pets.ollama.xp, 0, 'missing pet initialized');
    }],
    ['pruning does not reduce collection', () => {
        const migrated = TokenUsageManager._migrateStore(versionTwoStore({
            '2020-01-01': {
                total: 10_000,
                statuses: { completed: 1, stopped: 0, 'tool-call-turn': 0 },
                providers: { openai: providerBucket(10_000, { completed: 1 }) },
            },
        }));
        TokenUsageManager._cache = migrated;
        assertEqual(TokenUsageManager.prune(1), 1, 'old day pruned');
        assertEqual(Object.keys(migrated.days).length, 0, 'analytics bucket removed');
        assertEqual(migrated.collection.pets.openai.xp, 10_000, 'permanent XP retained');
    }],
    ['live event grants XP once', () => {
        TokenUsageManager._cache = TokenUsageManager._freshStore();
        const result = TokenUsageManager.recordUsageEvent({
            eventId: 'openai-first',
            provider: 'openai',
            promptTokens: 6_000,
            completionTokens: 4_000,
            exact: true,
            status: 'completed',
        });
        const eventTypes = result.events.map(event => event.type);
        assert(result.recorded, 'event recorded');
        assert(eventTypes.includes('pet-hatched'), 'hatch event emitted');
        assert(eventTypes.includes('pet-stage-up'), 'skipped stage resolves to one stage-up event');
        assertEqual(TokenUsageManager._cache.collection.pets.openai.xp, 10_000, 'XP granted');
        assertEqual(TokenUsageManager._cache.collection.pets.openai.replyCount, 1, 'reply counted');

        const duplicate = TokenUsageManager.recordUsageEvent({
            eventId: 'openai-first',
            provider: 'openai',
            promptTokens: 10_000,
            status: 'completed',
        });
        assert(duplicate.duplicate, 'duplicate detected');
        assertEqual(TokenUsageManager._cache.collection.pets.openai.xp, 10_000, 'duplicate grants no XP');

        const pet = TokenUsageManager.getPetState('openai');
        assertEqual(pet.stageKey, 'sprout', 'snapshot stage');
        assertEqual(pet.name, 'Sparky', 'snapshot pet name');
        assertEqual(TokenUsageManager.getActiveCompanion({ currentProvider: 'openai' }).id, 'provider:openai', 'active provider form');
    }],
    ['tool-call turns grant XP without replies', () => {
        TokenUsageManager._cache = TokenUsageManager._freshStore();
        TokenUsageManager.recordUsageEvent({
            eventId: 'tool-turn',
            provider: 'ollama',
            promptTokens: 400,
            completionTokens: 100,
            status: 'tool-call-turn',
        });
        const pet = TokenUsageManager._cache.collection.pets.ollama;
        assertEqual(pet.xp, 500, 'tool turn XP');
        assertEqual(pet.replyCount, 0, 'tool turn excluded from reply count');
    }],
];

// ── Pure function tests ────────────────────────────────────────────────────

tests.push(
    ['formatTokenCount: edge cases', () => {
        assertEqual(formatTokenCount(0), '0', 'zero');
        assertEqual(formatTokenCount(500), '500', 'sub-1k');
        assertEqual(formatTokenCount(1_000), '1k', 'exactly 1k');
        assertEqual(formatTokenCount(5_500), '5.5k', 'with decimal');
        assertEqual(formatTokenCount(10_000), '10k', '10k');
        assertEqual(formatTokenCount(999_999), '1000k', 'just under 1M rounds to k');
        assertEqual(formatTokenCount(1_000_000), '1M', 'exactly 1M');
        assertEqual(formatTokenCount(1_500_000), '1.5M', '1.5M');
        assertEqual(formatTokenCount(1_000_000_000), '1B', 'exactly 1B');
        assertEqual(formatTokenCount(2_500_000_000), '2.5B', '2.5B');
    }],

    ['formatCost: edge cases', () => {
        assertEqual(formatCost(undefined), '—', 'undefined');
        assertEqual(formatCost(null), '—', 'null');
        assertEqual(formatCost(0), '<$0.01', 'zero');
        assertEqual(formatCost(0.005), '<$0.01', 'sub-cent');
        assertEqual(formatCost(0.50), '$0.50', 'cents');
        assertEqual(formatCost(10), '$10.00', 'dollars');
        assertEqual(formatCost(10.256), '$10.26', 'rounding');
    }],

    ['estimateCost: known model pricing', () => {
        // gpt-4o: $2.50/M input, $10.00/M output
        const cost = estimateCost('gpt-4o', 'openai', 1_000_000, 1_000_000);
        assertEqual(cost, 12.50, 'gpt-4o 1M/1M = $12.50');
    }],

    ['estimateCost: local providers return zero', () => {
        assertEqual(estimateCost('llama3', 'ollama', 1_000_000, 1_000_000), 0, 'ollama free');
        assertEqual(estimateCost('mistral', 'unsloth', 1_000_000, 1_000_000), 0, 'unsloth free');
    }],

    ['estimateCost: partial matching model names', () => {
        const cost = estimateCost('gpt-4o-2024-08-06', 'openai', 1_000_000, 0);
        assertEqual(cost, 2.50, 'gpt-4o variant matches base pricing');
    }],

    ['estimateSummaryCost: proportional distribution', () => {
        const summary = {
            totalTokens: 10_000,
            promptTokens: 6_000,
            completionTokens: 4_000,
            localTokens: 5_000,
            providers: [
                { provider: 'openai', total: 5_000 },
                { provider: 'ollama', total: 5_000 },
            ],
            models: [
                { provider: 'openai', model: 'gpt-4o', total: 5_000 },
                { provider: 'ollama', model: 'llama3', total: 5_000 },
            ],
        };
        const result = estimateSummaryCost(summary);
        assert(result.total >= 0, 'total is non-negative');
        assert(result.perProvider.openai.cost >= 0, 'per-provider openai cost');
        assert(result.localSavings >= 0, 'local savings calculated');
    }],

    ['isLocalModelEndpoint: Ollama and Unsloth defaults', () => {
        assertEqual(isLocalModelEndpoint('ollama', ''), true, 'ollama default local');
        assertEqual(isLocalModelEndpoint('unsloth', ''), true, 'unsloth default local');
    }],

    ['isLocalModelEndpoint: localhost URLs', () => {
        assertEqual(isLocalModelEndpoint('openai', 'http://localhost:11434'), true, 'localhost is local');
        assertEqual(isLocalModelEndpoint('openai', 'http://127.0.0.1:8080'), true, 'loopback is local');
    }],

    ['isLocalModelEndpoint: public cloud URLs', () => {
        assertEqual(isLocalModelEndpoint('openai', 'https://api.openai.com/v1'), false, 'api.openai.com');
        assertEqual(isLocalModelEndpoint('deepseek', 'https://api.deepseek.com'), false, 'api.deepseek.com');
        assertEqual(isLocalModelEndpoint('anthropic', 'https://api.anthropic.com'), false, 'api.anthropic.com');
    }],
);

await runTests(tests);