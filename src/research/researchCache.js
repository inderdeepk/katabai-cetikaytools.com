// researchCache.js — Persistent research result cache for Katab
//
// Caches SearxNG search results and Crawl4AI crawl results on disk to avoid
// redundant API calls during deep research sessions.  Uses a JSON file at
// ~/.local/share/katabai/research-cache.json with SHA-256 hashed keys.
//
// Entries have a configurable TTL (default 24 hours) and the cache is
// pruned to a maximum number of entries on every write.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ── SHA-256 hashing (subtle crypto not available in GJS — use GLib) ──────────

function _hashString(str) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, str, -1);
}

// ── File paths ───────────────────────────────────────────────────────────────

let _testCachePath = null;

// Test-only override for the on-disk cache path, so unit tests never write to
// the real ~/.local/share/katabai/research-cache.json. Pass null to restore.
export function _setCachePathForTesting(path) {
    _testCachePath = path || null;
    _cache = null; // force reload from the new path on next access
}

function _cacheFilePath() {
    if (_testCachePath) return _testCachePath;
    const dataDir = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'katabai']);
    const dir = Gio.File.new_for_path(dataDir);
    if (!dir.query_exists(null)) {
        dir.make_directory_with_parents(null);
    }
    return GLib.build_filenamev([dataDir, 'research-cache.json']);
}

// ── In-memory cache ──────────────────────────────────────────────────────────

let _cache = null;        // { entries: { keyHash: { query, results, crawledAt } }, order: [keyHash] }
let _dirty = false;
let _flushTimerId = 0;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FLUSH_DEBOUNCE_MS = 500;

// ── Load / save ──────────────────────────────────────────────────────────────

function _loadCache() {
    if (_cache !== null) return;
    try {
        const file = Gio.File.new_for_path(_cacheFilePath());
        if (!file.query_exists(null)) {
            _cache = { entries: {}, order: [] };
            return;
        }
        const [, contents] = file.load_contents(null);
        const decoder = new TextDecoder('utf-8');
        _cache = JSON.parse(decoder.decode(contents));
        if (!_cache.entries || !Array.isArray(_cache.order)) {
            _cache = { entries: {}, order: [] };
        }
    } catch (_e) {
        _cache = { entries: {}, order: [] };
    }
}

function _scheduleFlush() {
    _dirty = true;
    if (_flushTimerId) return;
    _flushTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLUSH_DEBOUNCE_MS, () => {
        _flushTimerId = 0;
        _flushNow();
        return GLib.SOURCE_REMOVE;
    });
}

