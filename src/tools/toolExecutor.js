// toolExecutor.js — Tool-call normalization, argument repair, turn-scoped
// deduplication/caching, bounded parallel batch execution, and linked
// per-tool timeouts.
//
// Pure ES module (only imports GLib/Gio for createLinkedTimeoutCancellable;
// everything else is pure JS) so the entire execution engine is directly
// unit-testable with `gjs -m` without the GNOME Shell UI.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { DANGER_POTENTIALLY_UNSAFE, DANGER_READ_ONLY } from './toolRegistry.js';

export const DEFAULT_MAX_TOOL_CONCURRENCY = 4;
export const DEFAULT_TOOL_TIMEOUT_MS = 60000;

export const TOOL_TIMEOUTS_MS = Object.freeze({
    web_search: 45000,
    read_url: 45000,
    crawl_url: 90000,
    explore_docs: 90000,
    knowledge_search: 30000,
    update_knowledge: 30000,
    forget_knowledge: 30000,
});

const KNOWLEDGE_MUTATING_TOOLS = new Set(['update_knowledge', 'forget_knowledge']);
const CACHE_REFERENCE_THRESHOLD_CHARS = 1600;
const CACHE_REFERENCE_EXCERPT_CHARS = 900;

/**
 * Resolve the per-tool timeout in milliseconds.
 * @param {string} toolName
 * @returns {number}
 */
