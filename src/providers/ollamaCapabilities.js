// ollamaCapabilities.js — Pure, host-free Ollama endpoint normalization,
// `/api/show` capability & metadata parsing, safe `think` parameter resolution,
// Structured Outputs format parsing, and `/api/tags` + `/api/ps` normalizers.
//
// Imported by extension.js, prefs UI, and provider request builders so every
// layer resolves Ollama endpoints, capabilities, and cloud detection identically.

export const OLLAMA_VISION_MODEL_HINTS = [
    'vision',
    'llava',
    'bakllava',
    'moondream',
    'minicpm-v',
    'qwen-vl',
    'qwen2-vl',
    'qwen2.5-vl',
    'qwen2.5vl',
    'qwen3-vl',
    'qwen3vl',
    'internvl',
    'gemma3',
    'gemma4',
    'llama4',
    'pixtral',
    'mistral-small3',
    'granite3.2-vision',
    'deepseek-vl',
    'janus-pro',
];

const OLLAMA_KNOWN_PATH_SUFFIXES = [
    '/v1/chat/completions',
    '/api/chat',
    '/api/generate',
    '/api/tags',
    '/api/show',
    '/api/ps',
    '/api/pull',
    '/api/embed',
    '/api/embeddings',
    '/api',
    '/v1',
];

/**
 * Normalize an Ollama base URL and append `path` (e.g. '/api/chat', '/api/show',
 * '/v1/chat/completions') without ever doubling `/api` or `/v1` suffixes.
 */
export function resolveOllamaEndpoint(baseUrl, path = '/api/chat') {
    let base = String(baseUrl ?? '')
        .trim()
        .replace(/\/+$/, '');
    const suffix = String(path ?? '').startsWith('/') ? String(path ?? '') : `/${path}`;
    if (!base) {
        return suffix;
    }

    const lower = base.toLowerCase();
    for (const known of OLLAMA_KNOWN_PATH_SUFFIXES) {
        if (lower.endsWith(known)) {
            base = base.slice(0, base.length - known.length);
            break;
        }
    }

    return `${base}${suffix}`;
}

function extractHostLower(rawUrl) {
    const raw = String(rawUrl ?? '').trim();
    if (!raw) return '';
    const match = raw.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#:]+)/);
    if (match && match[1]) {
        return match[1].toLowerCase();
    }
    return '';
}

/** True when `baseUrl` targets Ollama's hosted cloud API (ollama.com / *.ollama.cloud). */
export function isOllamaCloudEndpoint(baseUrl) {
    const host = extractHostLower(baseUrl);
    if (!host) return false;
    return (
        host === 'ollama.com' ||
        host.endsWith('.ollama.com') ||
        host === 'ollama.cloud' ||
        host.endsWith('.ollama.cloud')
    );
}

/** True when `modelName` carries a `:cloud` or `-cloud` tag (Ollama cloud-routed model). */
export function isOllamaCloudModel(modelName) {
    const normalized = String(modelName ?? '')
        .trim()
        .toLowerCase();
    if (!normalized) return false;
    return normalized.endsWith(':cloud') || normalized.endsWith('-cloud');
}

/** Heuristic fallback for vision-capable Ollama model names when `/api/show` omits capabilities. */
export function looksLikeOllamaVisionModel(modelName) {
    const normalized = String(modelName ?? '')
        .trim()
        .toLowerCase();
    if (!normalized) return false;
    return OLLAMA_VISION_MODEL_HINTS.some((hint) => normalized.includes(hint));
}

export function normalizeCapabilityTokens(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) =>
                String(entry ?? '')
                    .trim()
                    .toLowerCase(),
            )
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/[\s,]+/)
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean);
    }
    return [];
}

function extractThinkingMetadata(payload) {
    const raw = payload?.thinking;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { thinkingValues: null, thinkingDefault: null };
    }
    const thinkingValues = Array.isArray(raw.values)
        ? raw.values.filter(
              (v) => typeof v === 'boolean' || (typeof v === 'string' && v.trim() !== ''),
          )
        : null;
    const thinkingDefault =
        typeof raw.default === 'boolean' || (typeof raw.default === 'string' && raw.default.trim())
            ? raw.default
            : null;
    return {
        thinkingValues: thinkingValues && thinkingValues.length > 0 ? thinkingValues : null,
        thinkingDefault,
    };
}