function _flushNow() {
    // Clear the debounce timer — someone called flush directly
    if (_flushTimerId) {
        GLib.source_remove(_flushTimerId);
        _flushTimerId = 0;
    }
    if (!_dirty || !_cache) return;
    _dirty = false;
    try {
        const encoder = new TextEncoder();
        const data = JSON.stringify(_cache);
        const file = Gio.File.new_for_path(_cacheFilePath());
        file.replace_contents(
            encoder.encode(data),
            null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    } catch (e) {
        log(`[Katab:cache] Failed to flush research cache: ${e.message}`);
    }
}

/** Force flush pending writes — call before shutdown. */
export function flushCacheSync() {
    _flushNow();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Cache search results for a query.
 * @param {string} query - The search query string
 * @param {*} results - The search results payload (serializable)
 */
export function cacheSearchResults(query, results) {
    _loadCache();
    const keyHash = _hashString(String(query || '').toLowerCase().trim());
    const entry = {
        type: 'search',
        query,
        results,
        cachedAt: Date.now(),
    };

    // Remove existing entry if present (move to front on re-cache)
    const existingIdx = _cache.order.indexOf(keyHash);
    if (existingIdx >= 0) {
        _cache.order.splice(existingIdx, 1);
    }

    _cache.entries[keyHash] = entry;
    _cache.order.unshift(keyHash);

    // Prune if over limit
    while (_cache.order.length > DEFAULT_MAX_ENTRIES) {
        const oldest = _cache.order.pop();
        delete _cache.entries[oldest];
    }

    _scheduleFlush();
}

/**
 * Retrieve cached search results for a query.
 * @param {string} query - The search query string
 * @param {number} [maxAgeMs=86400000] - Max age in ms (default 24h)
 * @returns {*|null} Cached results, or null if not found / expired
 */
export function getCachedSearchResults(query, maxAgeMs = DEFAULT_TTL_MS) {
    _loadCache();
    const keyHash = _hashString(String(query || '').toLowerCase().trim());
    const entry = _cache.entries[keyHash];
    if (!entry || entry.type !== 'search') return null;

    const age = Date.now() - (entry.cachedAt || 0);
    if (age > maxAgeMs) {
        // Expired — remove from cache
        delete _cache.entries[keyHash];
        const idx = _cache.order.indexOf(keyHash);
        if (idx >= 0) _cache.order.splice(idx, 1);
        _scheduleFlush();
        return null;
    }

    return entry.results;
}

/**
 * Cache a crawl result for a URL.
 * @param {string} url - The URL that was crawled
 * @param {*} result - The crawl result payload (serializable)
 */
export function cacheCrawlResult(url, result) {
    _loadCache();
    const keyHash = _hashString(String(url || '').trim());
    const entry = {
        type: 'crawl',
        url,
        result,
        cachedAt: Date.now(),
    };

    const existingIdx = _cache.order.indexOf(keyHash);
    if (existingIdx >= 0) {
        _cache.order.splice(existingIdx, 1);
    }

    _cache.entries[keyHash] = entry;
    _cache.order.unshift(keyHash);

    while (_cache.order.length > DEFAULT_MAX_ENTRIES) {
        const oldest = _cache.order.pop();
        delete _cache.entries[oldest];
    }

    _scheduleFlush();
}

/**
 * Retrieve cached crawl result for a URL.
 * @param {string} url - The URL that was crawled
 * @param {number} [maxAgeMs=86400000] - Max age in ms (default 24h)
 * @returns {*|null} Cached result, or null if not found / expired
 */
export function getCachedCrawlResult(url, maxAgeMs = DEFAULT_TTL_MS) {
    _loadCache();
    const keyHash = _hashString(String(url || '').trim());
    const entry = _cache.entries[keyHash];
    if (!entry || entry.type !== 'crawl') return null;

    const age = Date.now() - (entry.cachedAt || 0);
    if (age > maxAgeMs) {
        delete _cache.entries[keyHash];
        const idx = _cache.order.indexOf(keyHash);
        if (idx >= 0) _cache.order.splice(idx, 1);
        _scheduleFlush();
        return null;
    }

    return entry.result;
}

// ── LLM extraction cache ─────────────────────────────────────────────────────
//
// LLM extractions are expensive (paid per call), so they are cached like
// plain crawl results but keyed by BOTH the URL and the extraction parameters
// (mode, provider, instruction, schema).  Changing any of those invalidates
// the cache implicitly because the derived key no longer matches.

function _llmCacheKey(url, config) {
    const parts = [
        String(url || '').trim(),
        config?.extractionMode || 'markdown',
        config?.llmProvider || '',
        config?.llmInstruction || '',
        config?.llmSchemaJson || '',
    ];
    // NOTE: hash the JSON serialization, not parts.join('\u0000').  GLib's
    // compute_checksum_for_string with length=-1 stops at the first NUL byte,
    // so a \u0000 separator would truncate the input and collide every entry
    // sharing a URL.
    return _hashString(JSON.stringify(parts));
}

/**
 * Cache an LLM extraction result for a URL + extraction configuration.
 * @param {string} url - The URL that was crawled
 * @param {*} result - The parsed crawl result payload (serializable)
 * @param {object} config - Crawl4AI config (drives the cache key)
 */
export function cacheLLMExtractionResult(url, result, config) {
    _loadCache();
    const keyHash = _llmCacheKey(url, config);
    const entry = {
        type: 'llm-extraction',
        url,
        result,
        cachedAt: Date.now(),
    };

    const existingIdx = _cache.order.indexOf(keyHash);
    if (existingIdx >= 0) {
        _cache.order.splice(existingIdx, 1);
    }

    _cache.entries[keyHash] = entry;
    _cache.order.unshift(keyHash);

    while (_cache.order.length > DEFAULT_MAX_ENTRIES) {
        const oldest = _cache.order.pop();
        delete _cache.entries[oldest];
    }

    _scheduleFlush();
}

/**
 * Retrieve a cached LLM extraction result for a URL + extraction config.
 * @param {string} url - The URL that was crawled
 * @param {object} config - Crawl4AI config (drives the cache key)
 * @param {number} [maxAgeMs=86400000] - Max age in ms (default 24h)
 * @returns {*|null} Cached result, or null if not found / expired
 */
export function getCachedLLMExtractionResult(url, config, maxAgeMs = DEFAULT_TTL_MS) {
    _loadCache();
    const keyHash = _llmCacheKey(url, config);
    const entry = _cache.entries[keyHash];
    if (!entry || entry.type !== 'llm-extraction') return null;

    const age = Date.now() - (entry.cachedAt || 0);
    if (age > maxAgeMs) {
        delete _cache.entries[keyHash];
        const idx = _cache.order.indexOf(keyHash);
        if (idx >= 0) _cache.order.splice(idx, 1);
        _scheduleFlush();
        return null;
    }

    return entry.result;
}

/**
 * Cache a page fetch result (read_url / fetchPage) for a URL.
 * @param {string} url - The URL that was fetched
 * @param {*} result - The fetch result payload (serializable)
 * @param {string} [ttlCategory='static'] - 'static' (7d default) or 'news' (6h)
 */
export function cacheFetchResult(url, result, ttlCategory = 'static') {
    _loadCache();
    const keyHash = _hashString(String(url || '').trim());
    const entry = {
        type: 'fetch',
        url,
        result,
        cachedAt: Date.now(),
        ttlCategory: ttlCategory || 'static',
    };

    const existingIdx = _cache.order.indexOf(keyHash);
    if (existingIdx >= 0) {
        _cache.order.splice(existingIdx, 1);
    }

    _cache.entries[keyHash] = entry;
    _cache.order.unshift(keyHash);

    while (_cache.order.length > DEFAULT_MAX_ENTRIES) {
        const oldest = _cache.order.pop();
        delete _cache.entries[oldest];
    }

    _scheduleFlush();
}

/**
 * Retrieve cached page fetch result for a URL.
 * @param {string} url - The URL that was fetched
 * @param {number} [maxAgeMs] - Max age in ms. If omitted, uses the TTL
 *   category stored at cache time (static=7d, news=6h, default=24h).
 * @returns {*|null} Cached result, or null if not found / expired
 */
export function getCachedFetchResult(url, maxAgeMs) {
    _loadCache();
    const keyHash = _hashString(String(url || '').trim());
    const entry = _cache.entries[keyHash];
    if (!entry || entry.type !== 'fetch') return null;

    // Use caller-supplied TTL, or derive from the category stored at cache time
    let effectiveTtl = maxAgeMs;
    if (effectiveTtl === undefined || effectiveTtl === null) {
        effectiveTtl = getRecommendedTtlForUrl(url, entry.ttlCategory);
    }

    const age = Date.now() - (entry.cachedAt || 0);
    if (age > effectiveTtl) {
        delete _cache.entries[keyHash];
        const idx = _cache.order.indexOf(keyHash);
        if (idx >= 0) _cache.order.splice(idx, 1);
        _scheduleFlush();
        return null;
    }

    return entry.result;
}

/**
 * Get a recommended TTL (in ms) for a URL based on its content category.
 * News-like content gets 6 hours; static/reference content gets 7 days.
 *
 * @param {string} url - The URL to evaluate
 * @param {string} [category='static'] - Explicit category hint from cache
 * @returns {number} TTL in milliseconds
 */
export function getRecommendedTtlForUrl(url, category = 'static') {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

    // Explicit category takes priority
    if (category === 'news') return SIX_HOURS;

    // Heuristic: news-like URL patterns → shorter TTL
    const urlLower = String(url || '').toLowerCase();
    const newsPatterns = [
        /\/20\d{2}\/\d{2}\/\d{2}\//,  // /2025/07/28/
        /\/article\//,
        /\/news\//,
        /\/blog\//,
        /\/story\//,
        /\/post\//,
        /\/updates\//,
    ];
    for (const pattern of newsPatterns) {
        if (pattern.test(urlLower)) return SIX_HOURS;
    }

    return SEVEN_DAYS;
}

/**
 * Get cache statistics for display.
 * @returns {{ entryCount: number, searchCount: number, crawlCount: number, fetchCount: number, llmExtractionCount: number }}
 */
export function getCacheStats() {
    _loadCache();
    let searchCount = 0;
    let crawlCount = 0;
    let fetchCount = 0;
    let llmExtractionCount = 0;
    for (const key of _cache.order) {
        const entry = _cache.entries[key];
        if (!entry) continue;
        if (entry.type === 'search') searchCount++;
        else if (entry.type === 'crawl') crawlCount++;
        else if (entry.type === 'fetch') fetchCount++;
        else if (entry.type === 'llm-extraction') llmExtractionCount++;
    }
    return {
        entryCount: _cache.order.length,
        searchCount,
        crawlCount,
        fetchCount,
        llmExtractionCount,
    };
}

/**
 * Clear all cached entries.
 */
export function clearCache() {
    _loadCache();
    _cache = { entries: {}, order: [] };
    _dirty = true;
    _flushNow();
}

/**
 * Invalidate (remove) a specific cached entry by its lookup key.
 * @param {'search'|'crawl'} type
 * @param {string} key - The query or URL string
 */
export function invalidateCacheEntry(type, key) {
    _loadCache();
    const input = type === 'search'
        ? String(key || '').toLowerCase().trim()
        : String(key || '').trim();
    const keyHash = _hashString(input);
    delete _cache.entries[keyHash];
    const idx = _cache.order.indexOf(keyHash);
    if (idx >= 0) _cache.order.splice(idx, 1);
    _scheduleFlush();
}

// ══════════════════════════════════════════════════════════════════════════════
// Research Checkpoint Persistence
// ══════════════════════════════════════════════════════════════════════════════
//
// Saves the active deep research state to disk so it survives extension
// reloads, shell restarts, or crashes.  Only ONE checkpoint file exists at
// any time — each save overwrites the previous.

const CHECKPOINT_FILE = 'research-checkpoint.json';
const CHECKPOINT_VERSION = 2;  // bump when the checkpoint schema changes; old versions are invalidated (not migrated)
const MAX_CHECKPOINT_FINDINGS_CHARS = 8000;
const MAX_CHECKPOINT_FACTS_PER_BRANCH = 20;
const MAX_CHECKPOINT_FILE_BYTES = 2 * 1024 * 1024;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function _checkpointFilePath() {
    const dataDir = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'katabai']);
    const dir = Gio.File.new_for_path(dataDir);
    if (!dir.query_exists(null)) {
        dir.make_directory_with_parents(null);
    }
    return GLib.build_filenamev([dataDir, CHECKPOINT_FILE]);
}

