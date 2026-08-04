// Pure pet collection rules shared by the usage ledger and shell UI.

export const PET_PROVIDERS = Object.freeze([
    'ollama',
    'unsloth',
    'openai',
    'anthropic',
    'deepseek',
]);

export const PET_DEFINITIONS = Object.freeze({
    ollama: Object.freeze({ provider: 'ollama', name: 'Ollie', directory: 'ollie', iconFile: 'ollama.svg' }),
    unsloth: Object.freeze({ provider: 'unsloth', name: 'Slothy', directory: 'slothy', iconFile: 'unsloth.png' }),
    openai: Object.freeze({ provider: 'openai', name: 'Sparky', directory: 'sparky', iconFile: 'openai.svg' }),
    anthropic: Object.freeze({ provider: 'anthropic', name: 'Clyde', directory: 'clyde', iconFile: 'claude.svg' }),
    deepseek: Object.freeze({ provider: 'deepseek', name: 'Pearl', directory: 'pearl', iconFile: 'deepseek.svg' }),
});

export const PET_STAGES = Object.freeze([
    Object.freeze({ rank: 0, minXp: 0, key: 'egg', label: 'Unhatched Egg', spriteFamily: 'egg' }),
    Object.freeze({ rank: 1, minXp: 1, key: 'hatchling', label: 'Hatchling', spriteFamily: 'baby' }),
    Object.freeze({ rank: 2, minXp: 10_000, key: 'sprout', label: 'Sprout', spriteFamily: 'baby' }),
    Object.freeze({ rank: 3, minXp: 100_000, key: 'scholar', label: 'Scholar', spriteFamily: 'adult' }),
    Object.freeze({ rank: 4, minXp: 1_000_000, key: 'sage', label: 'Sage', spriteFamily: 'adult' }),
    Object.freeze({ rank: 5, minXp: 10_000_000, key: 'archmage', label: 'Archmage', spriteFamily: 'adult' }),
]);

export const PET_SELECTION_MODES = Object.freeze({
    FOLLOW_PROVIDER: 'follow-provider',
    PINNED: 'pinned',
});

const PET_STAGE_BY_KEY = new Map(PET_STAGES.map(stage => [stage.key, stage]));

export function isPetProvider(provider) {
    return PET_PROVIDERS.includes(String(provider || ''));
}

export function getPetDefinition(provider) {
    return PET_DEFINITIONS[provider] || null;
}

export function getPetStage(xp) {
    const normalizedXp = normalizeCount(xp);
    for (let index = PET_STAGES.length - 1; index >= 0; index--) {
        if (normalizedXp >= PET_STAGES[index].minXp) return PET_STAGES[index];
    }
    return PET_STAGES[0];
}

export function getPetStageByKey(stageKey) {
    return PET_STAGE_BY_KEY.get(stageKey) || PET_STAGES[0];
}

export function getStageKeysThrough(stageKey) {
    const targetRank = getPetStageByKey(stageKey).rank;
    return PET_STAGES.filter(stage => stage.rank <= targetRank).map(stage => stage.key);
}

export function getPetStageProgress(xp) {
    const normalizedXp = normalizeCount(xp);
    const stage = getPetStage(normalizedXp);
    const nextStage = PET_STAGES[stage.rank + 1] || null;
    if (!nextStage) {
        return { stage, nextStage: null, current: normalizedXp, required: normalizedXp, progress: 1 };
    }

    const span = nextStage.minXp - stage.minXp;
    const current = normalizedXp - stage.minXp;
    return {
        stage,
        nextStage,
        current,
        required: span,
        progress: span > 0 ? Math.min(1, current / span) : 1,
    };
}

export function createEmptyPetState() {
    return {
        xp: 0,
        replyCount: 0,
        hatchedAt: 0,
        lastFedAt: 0,
        celebratedStages: [],
    };
}

export function createEmptyCollectionState() {
    const pets = {};
    for (const provider of PET_PROVIDERS) pets[provider] = createEmptyPetState();
    return { pets };
}

export function normalizePetState(rawPet) {
    const source = rawPet && typeof rawPet === 'object' ? rawPet : {};
    const stage = getPetStage(source.xp);
    const celebratedStages = Array.isArray(source.celebratedStages)
        ? source.celebratedStages.filter((key, index, keys) => PET_STAGE_BY_KEY.has(key) && keys.indexOf(key) === index)
        : [];
    return {
        xp: normalizeCount(source.xp),
        replyCount: normalizeCount(source.replyCount),
        hatchedAt: normalizeTimestamp(source.hatchedAt),
        lastFedAt: normalizeTimestamp(source.lastFedAt),
        celebratedStages: celebratedStages.filter(key => getPetStageByKey(key).rank <= stage.rank),
    };
}

export function normalizeCollectionState(rawCollection) {
    const source = rawCollection && typeof rawCollection === 'object' ? rawCollection : {};
    const pets = {};
    for (const provider of PET_PROVIDERS) pets[provider] = normalizePetState(source.pets?.[provider]);
    return { pets };
}

export function providerFormId(provider) {
    return isPetProvider(provider) ? `provider:${provider}` : null;
}

export function parsePetForm(formId) {
    const parts = String(formId || '').split(':');
    if (parts[0] === 'provider' && parts.length === 2 && isPetProvider(parts[1])) {
        return { id: providerFormId(parts[1]), type: 'provider', provider: parts[1], baseProvider: parts[1] };
    }
    return null;
}

export function resolveActivePetForm({ collection, currentProvider, selectionMode, pinnedForm }) {
    if (selectionMode === PET_SELECTION_MODES.PINNED && parsePetForm(pinnedForm)) {
        return parsePetForm(pinnedForm);
    }
    const provider = isPetProvider(currentProvider) ? currentProvider : PET_PROVIDERS[0];
    return parsePetForm(providerFormId(provider));
}

export function getPetSpriteCandidates({ form, stageKey, pose = 'idle', frame = 1 }) {
    const parsedForm = typeof form === 'string' ? parsePetForm(form) : form;
    if (!parsedForm) return [];

    const stage = getPetStageByKey(stageKey);
    const slug = getPetDefinition(parsedForm.baseProvider)?.directory;
    if (!slug) return [];

    const eggPath = `sprites/eggs/egg_${slug}.png`;
    if (stage.spriteFamily === 'egg') return [eggPath];

    const normalizedPose = ['idle', 'sleep', 'tip', 'celebrate'].includes(pose) ? pose : 'idle';
    const normalizedFrame = frame === 2 ? 2 : 1;
    const prefix = `sprites/${slug}/${slug}_${stage.spriteFamily}`;
    const candidates = [];
    if (normalizedPose === 'idle') {
        candidates.push(`${prefix}_idle_0${normalizedFrame}.png`);
    } else {
        candidates.push(`${prefix}_${normalizedPose}.png`);
    }
    candidates.push(`${prefix}_idle_01.png`, eggPath);
    return candidates.filter((path, index, paths) => paths.indexOf(path) === index);
}

export function getPetDisplayScale(stageKey) {
    switch (getPetStageByKey(stageKey).key) {
        case 'hatchling': return 0.85;
        case 'scholar': return 0.85;
        default: return 1;
    }
}

function normalizeCount(value) {
    const count = Math.round(Number(value) || 0);
    return count > 0 ? count : 0;
}

function normalizeTimestamp(value) {
    const timestamp = Math.floor(Number(value) || 0);
    return timestamp > 0 ? timestamp : 0;
}