export function getToolTimeoutMs(toolName) {
    const specific = TOOL_TIMEOUTS_MS[toolName];
    return Number.isFinite(specific) && specific > 0 ? specific : DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * Create a child Gio.Cancellable linked to `parentCancellable` AND a wall-clock
 * timeout. Cancelling either aborts the child cancellable immediately so
 * underlying libsoup / subprocess work actually stops instead of leaking.
 *
 * Always call `cleanup()` in a `finally` block to avoid leaking the signal
 * handler or GLib timeout source.
 *
 * @param {Gio.Cancellable|null} parentCancellable
 * @param {number} timeoutMs
 * @returns {{ cancellable: Gio.Cancellable, isTimedOut: () => boolean, isParentCancelled: () => boolean, cleanup: () => void }}
 */
export function createLinkedTimeoutCancellable(parentCancellable, timeoutMs) {
    const child = new Gio.Cancellable();
    let timedOut = false;
    let parentHandlerId = 0;
    let timeoutId = 0;
    let cleanedUp = false;

    const cleanup = () => {
        if (cleanedUp) {
            return;
        }
        cleanedUp = true;
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        if (parentHandlerId && parentCancellable) {
            try {
                parentCancellable.disconnect(parentHandlerId);
            } catch (_e) {
                /* already disconnected */
            }
            parentHandlerId = 0;
        }
    };

    if (parentCancellable?.is_cancelled?.()) {
        child.cancel();
    } else {
        if (parentCancellable && typeof parentCancellable.connect === 'function') {
            parentHandlerId = parentCancellable.connect(() => {
                if (!child.is_cancelled()) {
                    child.cancel();
                }
            });
        }
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(timeoutMs), () => {
                timeoutId = 0;
                if (!child.is_cancelled()) {
                    timedOut = true;
                    child.cancel();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    return {
        cancellable: child,
        isTimedOut: () => timedOut,
        isParentCancelled: () => Boolean(parentCancellable?.is_cancelled?.()),
        cleanup,
    };
}

/**
 * Extract the first balanced JSON object `{...}` from a string, ignoring braces
 * inside string literals.
 * @param {string} text
 * @returns {string|null}
 */
function extractFirstBalancedObject(text) {
    const start = text.indexOf('{');
    if (start < 0) {
        return null;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === '\\' && inString) {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }
    return null;
}

/**
 * Strip trailing commas outside string literals (a common LLM JSON glitch).
 * @param {string} jsonStr
 * @returns {string}
 */
function stripTrailingCommas(jsonStr) {
    let out = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < jsonStr.length; i++) {
        const ch = jsonStr[i];
        if (escape) {
            out += ch;
            escape = false;
            continue;
        }
        if (ch === '\\' && inString) {
            out += ch;
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            out += ch;
            continue;
        }
        if (!inString && ch === ',') {
            let j = i + 1;
            while (j < jsonStr.length && /\s/.test(jsonStr[j])) {
                j++;
            }
            if (j < jsonStr.length && (jsonStr[j] === '}' || jsonStr[j] === ']')) {
                continue;
            }
        }
        out += ch;
    }
    return out;
}

/**
 * Parse tool-call arguments with safe repair for common LLM JSON glitches
 * (code fences, trailing commas, stray wrapper text). Returns structured status
 * so malformed arguments surface a clear actionable error to the model instead
 * of silently dispatching a tool with empty `{}`.
 *
 * @param {unknown} rawArgs
 * @returns {{ ok: boolean, args: Object, repaired: boolean, error: string|null }}
 */
export function parseToolCallArguments(rawArgs) {
    if (rawArgs === null || rawArgs === undefined) {
        return { ok: true, args: {}, repaired: false, error: null };
    }
    if (typeof rawArgs === 'object') {
        if (Array.isArray(rawArgs)) {
            return {
                ok: false,
                args: {},
                repaired: false,
                error: 'Tool arguments must be a JSON object, received an array.',
            };
        }
        return { ok: true, args: rawArgs, repaired: false, error: null };
    }
    if (typeof rawArgs !== 'string') {
        return {
            ok: false,
            args: {},
            repaired: false,
            error: `Tool arguments must be a JSON object, received ${typeof rawArgs}.`,
        };
    }

    const trimmed = rawArgs.trim();
    if (!trimmed) {
        return { ok: true, args: {}, repaired: false, error: null };
    }

    // Fast path: strict JSON.parse
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, args: parsed, repaired: false, error: null };
        }
        return {
            ok: false,
            args: {},
            repaired: false,
            error: `Tool arguments must be a JSON object, received ${Array.isArray(parsed) ? 'array' : typeof parsed}.`,
        };
    } catch (_strictErr) {
        // Attempt safe repair: unwrap markdown fences, extract balanced object,
        // strip trailing commas.
        let candidate = trimmed;
        const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        if (fenceMatch) {
            candidate = fenceMatch[1].trim();
        }
        const extracted = extractFirstBalancedObject(candidate) || candidate;
        const cleaned = stripTrailingCommas(extracted);
        try {
            const parsed = JSON.parse(cleaned);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return { ok: true, args: parsed, repaired: true, error: null };
            }
        } catch (_repairErr) {
            /* fall through to structured error */
        }
        const preview = trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
        return {
            ok: false,
            args: {},
            repaired: false,
            error: `Invalid JSON in tool arguments (${preview}). Please retry with a valid JSON object matching the tool schema.`,
        };
    }
}

/**
 * Sanitize a tool-call ID so it satisfies strict provider constraints
 * (Anthropic requires `[a-zA-Z0-9_-]+`, OpenAI requires non-empty string).
 * @param {string} rawId
 * @param {string} fallbackId
 * @returns {string}
 */