/**
 * Serialize the current deep research state for crash recovery.
 *
 * The checkpoint is aggressively trimmed so it never exceeds 2 MB.
 * UI-only state (timeline entries, DOM refs) is excluded.
 *
 * @param {Object} state — flat object:
 *   plan, originalQuery, branchResults, refinementResults,
 *   gapRationale, synthesisOutline, citationEntries, urlToNumber,
 *   globalContext, messageHistoryLength, conversationId
 */
export function saveResearchCheckpoint(state) {
    try {
        const trimBranch = (r) => {
            if (!r) return null;
            const findings = String(r.findings || '');
            const trimmed = findings.length > MAX_CHECKPOINT_FINDINGS_CHARS
                ? findings.slice(0, MAX_CHECKPOINT_FINDINGS_CHARS) + '\n[...checkpoint truncated...]'
                : findings;
            const facts = Array.isArray(r.facts)
                ? r.facts.slice(0, MAX_CHECKPOINT_FACTS_PER_BRANCH)
                : [];
            const sources = Array.isArray(r.sources) ? r.sources.slice(0, 50) : [];
            return {
                topic: String(r.topic || ''),
                findings: trimmed,
                facts,
                sources,
                pageCount: typeof r.pageCount === 'number' ? r.pageCount : 0,
            };
        };

        let cleanedContext = null;
        if (state.globalContext) {
            cleanedContext = {
                summaries: (state.globalContext.summaries || []).map(s => ({
                    topic: String(s.topic || ''),
                    gist: String(s.gist || '').slice(0, 500),
                    sourceCount: s.sourceCount || 0,
                })),
                coveredUrls: Array.isArray(state.globalContext.coveredUrls)
                    ? state.globalContext.coveredUrls.slice(0, 200)
                    : [],
                keyFacts: (state.globalContext.keyFacts || []).slice(0, 20),
            };
        }

        let payload = {
            version: CHECKPOINT_VERSION,
            savedAt: Date.now(),
            plan: state.plan || [],
            originalQuery: String(state.originalQuery || ''),
            branchResults: (state.branchResults || []).map(trimBranch).filter(Boolean),
            refinementResults: (state.refinementResults || []).map(trimBranch).filter(Boolean),
            gapRationale: String(state.gapRationale || '').slice(0, 2000),
            synthesisOutline: state.synthesisOutline || null,
            citationEntries: (state.citationEntries || []).slice(0, 200),
            urlToNumber: (state.urlToNumber || []).slice(0, 200),
            globalContext: cleanedContext,
            messageHistoryLength: state.messageHistoryLength || 0,
            conversationId: String(state.conversationId || ''),
        };

        const encoder = new TextEncoder();
        let data = encoder.encode(JSON.stringify(payload));
        if (data.length > MAX_CHECKPOINT_FILE_BYTES) {
            log(`[Katab:checkpoint] Payload ${data.length} bytes exceeds cap — aggressively trimming.`);
            for (const br of (payload.branchResults || [])) {
                const half = Math.floor(br.findings.length / 2);
                br.findings = br.findings.slice(0, half) + '\n[...aggressively trimmed...]';
                br.facts = br.facts.slice(0, Math.floor(MAX_CHECKPOINT_FACTS_PER_BRANCH / 2));
                br.sources = br.sources.slice(0, 25);
            }
            for (const rr of (payload.refinementResults || [])) {
                const half = Math.floor(rr.findings.length / 2);
                rr.findings = rr.findings.slice(0, half) + '\n[...aggressively trimmed...]';
                rr.facts = rr.facts.slice(0, Math.floor(MAX_CHECKPOINT_FACTS_PER_BRANCH / 2));
                rr.sources = rr.sources.slice(0, 25);
            }
            payload.citationEntries = payload.citationEntries.slice(0, 100);
            payload.urlToNumber = payload.urlToNumber.slice(0, 100);
            data = encoder.encode(JSON.stringify(payload));
            log(`[Katab:checkpoint] After aggressive trim: ${data.length} bytes.`);
        }

        const file = Gio.File.new_for_path(_checkpointFilePath());
        file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        log(`[Katab:checkpoint] Checkpoint saved — ${data.length} bytes, ${(payload.branchResults || []).length + (payload.refinementResults || []).length} branches.`);
    } catch (e) {
        log(`[Katab:checkpoint] Failed to write checkpoint: ${e.message}`);
    }
}

