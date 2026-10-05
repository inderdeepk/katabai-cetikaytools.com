// sessionMemory.js — Rolling session memory for Katabai
//
// Keeps older conversation turns folded into a compact, persistent summary so
// the model retains full context (project state, implementation progress,
// decisions, Q&A already covered) without resending the entire transcript on
// every request.  Pure ES module — no GJS/Clutter imports — so it can be unit
// tested with `gjs -m` like the other src/ modules.

export const SESSION_MEMORY_MARKER = '__katab_session_memory__';
// Non-streaming summarization call output cap (tokens ≈ chars / 4).
export const SESSION_MEMORY_MAX_TOKENS = 1024;
// Hard cap on the persisted memory text so it can never balloon the payload.
export const SESSION_MEMORY_MAX_CHARS = 4000;
// Bound the background summarization call so a slow local Ollama can never
// hold up anything (mirrors the RAG auto-search timeout pattern).
export const SESSION_MEMORY_TIMEOUT_MS = 60000;
// How many recent exchanges are always kept verbatim by a forced summarize.
export const SESSION_MEMORY_KEEP_EXCHANGES = 6;
// Don't auto-fold until at least this many messages would be summarized —
// summarizing trivial chats is wasted latency/tokens.
export const SESSION_MEMORY_MIN_FOLD_COUNT = 4;

// Upper bound for the whole fold prompt (instruction + memory + transcript) when
// the caller does not pass a provider-specific budget.  Callers with a smaller
// context (e.g. Ollama num-ctx) should pass maxTotalChars so the fold fits.
export const SESSION_MEMORY_FOLD_TOTAL_MAX_CHARS = 32000;

// Approximate characters-per-token used to convert token budgets into the
// JSON-serialized character budgets that splitHistoryForBudget compares.
const CHARS_PER_TOKEN = 3.5;
// Reserve 20% of the model's context for the reply so the input budget is
// never the whole window.
const OUTPUT_RESERVE_RATIO = 0.8;

// Fixed token cost charged for one attached image.  Base64 image bytes are a
// transport detail, not context — charging their raw length made a single
// photo look like ~1M tokens (and let one image evict the entire text history
// from the budget).  ~1024 tokens matches typical vision-model accounting.
export const IMAGE_TOKEN_ESTIMATE = 1024;
// Serialized characters charged in place of a base64 image payload so the
// character budget and the token estimate stay proportional.
const IMAGE_CHAR_EQUIVALENT = Math.round(IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN);

// DeepSeek input budget mirrors extension.js DEEPSEEK_INPUT_TOKEN_BUDGET
// (DEEPSEEK_MAX_CONTEXT_TOKENS 1,000,000 - DEEPSEEK_MAX_OUTPUT_TOKENS 384,000).
// Keep the two in sync if either constant changes.
const DEEPSEEK_INPUT_TOKEN_BUDGET = 616000;

// Context-window sizes (tokens) for providers that don't expose a configurable
// context in GSettings.  Unknown models fall back to a conservative default.
const OPENAI_CONTEXT_TOKENS = {
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    o1: 200000,
    'o1-mini': 128000,
    o3: 200000,
    'o3-mini': 200000,
    'o4-mini': 200000,
    'gpt-4.1': 1047576,
    'gpt-4.1-mini': 1047576,
    'gpt-4.1-nano': 1047576,
};
const ANTHROPIC_CONTEXT_TOKENS = {
    'claude-3-5-sonnet-20241022': 200000,
    'claude-3-5-haiku-20241022': 200000,
    'claude-3-7-sonnet-20250219': 200000,
    'claude-sonnet-4-20250514': 200000,
    'claude-opus-4-20250514': 200000,
    'claude-3-opus-20240229': 200000,
    'claude-3-haiku-20240307': 200000,
};

function safeGetInt(settings, key, fallback) {
    if (!settings) return fallback;
    try {
        const value = settings.get_int(key);
        return Number.isFinite(value) ? value : fallback;
    } catch (_e) {
        return fallback;
    }
}

// Context sizes must be strictly positive — 0/negative values (which the
// preference UI allows) used to produce a ZERO char budget, silently reducing
// every request to the newest user message.
function resolveContextTokens(settings, key, fallback) {
    const value = safeGetInt(settings, key, fallback);
    return value > 0 ? value : fallback;
}

function safeGetString(settings, key, fallback) {
    if (!settings) return fallback;
    try {
        const value = settings.get_string(key);
        return typeof value === 'string' ? value : fallback;
    } catch (_e) {
        return fallback;
    }
}

/**
 * Estimate the input character budget for a provider, mirroring the payload
 * size that splitHistoryForBudget compares against (JSON-serialized chars).
 * Returns a conservative fallback (200,000 chars) when unknown.
 */