function extractContextLength(modelInfo) {
    if (!modelInfo || typeof modelInfo !== 'object') {
        return null;
    }
    let best = null;
    for (const [key, value] of Object.entries(modelInfo)) {
        if (
            key.toLowerCase().endsWith('.context_length') &&
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value > 0
        ) {
            const intVal = Math.floor(value);
            if (best === null || intVal > best) {
                best = intVal;
            }
        }
    }
    return best;
}

/**
 * Parse a `POST /api/show` JSON payload into normalized model capabilities
 * and metadata.
 */
export function parseOllamaShowResponse(payload, modelName = '') {
    if (!payload || typeof payload !== 'object') {
        return {
            capabilities: [],
            vision: looksLikeOllamaVisionModel(modelName) ? true : null,
            tools: null,
            thinking: null,
            thinkingValues: null,
            thinkingDefault: null,
            contextLength: null,
            family: '',
            parameterSize: '',
            quantizationLevel: '',
        };
    }

    const capabilityFields = [
        payload.capabilities,
        payload.details?.capabilities,
        payload.model_info?.capabilities,
    ];
    const capabilities = [
        ...new Set(capabilityFields.flatMap((f) => normalizeCapabilityTokens(f))),
    ];
    const hasCapabilitiesArray = capabilities.length > 0;

    const { thinkingValues, thinkingDefault } = extractThinkingMetadata(payload);

    // Vision capability: authoritative capabilities list first, then GGUF vision metadata, then name hint.
    let vision = null;
    if (hasCapabilitiesArray) {
        vision =
            capabilities.includes('vision') ||
            capabilities.includes('image') ||
            capabilities.includes('multimodal');
    } else {
        const payloadText = JSON.stringify(payload).toLowerCase();
        if (
            payloadText.includes('"vision"') ||
            payloadText.includes('projector') ||
            payloadText.includes('.vision.') ||
            payloadText.includes('_vision_') ||
            payloadText.includes('vision.block_count')
        ) {
            vision = true;
        } else if (looksLikeOllamaVisionModel(modelName)) {
            vision = true;
        }
    }

    // Tools capability: authoritative when Ollama reports capabilities.
    const tools = hasCapabilitiesArray ? capabilities.includes('tools') : null;

    // Thinking capability: true when 'thinking' capability or non-false thinking.values exist.
    let thinking = null;
    if (hasCapabilitiesArray) {
        thinking = capabilities.includes('thinking');
    }
    if (thinkingValues) {
        const hasTruthyOrLevel = thinkingValues.some(
            (v) => v === true || (typeof v === 'string' && v.trim() !== ''),
        );
        if (hasTruthyOrLevel) {
            thinking = true;
        } else if (thinkingValues.length === 1 && thinkingValues[0] === false) {
            thinking = false;
        }
    }

    const details = payload.details && typeof payload.details === 'object' ? payload.details : {};
    return {
        capabilities,
        vision,
        tools,
        thinking,
        thinkingValues,
        thinkingDefault,
        contextLength: extractContextLength(payload.model_info),
        family: typeof details.family === 'string' ? details.family : '',
        parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : '',
        quantizationLevel:
            typeof details.quantization_level === 'string' ? details.quantization_level : '',
    };
}

/**
 * Safely resolve the `think` field for `/api/chat`.
 * Returns `undefined` (omit the parameter) when the model does not support thinking
 * or its thinking capability is unknown, avoiding HTTP 400 "does not support thinking".
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled=true]
 * @param {string} [opts.level='auto'] - 'auto' | 'low' | 'medium' | 'high' | 'max'
 * @param {object|null} [opts.capabilities=null] - parsed `/api/show` capabilities
 * @param {boolean} [opts.forceDisable=false]
 * @returns {boolean|string|undefined}
 */
export function resolveOllamaThinkParam({
    enabled = true,
    level = 'auto',
    capabilities = null,
    forceDisable = false,
} = {}) {
    if (!capabilities || capabilities.thinking !== true) {
        return undefined;
    }

    const vals = Array.isArray(capabilities.thinkingValues) ? capabilities.thinkingValues : null;

    if (forceDisable || !enabled) {
        if (vals) {
            if (vals.includes(false)) return false;
            if (vals.includes('low')) return 'low';
            return undefined;
        }
        return false;
    }

    const normalizedLevel = String(level || 'auto')
        .trim()
        .toLowerCase();

    if (vals) {
        if (normalizedLevel !== 'auto' && vals.includes(normalizedLevel)) {
            return normalizedLevel;
        }
        if (normalizedLevel === 'max' && !vals.includes('max') && vals.includes('high')) {
            return 'high';
        }
        if (vals.includes(true)) {
            return true;
        }
        if (
            capabilities.thinkingDefault !== null &&
            capabilities.thinkingDefault !== undefined &&
            capabilities.thinkingDefault !== false
        ) {
            return capabilities.thinkingDefault;
        }
        if (vals.includes('medium')) return 'medium';
        const firstString = vals.find((v) => typeof v === 'string');
        return firstString ?? undefined;
    }

    return normalizedLevel !== 'auto' && ['low', 'medium', 'high', 'max'].includes(normalizedLevel)
        ? normalizedLevel
        : true;
}