/**
 * Load a previously saved research checkpoint (if any and not stale).
 * Returns null if no checkpoint exists, it's >24h old, or parsing fails.
 */
export function loadResearchCheckpoint() {
    try {
        const file = Gio.File.new_for_path(_checkpointFilePath());
        if (!file.query_exists(null)) return null;

        const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const mtimeSec = info.get_modification_date_time()?.to_unix() || 0;
        const age = Date.now() - (mtimeSec * 1000);
        if (age > CHECKPOINT_MAX_AGE_MS) {
            log(`[Katab:checkpoint] Stale checkpoint (${Math.round(age / 3600000)}h old) — deleting.`);
            file.delete(null);
            return null;
        }

        const [ok, contents] = file.load_contents(null);
        if (!ok) return null;

        const decoder = new TextDecoder('utf-8');
        const payload = JSON.parse(decoder.decode(contents));

        if (!payload || payload.version !== CHECKPOINT_VERSION || !Array.isArray(payload.plan)) {
            log(`[Katab:checkpoint] Invalid/outdated checkpoint format (v${payload?.version ?? 'none'}) — deleting.`);
            file.delete(null);
            return null;
        }

        log(`[Katab:checkpoint] Valid checkpoint found — ${payload.plan.length} plan items, ${(payload.branchResults || []).length} branches.`);
        return payload;
    } catch (e) {
        log(`[Katab:checkpoint] Failed to load checkpoint: ${e.message}`);
        return null;
    }
}

/**
 * Remove the checkpoint file.  Call on research completion, cancellation,
 * new chat, or after successfully restoring state from a checkpoint.
 */
export function clearResearchCheckpoint() {
    try {
        const file = Gio.File.new_for_path(_checkpointFilePath());
        if (file.query_exists(null)) {
            file.delete(null);
            log('[Katab:checkpoint] Checkpoint deleted.');
        }
    } catch (e) {
        log(`[Katab:checkpoint] Failed to delete checkpoint: ${e.message}`);
    }
}