export function sanitizeToolCallId(rawId, fallbackId) {
    const cleaned = String(rawId || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned || fallbackId;
}

/**
 * Normalize an array of raw tool calls from any provider into a uniform shape
 * with guaranteed unique, API-safe IDs before recording them in history or
 * executing them.
 *
 * @param {Array<Object>} rawToolCalls
 * @param {{ turnPrefix?: string, iteration?: number }} [options]
 * @returns {Array<Object>}
 */
export function normalizeToolCalls(rawToolCalls, { turnPrefix = 'call', iteration = 0 } = {}) {
    if (!Array.isArray(rawToolCalls)) {
        return [];
    }
    const seenIds = new Set();
    const normalized = [];

    for (let i = 0; i < rawToolCalls.length; i++) {
        const tc = rawToolCalls[i];
        if (!tc || typeof tc !== 'object') {
            continue;
        }
        const fn = tc.function && typeof tc.function === 'object' ? tc.function : {};
        const name = String(fn.name || tc.name || '').trim();
        if (!name) {
            continue;
        }

        const fallbackId = `${turnPrefix}_${iteration}_${i}`;
        let id = sanitizeToolCallId(tc.id, fallbackId);
        if (seenIds.has(id)) {
            let suffix = 1;
            while (seenIds.has(`${id}_${suffix}`)) {
                suffix++;
            }
            id = `${id}_${suffix}`;
        }
        seenIds.add(id);

        const rawArgs = tc._invalidJson ? tc._rawArguments : fn.arguments;
        const parsed = parseToolCallArguments(rawArgs);
        const serializedArgs = parsed.ok
            ? JSON.stringify(parsed.args)
            : typeof rawArgs === 'string'
              ? rawArgs
              : '{}';

        const entry = {
            id,
            type: 'function',
            function: {
                name,
                arguments: serializedArgs,
            },
        };
        // Attach non-enumerable parse result so callers can avoid double-parsing
        // without polluting JSON.stringify(message.tool_calls).
        Object.defineProperty(entry, '_parsedArgs', {
            value: parsed,
            enumerable: false,
            configurable: true,
        });
        normalized.push(entry);
    }

    return normalized;
}

/**
 * Produce a deterministic canonical JSON string with recursively sorted object
 * keys so semantically identical tool arguments map to the same cache key.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalizeValue(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalizeValue(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
        const v = value[key];
        if (v === undefined) {
            continue;
        }
        parts.push(`${JSON.stringify(key)}:${canonicalizeValue(v)}`);
    }
    return `{${parts.join(',')}}`;
}

/**
 * Build a normalized deduplication/cache key for a tool invocation.
 * @param {string} toolName
 * @param {Object} args
 * @returns {string}
 */
export function buildToolCacheKey(toolName, args) {
    const normalizedArgs = {};
    if (args && typeof args === 'object') {
        for (const [key, val] of Object.entries(args)) {
            if (val === undefined) {
                continue;
            }
            if (typeof val === 'string' && (key === 'query' || key === 'url')) {
                normalizedArgs[key] =
                    key === 'query' ? val.trim().replace(/\s+/g, ' ').toLowerCase() : val.trim();
            } else {
                normalizedArgs[key] = val;
            }
        }
    }
    return `${toolName}:${canonicalizeValue(normalizedArgs)}`;
}

/**
 * Turn-scoped execution session: caches successful read-only tool outputs
 * within a single user turn so repeated identical calls don't re-hit the
 * network or bloat the model's context window with duplicate 16KB pages.
 */
export class ToolExecutionSession {
    constructor() {
        /** @type {Map<string, { toolName: string, result: string, iteration: number, summary: string }>} */
        this._cache = new Map();
        this.stats = {
            executed: 0,
            cacheHits: 0,
            dedupedInFlight: 0,
            errors: 0,
            totalElapsedMs: 0,
        };
    }

    getCached(toolName, args) {
        const key = buildToolCacheKey(toolName, args);
        return this._cache.get(key) || null;
    }

    setCached(toolName, args, result, iteration = 0, summary = '') {
        if (typeof result !== 'string' || !result) {
            return;
        }
        const key = buildToolCacheKey(toolName, args);
        this._cache.set(key, {
            toolName,
            result,
            iteration,
            summary,
        });
    }

    invalidateTool(toolName) {
        const prefix = `${toolName}:`;
        for (const key of this._cache.keys()) {
            if (key.startsWith(prefix)) {
                this._cache.delete(key);
            }
        }
    }

    /**
     * Format a cached tool output for a repeat call in a later iteration of the
     * same turn. Compact results are returned verbatim; large results return a
     * concise excerpt plus a reminder to avoid duplicating 16KB of text in the
     * prompt.
     *
     * @param {string} toolName
     * @param {{ result: string, iteration: number }} entry
     * @param {number} currentIteration
     * @returns {string}
     */
    formatCachedResult(toolName, entry, currentIteration) {
        if (!entry || typeof entry.result !== 'string') {
            return '';
        }
        if (
            entry.result.length <= CACHE_REFERENCE_THRESHOLD_CHARS ||
            entry.iteration === currentIteration
        ) {
            return entry.result;
        }
        const excerpt = entry.result.slice(0, CACHE_REFERENCE_EXCERPT_CHARS).trimEnd();
        return (
            `[Duplicate call skipped: ${toolName} with identical arguments was already retrieved earlier in this turn (step ${entry.iteration + 1}). ` +
            `The full output is already present in the earlier tool message above. Excerpt:]\n\n` +
            `${excerpt}…\n\n` +
            `[Do not repeat identical ${toolName} calls — use the existing output above or try a different query/URL.]`
        );
    }

    clear() {
        this._cache.clear();
    }
}

/**
 * Format elapsed milliseconds as a compact human-readable duration (e.g. "0.4s", "12s").
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsedMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return '';
    }
    if (ms < 100) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 10000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${Math.round(ms / 1000)}s`;
}

/**
 * Cancellable sleep helper backed by GLib main loop.
 * Resolves immediately if `cancellable` is already cancelled or fires mid-wait.
 *
 * @param {number} ms
 * @param {Gio.Cancellable|null} [cancellable=null]
 * @returns {Promise<void>}
 */
function sleepCancellable(ms, cancellable = null) {
    if (!Number.isFinite(ms) || ms <= 0 || cancellable?.is_cancelled?.()) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let settled = false;
        let timeoutId = 0;
        let cancelId = 0;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            if (cancelId && cancellable) {
                try {
                    cancellable.disconnect(cancelId);
                } catch (_e) {
                    /* already disconnected */
                }
                cancelId = 0;
            }
            resolve();
        };
        if (cancellable && typeof cancellable.connect === 'function') {
            cancelId = cancellable.connect(() => finish());
        }
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(ms), () => {
            timeoutId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Execute a batch of normalized tool calls with:
 *   - Read-only / potentially-unsafe partitioning
 *   - Turn-scoped read-only result caching (avoids redundant calls across iterations)
 *   - In-flight deduplication for identical read-only calls within the same batch
 *   - Bounded concurrency pool for read-only calls
 *   - Serial cancellable execution for potentially-unsafe calls
 *   - Original `toolCalls` ordering preserved in the returned result array
 *
 * @param {Object} params
 * @param {Array<Object>} params.toolCalls - Normalized tool calls
 * @param {(toolName: string) => string} params.classifyDanger - Returns DANGER_READ_ONLY or DANGER_POTENTIALLY_UNSAFE
 * @param {(tc: Object, meta: { parsedArgs: Object, index: number, fromCache: boolean, deduped: boolean, cachedEntry: Object|null }) => Promise<{ result: string, cacheable?: boolean, summary?: string, error?: boolean, meta?: any }>} params.executeOne
 * @param {ToolExecutionSession|null} [params.session]
 * @param {number} [params.iteration=0]
 * @param {Gio.Cancellable|null} [params.cancellable=null]
 * @param {number} [params.maxConcurrency=DEFAULT_MAX_TOOL_CONCURRENCY]
 * @param {number|(() => number)|null} [params.serialDelayMs=0] - Optional polite delay between sequential unsafe calls
 * @param {(info: { completed: number, total: number, activeCount: number }) => void} [params.onProgress]
 * @returns {Promise<Array<{ index: number, toolCall: Object, result: string, elapsedMs: number, fromCache: boolean, deduped: boolean, error: boolean, cancelled: boolean, meta: any }>>}
 */
export async function executeToolBatch({
    toolCalls,
    classifyDanger,
    executeOne,
    session = null,
    iteration = 0,
    cancellable = null,
    maxConcurrency = DEFAULT_MAX_TOOL_CONCURRENCY,
    serialDelayMs = 0,
    onProgress = null,
}) {
    const total = Array.isArray(toolCalls) ? toolCalls.length : 0;
    if (total === 0) {
        return [];
    }

    const results = new Array(total);
    const readOnlyTasks = [];
    const unsafeTasks = [];

    for (let i = 0; i < total; i++) {
        const tc = toolCalls[i];
        const toolName = tc.function?.name || '';
        const parsedArgs = tc._parsedArgs || parseToolCallArguments(tc.function?.arguments);
        const danger = classifyDanger ? classifyDanger(toolName) : DANGER_POTENTIALLY_UNSAFE;
        const task = {
            index: i,
            toolCall: tc,
            toolName,
            parsedArgs,
            cacheKey:
                danger === DANGER_READ_ONLY && parsedArgs.ok
                    ? buildToolCacheKey(toolName, parsedArgs.args)
                    : null,
        };
        if (danger === DANGER_READ_ONLY) {
            readOnlyTasks.push(task);
        } else {
            unsafeTasks.push(task);
        }
    }

    let completed = 0;
    let activeCount = 0;
    const emitProgress = () => {
        if (typeof onProgress === 'function') {
            try {
                onProgress({ completed, total, activeCount });
            } catch (_e) {
                /* progress callback must not break tool execution */
            }
        }
    };

    const resolveDelay = () => {
        if (typeof serialDelayMs === 'function') {
            const val = Number(serialDelayMs());
            return Number.isFinite(val) && val > 0 ? val : 0;
        }
        const val = Number(serialDelayMs);
        return Number.isFinite(val) && val > 0 ? val : 0;
    };

    // 1. Read-only tasks: deduplicate in-flight + turn cache + bounded pool.
    if (readOnlyTasks.length > 0) {
        /** @type {Map<string, Promise<Object>>} */
        const inFlight = new Map();
        const queue = [];

        for (const task of readOnlyTasks) {
            if (cancellable?.is_cancelled?.()) {
                results[task.index] = {
                    index: task.index,
                    toolCall: task.toolCall,
                    result: 'Tool execution cancelled.',
                    elapsedMs: 0,
                    fromCache: false,
                    deduped: false,
                    error: true,
                    cancelled: true,
                    meta: null,
                };
                completed++;
                emitProgress();
                continue;
            }

            // Check turn-scoped cache first
            const cachedEntry =
                session && task.cacheKey
                    ? session.getCached(task.toolName, task.parsedArgs.args)
                    : null;
            if (cachedEntry) {
                if (session) {
                    session.stats.cacheHits++;
                }
                const startMs = Date.now();
                const outcome = await executeOne(task.toolCall, {
                    parsedArgs: task.parsedArgs,
                    index: task.index,
                    fromCache: true,
                    deduped: false,
                    cachedEntry,
                });
                results[task.index] = {
                    index: task.index,
                    toolCall: task.toolCall,
                    result: outcome?.result ?? '',
                    elapsedMs: Date.now() - startMs,
                    fromCache: true,
                    deduped: false,
                    error: Boolean(outcome?.error),
                    cancelled: false,
                    meta: outcome?.meta ?? null,
                };
                completed++;
                emitProgress();
                continue;
            }

            // Coalesce duplicate read-only calls in the same batch
            if (task.cacheKey && inFlight.has(task.cacheKey)) {
                const leaderPromise = inFlight.get(task.cacheKey);
                if (session) {
                    session.stats.dedupedInFlight++;
                }
                queue.push({ task, leaderPromise });
                continue;
            }

            let resolveLeader;
            const leaderPromise = new Promise((resolve) => {
                resolveLeader = resolve;
            });
            if (task.cacheKey) {
                inFlight.set(task.cacheKey, leaderPromise);
            }
            queue.push({ task, resolveLeader });
        }

        const primaryQueue = queue.filter((item) => item.resolveLeader);
        const followerQueue = queue.filter((item) => item.leaderPromise);

        const concurrency = Math.max(
            1,
            Math.min(
                Number.isFinite(maxConcurrency) && maxConcurrency > 0
                    ? Math.floor(maxConcurrency)
                    : DEFAULT_MAX_TOOL_CONCURRENCY,
                primaryQueue.length || 1,
            ),
        );

        let nextIdx = 0;
        const runWorker = async () => {
            while (nextIdx < primaryQueue.length) {
                const item = primaryQueue[nextIdx++];
                const { task, resolveLeader } = item;

                if (cancellable?.is_cancelled?.()) {
                    const cancelledOutcome = {
                        index: task.index,
                        toolCall: task.toolCall,
                        result: 'Tool execution cancelled.',
                        elapsedMs: 0,
                        fromCache: false,
                        deduped: false,
                        error: true,
                        cancelled: true,
                        meta: null,
                    };
                    results[task.index] = cancelledOutcome;
                    resolveLeader(cancelledOutcome);
                    completed++;
                    emitProgress();
                    continue;
                }

                activeCount++;
                emitProgress();
                const startMs = Date.now();
                let outcome;
                try {
                    const execRes = await executeOne(task.toolCall, {
                        parsedArgs: task.parsedArgs,
                        index: task.index,
                        fromCache: false,
                        deduped: false,
                        cachedEntry: null,
                    });
                    const elapsedMs = Date.now() - startMs;
                    const isError = Boolean(execRes?.error);
                    const isCancelled = Boolean(
                        execRes?.cancelled || cancellable?.is_cancelled?.(),
                    );
                    const resultText = execRes?.result ?? '';
                    if (session) {
                        session.stats.executed++;
                        session.stats.totalElapsedMs += elapsedMs;
                        if (isError || isCancelled) {
                            session.stats.errors++;
                        } else if (task.cacheKey && execRes?.cacheable !== false && resultText) {
                            session.setCached(
                                task.toolName,
                                task.parsedArgs.args,
                                resultText,
                                iteration,
                                execRes?.summary || '',
                            );
                        }
                    }
                    outcome = {
                        index: task.index,
                        toolCall: task.toolCall,
                        result: resultText,
                        elapsedMs,
                        fromCache: false,
                        deduped: false,
                        error: isError,
                        cancelled: isCancelled,
                        meta: execRes?.meta ?? null,
                    };
                } catch (err) {
                    const elapsedMs = Date.now() - startMs;
                    const isCancelled = Boolean(
                        cancellable?.is_cancelled?.() ||
                        err?.code === 'cancelled' ||
                        err?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED),
                    );
                    if (session) {
                        session.stats.executed++;
                        session.stats.errors++;
                        session.stats.totalElapsedMs += elapsedMs;
                    }
                    outcome = {
                        index: task.index,
                        toolCall: task.toolCall,
                        result: isCancelled
                            ? 'Tool execution cancelled.'
                            : `Tool error: ${err?.message || String(err)}`,
                        elapsedMs,
                        fromCache: false,
                        deduped: false,
                        error: true,
                        cancelled: isCancelled,
                        meta: null,
                    };
                } finally {
                    activeCount--;
                    completed++;
                }

                results[task.index] = outcome;
                resolveLeader(outcome);
                emitProgress();
            }
        };

        const workers = [];
        for (let w = 0; w < concurrency; w++) {
            workers.push(runWorker());
        }
        await Promise.all(workers);

        // Resolve followers that shared an in-flight call
        for (const { task, leaderPromise } of followerQueue) {
            const leaderOutcome = await leaderPromise;
            if (leaderOutcome.cancelled || cancellable?.is_cancelled?.()) {
                results[task.index] = {
                    index: task.index,
                    toolCall: task.toolCall,
                    result: 'Tool execution cancelled.',
                    elapsedMs: 0,
                    fromCache: false,
                    deduped: true,
                    error: true,
                    cancelled: true,
                    meta: null,
                };
                completed++;
                emitProgress();
                continue;
            }
            const reused = await executeOne(task.toolCall, {
                parsedArgs: task.parsedArgs,
                index: task.index,
                fromCache: true,
                deduped: true,
                cachedEntry: {
                    toolName: task.toolName,
                    result: leaderOutcome.result,
                    iteration,
                    summary: '',
                    error: leaderOutcome.error,
                },
            });
            results[task.index] = {
                index: task.index,
                toolCall: task.toolCall,
                result: reused?.result ?? leaderOutcome.result,
                elapsedMs: 0,
                fromCache: true,
                deduped: true,
                error: Boolean(leaderOutcome.error),
                cancelled: false,
                meta: reused?.meta ?? leaderOutcome.meta ?? null,
            };
            completed++;
            emitProgress();
        }
    }

    // 2. Potentially-unsafe tasks: execute serially in original order.
    for (let u = 0; u < unsafeTasks.length; u++) {
        const task = unsafeTasks[u];
        if (u > 0 && !cancellable?.is_cancelled?.()) {
            const delayMs = resolveDelay();
            if (delayMs > 0) {
                await sleepCancellable(delayMs, cancellable);
            }
        }
        if (cancellable?.is_cancelled?.()) {
            results[task.index] = {
                index: task.index,
                toolCall: task.toolCall,
                result: 'Tool execution cancelled.',
                elapsedMs: 0,
                fromCache: false,
                deduped: false,
                error: true,
                cancelled: true,
                meta: null,
            };
            completed++;
            emitProgress();
            continue;
        }

        activeCount++;
        emitProgress();
        const startMs = Date.now();
        try {
            const execRes = await executeOne(task.toolCall, {
                parsedArgs: task.parsedArgs,
                index: task.index,
                fromCache: false,
                deduped: false,
                cachedEntry: null,
            });
            const elapsedMs = Date.now() - startMs;
            const isError = Boolean(execRes?.error);
            const isCancelled = Boolean(execRes?.cancelled || cancellable?.is_cancelled?.());
            if (session) {
                session.stats.executed++;
                session.stats.totalElapsedMs += elapsedMs;
                if (isError || isCancelled) {
                    session.stats.errors++;
                }
                if (!isError && !isCancelled && KNOWLEDGE_MUTATING_TOOLS.has(task.toolName)) {
                    session.invalidateTool('knowledge_search');
                }
            }
            results[task.index] = {
                index: task.index,
                toolCall: task.toolCall,
                result: execRes?.result ?? '',
                elapsedMs,
                fromCache: false,
                deduped: false,
                error: isError,
                cancelled: isCancelled,
                meta: execRes?.meta ?? null,
            };
        } catch (err) {
            const elapsedMs = Date.now() - startMs;
            const isCancelled = Boolean(
                cancellable?.is_cancelled?.() ||
                err?.code === 'cancelled' ||
                err?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED),
            );
            if (session) {
                session.stats.executed++;
                session.stats.errors++;
                session.stats.totalElapsedMs += elapsedMs;
            }
            results[task.index] = {
                index: task.index,
                toolCall: task.toolCall,
                result: isCancelled
                    ? 'Tool execution cancelled.'
                    : `Tool error: ${err?.message || String(err)}`,
                elapsedMs,
                fromCache: false,
                deduped: false,
                error: true,
                cancelled: isCancelled,
                meta: null,
            };
        } finally {
            activeCount--;
            completed++;
            emitProgress();
        }
    }

    return results;
}
