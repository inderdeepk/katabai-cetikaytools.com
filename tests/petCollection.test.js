import {
    createEmptyCollectionState,
    getPetDefinition,
    getPetDisplayScale,
    getPetSpriteCandidates,
    getPetStage,
    getPetStageByKey,
    getPetStageProgress,
    getStageKeysThrough,
    isPetProvider,
    normalizeCollectionState,
    parsePetForm,
    PET_PROVIDERS,
    PET_SELECTION_MODES,
    providerFormId,
    resolveActivePetForm,
} from '../src/pets/petCollection.js';
import { assert, assertEqual, runTests } from './testUtils.js';

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
        });
        assertEqual(Object.keys(collection.pets).length, PET_PROVIDERS.length, 'all provider pets exist');
        assertEqual(collection.pets.openai.xp, 10_000, 'XP preserved');
        assertEqual(collection.pets.openai.replyCount, 0, 'reply count clamps');
        assertEqual(collection.pets.openai.celebratedStages.join(','), 'egg,sprout', 'stages normalize');
    }],
    ['stage lookups', () => {
        assertEqual(getPetStageByKey('sprout').rank, 2, 'sprout rank');
        assertEqual(getPetStageByKey('archmage').rank, 5, 'archmage rank');
        const keys = getStageKeysThrough('sprout');
        assertEqual(keys.length, 3, 'three stages');
        assert(keys.includes('egg'), 'egg');
        assert(keys.includes('hatchling'), 'hatchling');
        assert(keys.includes('sprout'), 'sprout');
    }],
    ['provider lookups', () => {
        assert(isPetProvider('openai'), 'openai');
        assert(isPetProvider('ollama'), 'ollama');
        assert(!isPetProvider('unknown'), 'unknown');
        assertEqual(getPetDefinition('openai').name, 'Sparky', 'Sparky');
        assertEqual(getPetDefinition('ollama').name, 'Ollie', 'Ollie');
    }],
    ['form validation', () => {
        const providerId = providerFormId('openai');
        assertEqual(parsePetForm(providerId).type, 'provider', 'provider form');
        assertEqual(parsePetForm(providerId).baseProvider, 'openai', 'base provider');
        assertEqual(parsePetForm('not:valid'), null, 'invalid returns null');
        assertEqual(parsePetForm('crossbreed:openai:openai'), null, 'same-provider crossbreed invalid');

        const pinned = resolveActivePetForm({
            collection: createEmptyCollectionState(),
            currentProvider: 'anthropic',
            selectionMode: PET_SELECTION_MODES.PINNED,
            pinnedForm: providerId,
        });
        assertEqual(pinned.id, providerId, 'valid pin wins');

        const fallback = resolveActivePetForm({
            collection: createEmptyCollectionState(),
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
        assertEqual(getPetDisplayScale('hatchling'), 0.85, 'Hatchling scale');
        assertEqual(getPetDisplayScale('sage'), 1, 'Sage scale');
    }],
];

runTests(tests);