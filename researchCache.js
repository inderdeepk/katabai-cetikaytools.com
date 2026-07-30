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

function _cacheFilePath() {
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
 * @returns {{ entryCount: number, searchCount: number, crawlCount: number, fetchCount: number }}
 */
export function getCacheStats() {
    _loadCache();
    let searchCount = 0;
    let crawlCount = 0;
    let fetchCount = 0;
    for (const key of _cache.order) {
        const entry = _cache.entries[key];
        if (!entry) continue;
        if (entry.type === 'search') searchCount++;
        else if (entry.type === 'crawl') crawlCount++;
        else if (entry.type === 'fetch') fetchCount++;
    }
    return {
        entryCount: _cache.order.length,
        searchCount,
        crawlCount,
        fetchCount,
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