export function estimateProviderCharBudget(provider, settings) {
    try {
        if (provider === 'ollama') {
            const ctx = resolveContextTokens(settings, 'ollama-num-ctx', 4096);
            return Math.max(0, Math.floor(ctx * OUTPUT_RESERVE_RATIO * CHARS_PER_TOKEN));
        }
        if (provider === 'unsloth') {
            const ctx = resolveContextTokens(settings, 'unsloth-num-ctx', 8192);
            return Math.max(0, Math.floor(ctx * OUTPUT_RESERVE_RATIO * CHARS_PER_TOKEN));
        }
        if (provider === 'deepseek') {
            return Math.floor(DEEPSEEK_INPUT_TOKEN_BUDGET * CHARS_PER_TOKEN);
        }
        if (provider === 'openai') {
            const model = String(
                safeGetString(settings, 'openai-model', 'gpt-4o') || '',
            ).toLowerCase();
            const tokens = OPENAI_CONTEXT_TOKENS[model] || 32000;
            return Math.max(0, Math.floor(tokens * OUTPUT_RESERVE_RATIO * CHARS_PER_TOKEN));
        }
        if (provider === 'anthropic') {
            const model = String(safeGetString(settings, 'anthropic-model', '') || '');
            const tokens = ANTHROPIC_CONTEXT_TOKENS[model] || 100000;
            return Math.max(0, Math.floor(tokens * OUTPUT_RESERVE_RATIO * CHARS_PER_TOKEN));
        }
    } catch (_e) {
        /* fall through to the conservative default */
    }
    return 200000;
}

export function isSessionMemoryMessage(message) {
    return Boolean(message && message._sessionMemory);
}

function boundImageString(text) {
    if (text.length <= IMAGE_CHAR_EQUIVALENT) {
        return text;
    }
    return 'A'.repeat(IMAGE_CHAR_EQUIVALENT);
}

/**
 * Serialize a value the way the context budget should count it: JSON with
 * embedded image payloads collapsed to a fixed per-image cost.  Handles the
 * three shapes Katab can put in a payload:
 *   - OpenAI-style `{ type: 'image_url', image_url: { url: 'data:image/...' } }`
 *   - Ollama-style `message.images: ['<base64>', ...]`
 *   - Anthropic-style `{ source: { type: 'base64', data: '<base64>' } }`
 * Non-image values serialize IDENTICALLY to `JSON.stringify`, so budget and
 * size math is unchanged for text-only conversations.
 */
export function stringifyContextValue(value) {
    return JSON.stringify(value, function (key, val) {
        if (typeof val === 'string') {
            if (key === 'url' && val.startsWith('data:image/')) {
                return boundImageString(val);
            }
            if (key === 'data' && this && this.type === 'base64') {
                return boundImageString(val);
            }
        }
        if (key === 'images' && Array.isArray(val)) {
            return val.map((entry) =>
                typeof entry === 'string' ? boundImageString(entry) : entry,
            );
        }
        return val;
    });
}

function messageContextSize(message) {
    try {
        return stringifyContextValue(message).length;
    } catch (_e) {
        return Infinity;
    }
}

/**
 * Split sanitized API messages into a memory system message + a verbatim tail
 * that fits within `budget` chars.  Drops from the FRONT (oldest messages)
 * only, and never drops the newest user message.
 *
 * Per-message sizes are computed ONCE and combined with prefix sums, so the
 * search for the oldest message that still fits is O(n) instead of
 * re-serializing the tail on every step (the old version was O(n²) on the
 * shell thread for long conversations).
 *
 * @returns {{ memoryMsg: object|null, tail: object[], foldedCount: number }}
 */
