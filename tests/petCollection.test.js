import {
    canUnlockMixie,
    createEmptyCollectionState,
    crossbreedFormId,
    getMixieStage,
    getPetAccentPath,
    getPetDisplayScale,
    getPetSpriteCandidates,
    getPetStage,
    getPetStageProgress,
    getQualifyingPairKeys,
    isPetFormAvailable,
    makePairKey,
    normalizeCollectionState,
    parsePetForm,
    PET_PROVIDERS,
    PET_SELECTION_MODES,
    providerFormId,
    resolveActivePetForm,
} from '../src/pets/petCollection.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const tests = [
    ['stage boundaries', () => {
        assertEqual(getPetStage(0).key, 'egg', 'zero XP');
        assertEqual(getPetStage(1).key, 'hatchling', 'first token');
        assertEqual(getPetStage(9_999).key, 'hatchling', 'before Sprout');
        assertEqual(getPetStage(10_000).key, 'sprout', 'Sprout threshold');
        assertEqual(getPetStage(100_000).key, 'scholar', 'Scholar threshold');
        assertEqual(getPetStage(1_000_000).key, 'sage', 'Sage threshold');
        assertEqual(getPetStage(10_000_000).key, 'archmage', 'Archmage threshold');
        assertEqual(getPetStage(-20).key, 'egg', 'negative XP clamps');
    }],
    ['stage progress', () => {
        const progress = getPetStageProgress(5_000);
        assertEqual(progress.stage.key, 'hatchling', 'progress stage');
        assertEqual(progress.nextStage.key, 'sprout', 'progress next stage');
        assert(progress.progress > 0.49 && progress.progress < 0.51, 'progress ratio');
    }],
    ['collection normalization', () => {
        const collection = normalizeCollectionState({
            pets: {
                openai: { xp: 10_000, replyCount: -2, celebratedStages: ['egg', 'sprout', 'unknown', 'sprout'] },
            },
            unlockedPairs: {
                'openai|ollama': { unlockedAt: 15 },
                'openai|openai': { unlockedAt: 20 },
            },
        });
        assertEqual(Object.keys(collection.pets).length, PET_PROVIDERS.length, 'all provider pets exist');
        assertEqual(collection.pets.openai.xp, 10_000, 'XP preserved');
        assertEqual(collection.pets.openai.replyCount, 0, 'reply count clamps');
        assertEqual(collection.pets.openai.celebratedStages.join(','), 'egg,sprout', 'stages normalize');
        assertEqual(Object.keys(collection.unlockedPairs).length, 0, 'noncanonical and invalid pairs drop');
    }],
    ['pair qualification', () => {
        const collection = createEmptyCollectionState();
        for (const provider of PET_PROVIDERS) collection.pets[provider].xp = 10_000;
        const pairs = getQualifyingPairKeys(collection);
        assertEqual(pairs.length, 10, 'five providers produce ten pairs');
        assert(pairs.includes(makePairKey('openai', 'ollama')), 'OpenAI and Ollama pair exists');
        collection.pets.deepseek.xp = 9_999;
        assertEqual(getQualifyingPairKeys(collection).length, 6, 'four Sprout pets produce six pairs');
    }],
    ['Mixie progression', () => {
        const collection = createEmptyCollectionState();
        for (const provider of PET_PROVIDERS) collection.pets[provider].xp = 100_000;
        assert(canUnlockMixie(collection), 'all Sprout-or-higher pets unlock Mixie');
        assertEqual(getMixieStage(collection).key, 'scholar', 'Mixie uses shared minimum stage');
        collection.pets.anthropic.xp = 10_000;
        assertEqual(getMixieStage(collection).key, 'sprout', 'weakest pet controls Mixie stage');
        collection.pets.anthropic.xp = 9_999;
        assert(!canUnlockMixie(collection), 'Mixie remains locked below all-five Sprout');
    }],
    ['form validation and active resolution', () => {
        const collection = createEmptyCollectionState();
        const pairKey = makePairKey('openai', 'ollama');
        collection.unlockedPairs[pairKey] = { unlockedAt: 10 };
        collection.mixie.unlockedAt = 11;

        const crossbreedId = crossbreedFormId('openai', 'ollama');
        assertEqual(parsePetForm(crossbreedId).baseProvider, 'openai', 'crossbreed keeps direction');
        assert(isPetFormAvailable(crossbreedId, collection), 'unlocked pair form is available');
        assert(isPetFormAvailable('mixie', collection), 'unlocked Mixie is available');
        assert(!parsePetForm('crossbreed:openai:openai'), 'same-provider crossbreed is invalid');

        const pinned = resolveActivePetForm({
            collection,
            currentProvider: 'anthropic',
            selectionMode: PET_SELECTION_MODES.PINNED,
            pinnedForm: crossbreedId,
        });
        assertEqual(pinned.id, crossbreedId, 'valid pin wins');

        const fallback = resolveActivePetForm({
            collection,
            currentProvider: 'deepseek',
            selectionMode: PET_SELECTION_MODES.PINNED,
            pinnedForm: 'crossbreed:deepseek:anthropic',
        });
        assertEqual(fallback.id, providerFormId('deepseek'), 'invalid pin follows provider');
    }],
    ['sprite paths and fallbacks', () => {
        assertEqual(
            getPetSpriteCandidates({ form: 'provider:openai', stageKey: 'egg' })[0],
            'sprites/eggs/egg_sparky.png',
            'provider egg path'
        );
        assertEqual(
            getPetSpriteCandidates({ form: 'provider:ollama', stageKey: 'sprout', pose: 'sleep' }).join(','),
            'sprites/ollie/ollie_baby_sleep.png,sprites/ollie/ollie_baby_idle_01.png,sprites/eggs/egg_ollie.png',
            'baby pose fallback chain'
        );
        assertEqual(
            getPetSpriteCandidates({ form: 'mixie', stageKey: 'sage', frame: 2 })[0],
            'sprites/mixie/mixie_adult_idle_02.png',
            'Mixie adult path'
        );
        assertEqual(
            getPetAccentPath('crossbreed:openai:ollama'),
            'sprites/accents/accent_ollie.png',
            'directional accent path'
        );
        assertEqual(getPetDisplayScale('hatchling'), 0.85, 'Hatchling scale');
        assertEqual(getPetDisplayScale('sage'), 1, 'Sage scale');
    }],
];

for (const [name, run] of tests) {
    run();
    console.log(`PASS ${name}`);
}

console.log(`PASS ${tests.length} pet collection tests`);