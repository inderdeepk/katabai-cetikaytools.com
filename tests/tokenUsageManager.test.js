import { getQualifyingPairKeys, makePairKey, PET_PROVIDERS } from '../petCollection.js';
import { TokenUsageManager } from '../tokenUsageManager.js';

TokenUsageManager._scheduleFlush = () => { TokenUsageManager._dirty = true; };

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

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
        assertEqual(Object.keys(store.collection.unlockedPairs).length, 0, 'fresh pair unlocks');
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
        assert(migrated.collection.unlockedPairs[makePairKey('ollama', 'openai')], 'qualifying pair unlocked');
        assertEqual(migrated.collection.mixie.unlockedAt, 0, 'Mixie remains locked');
    }],
    ['all-provider migration unlocks Mixie silently', () => {
        const providers = {};
        for (const provider of PET_PROVIDERS) providers[provider] = providerBucket(10_000, { completed: 1 });
        const migrated = TokenUsageManager._migrateStore(versionTwoStore({
            '2026-02-01': {
                total: 50_000,
                statuses: { completed: 5, stopped: 0, 'tool-call-turn': 0 },
                providers,
            },
        }));

        assertEqual(Object.keys(migrated.collection.unlockedPairs).length, 10, 'all ten pairs unlock');
        assert(migrated.collection.mixie.unlockedAt > 0, 'Mixie unlock timestamp');
        assert(migrated.collection.mixie.celebrated, 'migrated Mixie is acknowledged');
        assert(migrated.collection.mixie.celebratedStages.includes('sprout'), 'Mixie stage acknowledged');
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
    ['pair unlock emits once', () => {
        TokenUsageManager._cache = TokenUsageManager._freshStore();
        TokenUsageManager._cache.collection.pets.openai.xp = 10_000;
        TokenUsageManager._cache.collection.pets.ollama.xp = 9_999;
        const result = TokenUsageManager.recordUsageEvent({
            eventId: 'pair-unlock',
            provider: 'ollama',
            promptTokens: 1,
            status: 'completed',
        });
        const unlocks = result.events.filter(event => event.type === 'crossbreed-unlocked');
        assertEqual(unlocks.length, 1, 'one pair event');
        assertEqual(unlocks[0].pairKey, makePairKey('ollama', 'openai'), 'correct pair key');
        assertEqual(TokenUsageManager.getUnlockedCrossbreeds().length, 1, 'pair query API');

        const followUp = TokenUsageManager.recordUsageEvent({
            eventId: 'pair-follow-up',
            provider: 'ollama',
            promptTokens: 1,
            status: 'completed',
        });
        assertEqual(followUp.events.filter(event => event.type === 'crossbreed-unlocked').length, 0, 'pair does not repeat');
    }],
    ['Mixie unlock and shared stage advancement', () => {
        TokenUsageManager._cache = TokenUsageManager._freshStore();
        const collection = TokenUsageManager._cache.collection;
        for (const provider of PET_PROVIDERS) collection.pets[provider].xp = 10_000;
        collection.pets.deepseek.xp = 9_999;
        for (const pairKey of getQualifyingPairKeys(collection)) {
            collection.unlockedPairs[pairKey] = { unlockedAt: 1 };
        }

        const unlock = TokenUsageManager.recordUsageEvent({
            eventId: 'mixie-unlock',
            provider: 'deepseek',
            promptTokens: 1,
            status: 'completed',
        });
        assert(unlock.events.some(event => event.type === 'mixie-unlocked'), 'Mixie unlock event');
        assert(TokenUsageManager._cache.collection.mixie.unlockedAt > 0, 'Mixie persisted');
        assertEqual(TokenUsageManager.getCollectionState().mixie.stageKey, 'sprout', 'Mixie snapshot stage');

        for (const provider of PET_PROVIDERS) collection.pets[provider].xp = 100_000;
        collection.pets.deepseek.xp = 99_999;
        const stageUp = TokenUsageManager.recordUsageEvent({
            eventId: 'mixie-scholar',
            provider: 'deepseek',
            promptTokens: 1,
            status: 'completed',
        });
        assert(stageUp.events.some(event => event.type === 'mixie-stage-up' && event.stageKey === 'scholar'), 'Mixie stage-up event');
        assert(TokenUsageManager._cache.collection.mixie.celebratedStages.includes('scholar'), 'Mixie stage acknowledged');
    }],
];

for (const [name, run] of tests) {
    run();
    console.log(`PASS ${name}`);
}

console.log(`PASS ${tests.length} token usage migration tests`);