export function splitHistoryForBudget(messages, budget = 200000, memoryText = '') {
    const list = Array.isArray(messages) ? messages : [];
    const mem = String(memoryText || '').trim();
    const memoryMsg = mem ? { role: 'system', content: mem } : null;

    const memChars = memoryMsg ? messageContextSize(memoryMsg) : 0;

    // Prefix sums of per-message sizes.  JSON.stringify(list.slice(start))
    // length for `count = list.length - start` elements is
    // `sum(sizes) + 2 brackets + (count - 1) commas`.
    const prefix = new Array(list.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < list.length; i++) {
        prefix[i + 1] = prefix[i] + messageContextSize(list[i]);
    }
    const tailSize = (start) => {
        const count = list.length - start;
        if (count <= 0) return 2; // "[]"
        const sum = prefix[list.length] - prefix[start];
        return Number.isFinite(sum) ? sum + count + 1 : Infinity;
    };
    const fits = (start) => memChars + tailSize(start) <= budget;

    if (fits(0)) {
        return { memoryMsg, tail: list, foldedCount: 0 };
    }

    // Locate the newest real user message (skip Anthropic-style tool_result
    // array content, which is not a real user turn).
    let newestUserIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (
            m?.role === 'user' &&
            !(
                Array.isArray(m?.content) &&
                m.content.length > 0 &&
                m.content.every((b) => b?.type === 'tool_result')
            )
        ) {
            newestUserIdx = i;
            break;
        }
    }
    if (newestUserIdx < 0) {
        // No user message — leave everything to the provider safety net.
        return { memoryMsg, tail: list, foldedCount: 0 };
    }

    for (let start = 0; start <= newestUserIdx; start++) {
        if (fits(start)) {
            return { memoryMsg, tail: list.slice(start), foldedCount: start };
        }
    }

    // Even the newest user message alone overflows — keep it plus anything
    // after; the provider truncators handle a single oversized message.
    const tail = list.slice(newestUserIdx);
    return { memoryMsg, tail, foldedCount: newestUserIdx };
}

export const SESSION_MEMORY_UPDATE_INSTRUCTION =
    'You are maintaining a compact, persistent session memory for an ongoing ' +
    'coding conversation. Merge the current memory with the new messages below ' +
    'and output ONLY the updated memory — no preamble, no code fences.\n\n' +
    'The memory must be lossless about important facts and organized in these ' +
    'sections:\n' +
    '- Project & Goal: what the user is working on and the end goal.\n' +
    '- Current State: where the work stands right now — files/areas, the active ' +
    'question, and why it is being asked.\n' +
    '- Progress: what is completed, what is in progress, and what remains ' +
    '(checklist style).\n' +
    '- Decisions: choices, conventions, and constraints agreed so far.\n' +
    '- Questions & Answers: questions already asked and the answers given ' +
    '(one line each).\n' +
    '- Next Steps: what to do next and any open threads.\n\n' +
    'Rules: retain every still-relevant fact (names, paths, versions, errors, ' +
    'decisions) from the current memory; add all important new information; drop ' +
    'only what is now irrelevant. Keep the whole memory under ~800 words.';

/**
 * Build the single user message sent to the model to update the memory.
 * A single user role works uniformly across all providers (including Anthropic,
 * which drops system messages in its non-streaming path).
 *
 * The fold transcript is bounded by `maxTotalChars` (the provider context
 * budget): on small-context providers an unbounded fold prompt would overflow
 * context, and any server-side truncation drops the instruction block at the
 * head first.  When the transcript must shrink, the NEWEST folded messages are
 * kept — they are nearest the live conversation.
 */
export function buildMemoryUpdateMessages(
    currentMemory,
    toFold,
    { maxTotalChars = SESSION_MEMORY_FOLD_TOTAL_MAX_CHARS } = {},
) {
    const existing = String(currentMemory || '').trim();

    let transcript = (Array.isArray(toFold) ? toFold : [])
        .map((message) => {
            const role = message?.role || 'unknown';
            const content =
                typeof message?.content === 'string'
                    ? message.content
                    : JSON.stringify(message?.content ?? '');
            return `[${role}] ${content}`;
        })
        .filter(Boolean)
        .join('\n\n');

    const fixedOverhead = SESSION_MEMORY_UPDATE_INSTRUCTION.length + existing.length + 200;
    const transcriptCap = Math.max(
        1000,
        Math.floor((maxTotalChars || SESSION_MEMORY_FOLD_TOTAL_MAX_CHARS) - fixedOverhead),
    );
    if (transcript.length > transcriptCap) {
        transcript = `[...older messages trimmed...]\n\n${transcript.slice(transcript.length - transcriptCap)}`;
    }

    const parts = [];
    if (existing) {
        parts.push(`CURRENT SESSION MEMORY:\n${existing}`);
    }
    parts.push(`NEW MESSAGES TO FOLD IN:\n${transcript || '(none)'}`);

    return [
        {
            role: 'user',
            content: `${SESSION_MEMORY_UPDATE_INSTRUCTION}\n\n${parts.join('\n\n')}`,
        },
    ];
}

/**
 * Validate/trim the model's memory response.  Returns null when the model
 * produced nothing usable so the caller keeps the previous memory.
 */
export function parseMemoryResponse(text) {
    const cleaned = String(text ?? '').trim();
    if (!cleaned) {
        return null;
    }
    if (cleaned.length > SESSION_MEMORY_MAX_CHARS) {
        return cleaned.slice(0, SESSION_MEMORY_MAX_CHARS).trim();
    }
    return cleaned;
}