/**
 * Validate a JSON Schema string for Ollama Structured Outputs (`format`).
 */
export function validateOllamaFormatSchema(schemaJson) {
    const raw = String(schemaJson ?? '').trim();
    if (!raw) {
        return { valid: false, error: 'Schema is empty.', schema: null };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                valid: false,
                error: 'JSON Schema must be a JSON object.',
                schema: null,
            };
        }
        return { valid: true, error: null, schema: parsed };
    } catch (e) {
        return { valid: false, error: e?.message || 'Invalid JSON.', schema: null };
    }
}

/**
 * Resolve the Ollama `format` parameter from GSettings (`''`, `'json'`, or `'schema'`).
 * Returns `undefined` when standard text is selected.
 */
export function parseOllamaFormat(formatMode, schemaJson = '') {
    const mode = String(formatMode ?? '')
        .trim()
        .toLowerCase();
    if (!mode) {
        return undefined;
    }
    if (mode === 'json') {
        return 'json';
    }
    if (mode === 'schema') {
        const validated = validateOllamaFormatSchema(schemaJson);
        return validated.valid ? validated.schema : 'json';
    }
    return formatMode;
}

/**
 * Split a comma- or newline-separated stop-sequence string into a non-empty array,
 * or null when empty.
 */
export function parseOllamaStopSequences(raw) {
    if (Array.isArray(raw)) {
        const cleaned = raw.map((s) => String(s ?? '').trim()).filter(Boolean);
        return cleaned.length > 0 ? cleaned : null;
    }
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const parts = text
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    return parts.length > 0 ? parts : null;
}

/** Parse `GET /api/ps` into normalized running-model descriptors. */
export function parseOllamaPsResponse(payload) {
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models
        .filter((m) => m && typeof m === 'object' && (m.name || m.model))
        .map((m) => ({
            name: String(m.name || m.model),
            model: String(m.model || m.name),
            size: Number.isFinite(m.size) ? m.size : 0,
            sizeVram: Number.isFinite(m.size_vram) ? m.size_vram : 0,
            contextLength: Number.isFinite(m.context_length) ? m.context_length : 0,
            expiresAt: typeof m.expires_at === 'string' ? m.expires_at : '',
            parameterSize:
                typeof m.details?.parameter_size === 'string' ? m.details.parameter_size : '',
            quantizationLevel:
                typeof m.details?.quantization_level === 'string'
                    ? m.details.quantization_level
                    : '',
        }));
}

/** Parse `GET /api/tags` into normalized installed-model descriptors. */
export function parseOllamaTagsResponse(payload) {
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models
        .filter((m) => m && typeof m === 'object' && (m.name || m.model))
        .map((m) => {
            const name = String(m.name || m.model);
            return {
                name,
                size: Number.isFinite(m.size) ? m.size : 0,
                parameterSize:
                    typeof m.details?.parameter_size === 'string' ? m.details.parameter_size : '',
                quantizationLevel:
                    typeof m.details?.quantization_level === 'string'
                        ? m.details.quantization_level
                        : '',
                family: typeof m.details?.family === 'string' ? m.details.family : '',
                modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : '',
                isCloud: isOllamaCloudModel(name),
            };
        });
}

/** Format byte sizes into a compact human string (e.g. '4.2 GB', '512 MB'). */
export function formatBytesCompact(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${Math.round(n)} B`;
}

/** True when an Ollama HTTP 400 message indicates the model rejects `think`. */
export function isOllamaUnsupportedThinkingError(errorText) {
    return /does not support thinking|invalid think/i.test(String(errorText ?? ''));
}

/** True when an Ollama HTTP 400 message indicates the model rejects `tools`. */
export function isOllamaUnsupportedToolsError(errorText) {
    return /does not support tools/i.test(String(errorText ?? ''));
}
