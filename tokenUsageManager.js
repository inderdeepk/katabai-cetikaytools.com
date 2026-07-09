// tokenUsageManager.js — Local-only token usage ledger for Katab AI.
//
// Records one usage event per completed/stopped model response into daily
// aggregate buckets stored at:
//   ~/.local/share/katabai/token-usage.json
//
// Tracking starts the first time this module creates the store — old
// conversations are never backfilled. Nothing here ever leaves the machine.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { isBlockedHost } from './networkGuard.js';

// ── Ranges ───────────────────────────────────────────────────────────────────

export const TOKEN_USAGE_RANGES = [
    { key: 'day', label: 'Today', days: 1, summaryLabel: 'Today' },
    { key: 'week', label: 'Week', days: 7, summaryLabel: 'Past 7 days' },
    { key: 'month', label: 'Month', days: 30, summaryLabel: 'Past 30 days' },
    { key: 'year', label: 'Year', days: 365, summaryLabel: 'Past year' },
    { key: 'all', label: 'All Time', days: null, summaryLabel: 'All time' },
];

const TIMELINE_DAYS = 14;
const MAX_MODEL_ROWS = 6;
const STORE_VERSION = 2;
const RECENT_EVENT_ID_LIMIT = 2000;
const STATUS_KEYS = ['completed', 'stopped', 'tool-call-turn'];

// ── Formatting helpers ───────────────────────────────────────────────────────

export function formatTokenCount(value) {
    const n = Math.max(0, Math.round(Number(value) || 0));
    if (n >= 1_000_000_000) return `${trimTrailingZero((n / 1_000_000_000).toFixed(1))}B`;
    if (n >= 1_000_000) return `${trimTrailingZero((n / 1_000_000).toFixed(1))}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    if (n >= 1_000) return `${trimTrailingZero((n / 1000).toFixed(1))}k`;
    return String(n);
}

function trimTrailingZero(text) { return text.replace(/\.0$/, ''); }

// ── Locality ─────────────────────────────────────────────────────────────────

export function isLocalModelEndpoint(provider, rawUrl) {
    const url = (rawUrl || '').trim();
    if (!url) return provider === 'ollama' || provider === 'unsloth';
    let host = '';
    try { host = (GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() || '').toLowerCase(); }
    catch (_e) { return provider === 'ollama' || provider === 'unsloth'; }
    if (!host) return provider === 'ollama' || provider === 'unsloth';
    if (isBlockedHost(host, false)) return true;
    if (!host.includes('.')) return true;
    return false;
}

// ── Companion (cute desktop pet) ─────────────────────────────────────────────

const COMPANION_STAGES = [
    { minTokens: 50_000_000, key: 'archmage', label: 'Archmage', face: '≧◡≦' },
    { minTokens: 5_000_000, key: 'sage', label: 'Sage', face: '◕‿↼' },
    { minTokens: 500_000, key: 'scholar', label: 'Scholar', face: '◕‿◕' },
    { minTokens: 50_000, key: 'sprout', label: 'Sprout', face: '◠‿◠' },
    { minTokens: 1, key: 'hatchling', label: 'Hatchling', face: 'ᵔᴗᵔ' },
    { minTokens: 0, key: 'egg', label: 'Unhatched Egg', face: '─ ‿ ─' },
];

const COMPANION_STAGE_RANK = Object.fromEntries(
    COMPANION_STAGES.slice().reverse().map((s, i) => [s.key, i])
);

const COMPANION_NAMES = { ollama: 'Ollie', unsloth: 'Slothy', openai: 'Sparky', anthropic: 'Clyde', deepseek: 'Pearl' };

function companionStageForTokens(totalTokens) {
    return COMPANION_STAGES.find(s => totalTokens >= s.minTokens) || COMPANION_STAGES.at(-1);
}

export function buildCompanionState(allSummary, recentSummary = null) {
    const total = allSummary?.totalTokens || 0;
    const stage = companionStageForTokens(total);
    const providers = allSummary?.providers || [];
    const top = providers[0] || null;
    const isBlend = top && top.share < 0.45 && providers.length > 1;

    let name = 'Byte';
    if (total > 0 && top) name = isBlend ? 'Mixie' : (COMPANION_NAMES[top.provider] || 'Byte');

    const localShare = allSummary?.localShare || 0;
    const recentLocalShare = recentSummary?.totalTokens > 0 ? (recentSummary.localShare || 0) : localShare;
    const localTrend = recentSummary?.localShareTrend;
    let mood, flavorText;
    if (total === 0) {
        mood = 'Dreaming of first tokens';
        flavorText = 'Send a message and I will hatch with your very first tracked tokens!';
    } else if (recentLocalShare >= 0.75) {
        mood = 'Homestead Hero';
        flavorText = 'Running mostly on your own hardware — self-hosted and thriving!';
    } else if (recentLocalShare >= 0.4) {
        mood = 'Balanced Buddy';
        flavorText = 'A tasty mix of home cooking and cloud dining. Nicely balanced!';
    } else if (recentLocalShare > 0) {
        mood = localTrend !== null && localTrend > 0.05 ? 'Rooting In' : 'Cloud Curious';
        flavorText = localTrend !== null && localTrend > 0.05
            ? 'Local share is climbing — the little home-lab roots are showing.'
            : 'Mostly cloud-powered. Your local models would love a visit sometime!';
    } else {
        mood = 'Cloud Surfer';
        flavorText = 'Living the full cloud life! Try a local Ollama model and watch me grow roots.';
    }

    return {
        name, stageKey: stage.key, stageLabel: stage.label, face: stage.face,
        mood, flavorText,
        primaryProvider: total > 0 && top ? top.provider : null,
        secondaryProvider: total > 0 && providers[1] ? providers[1].provider : null,
        isBlend: Boolean(isBlend), localShare, recentLocalShare,
        stageRank: COMPANION_STAGE_RANK[stage.key] || 0,
    };
}

export function buildUsageMilestones(allSummary) {
    const total = allSummary?.totalTokens || 0;
    const local = allSummary?.localTokens || 0;
    const activeDays = allSummary?.activeDays || 0;
    const localShare = allSummary?.localShare || 0;
    return [
        { key: 'first-reply', label: 'First reply', achieved: total > 0 },
        { key: 'local-seed', label: 'First local tokens', achieved: local > 0 },
        { key: 'local-10k', label: '10k local', achieved: local >= 10_000 },
        { key: 'mostly-local', label: 'Mostly self-hosted', achieved: total > 0 && localShare >= 0.5 },
        { key: 'seven-days', label: '7 active days', achieved: activeDays >= 7 },
    ];
}

// ── Ledger ───────────────────────────────────────────────────────────────────

export class TokenUsageManager {
    static _cache = null;
    static _dirty = false;
    static _flushSourceId = 0;
    static FLUSH_DELAY_MS = 400;

    static get filePath() { return GLib.build_filenamev([GLib.get_user_data_dir(), 'katabai', 'token-usage.json']); }

    static ensureDir() {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'katabai']));
        try { dir.make_directory_with_parents(null); } catch (_e) {}
    }

    static _freshStore() {
        const now = Math.floor(Date.now() / 1000);
        return { version: STORE_VERSION, trackingStartedAt: now, lastUpdatedAt: now, recentEventIds: [], milestonesCelebrated: [], days: {} };
    }

    static _migrateStore(store) {
        let changed = false;
        if (!Number.isFinite(store.version) || store.version < STORE_VERSION) { store.version = STORE_VERSION; changed = true; }
        if (!Number.isFinite(store.trackingStartedAt)) { store.trackingStartedAt = Math.floor(Date.now() / 1000); changed = true; }
        if (!Number.isFinite(store.lastUpdatedAt)) { store.lastUpdatedAt = store.trackingStartedAt; changed = true; }
        if (!store.days || typeof store.days !== 'object') { store.days = {}; changed = true; }
        if (!Array.isArray(store.recentEventIds)) { store.recentEventIds = []; changed = true; }
        if (!Array.isArray(store.milestonesCelebrated)) { store.milestonesCelebrated = []; changed = true; }
        // Strip any v3 gamification fields that may linger
        if (typeof store.achievements !== 'undefined') { delete store.achievements; changed = true; }
        if (typeof store.conversations !== 'undefined') { delete store.conversations; changed = true; }

        for (const day of Object.values(store.days)) {
            if (!day || typeof day !== 'object') continue;
            if (!day.statuses) { day.statuses = emptyStatusCounts(); changed = true; }
            if (!day.providers || typeof day.providers !== 'object') { day.providers = {}; changed = true; }
            for (const bucket of Object.values(day.providers)) {
                if (!bucket || typeof bucket !== 'object') continue;
                if (!bucket.statuses) { bucket.statuses = emptyStatusCounts(); changed = true; }
                if (!bucket.sources) { bucket.sources = {}; changed = true; }
                if (!bucket.models || typeof bucket.models !== 'object') { bucket.models = {}; changed = true; }
                for (const mb of Object.values(bucket.models)) {
                    if (!mb || typeof mb !== 'object') continue;
                    if (!Number.isFinite(mb.exact)) { mb.exact = (bucket.estimated || 0) > 0 ? 0 : (mb.total || 0); changed = true; }
                    if (!Number.isFinite(mb.estimated)) { mb.estimated = Math.max(0, (mb.total || 0) - (mb.exact || 0)); changed = true; }
                }
            }
        }
        if (changed) this._dirty = true;
        return store;
    }

    static _readFromDisk() {
        try {
            const file = Gio.File.new_for_path(this.filePath);
            const [, bytes] = file.load_contents(null);
            const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
            if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
                this._cache = this._migrateStore(parsed);
            } else { this._cache = this._freshStore(); this._dirty = true; }
        } catch (_e) { this._cache = this._freshStore(); this._dirty = true; }
        return this._cache;
    }

    static load() { if (this._cache === null) this._readFromDisk(); return this._cache; }

    static _scheduleFlush() {
        this._dirty = true;
        if (this._flushSourceId) return;
        this._flushSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.FLUSH_DELAY_MS, () => {
            this._flushSourceId = 0; this._flushNow(); return GLib.SOURCE_REMOVE;
        });
    }

    static _flushNow() {
        if (!this._dirty || this._cache === null) return;
        this._dirty = false;
        try {
            this.ensureDir();
            const file = Gio.File.new_for_path(this.filePath);
            const data = new TextEncoder().encode(JSON.stringify(this._cache, null, 2));
            file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) { log(`Katab: failed to save token usage: ${e.message}`); }
    }

    static flushSync() { if (this._flushSourceId) { GLib.source_remove(this._flushSourceId); this._flushSourceId = 0; } this._flushNow(); }
    static invalidateCache() { this._cache = null; }

    static reset() { this._cache = this._freshStore(); this._dirty = true; this.flushSync(); }

    static exportCopy() {
        this.load(); this._dirty = true; this.flushSync();
        const source = Gio.File.new_for_path(this.filePath);
        const [, bytes] = source.load_contents(null);
        const documentsDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) || GLib.get_home_dir();
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        const targetPath = GLib.build_filenamev([documentsDir, `katabai-token-usage-${stamp}.json`]);
        Gio.File.new_for_path(targetPath).replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return targetPath;
    }

    static prune(retentionDays) {
        const days = Math.round(Number(retentionDays) || 0);
        if (days <= 0) return 0;
        const store = this.load();
        const cutoffKey = GLib.DateTime.new_now_local().add_days(-(days - 1)).format('%Y-%m-%d');
        let removed = 0;
        for (const dayKey of Object.keys(store.days)) { if (dayKey < cutoffKey) { delete store.days[dayKey]; removed++; } }
        if (removed > 0) { store.lastUpdatedAt = Math.floor(Date.now() / 1000); this._scheduleFlush(); }
        return removed;
    }

    static recordUsageEvent(event) {
        const provider = String(event?.provider || '').trim();
        if (!provider) return;

        const prompt = clampCount(event.promptTokens);
        const completion = clampCount(event.completionTokens);
        const reasoning = clampCount(event.reasoningTokens);
        const cachedHit = clampCount(event.cachedHitTokens);
        const total = prompt + completion;
        if (total <= 0) return;

        const store = this.load();
        const eventId = String(event.eventId || '').trim();
        if (eventId && store.recentEventIds.includes(eventId)) return { recorded: false, duplicate: true };

        const beforeStage = companionStageForTokens(storeTotal(store));
        const dayKey = GLib.DateTime.new_now_local().format('%Y-%m-%d');

        if (!store.days[dayKey]) store.days[dayKey] = { total: 0, statuses: emptyStatusCounts(), providers: {} };
        const day = store.days[dayKey];
        if (!day.statuses) day.statuses = emptyStatusCounts();

        if (!day.providers[provider]) {
            day.providers[provider] = {
                prompt: 0, completion: 0, reasoning: 0, cachedHit: 0,
                total: 0, exact: 0, estimated: 0, local: 0, remote: 0,
                events: 0, statuses: emptyStatusCounts(), sources: {}, models: {},
            };
        }
        const bucket = day.providers[provider];
        if (!bucket.statuses) bucket.statuses = emptyStatusCounts();
        if (!bucket.sources) bucket.sources = {};

        const status = normalizeStatus(event.status);
        const source = String(event.source || (event.exact ? 'exact' : 'estimate')).trim() || 'unknown';

        bucket.prompt += prompt; bucket.completion += completion;
        bucket.reasoning += reasoning; bucket.cachedHit += cachedHit;
        bucket.total += total; bucket.events += 1;
        if (event.exact) { bucket.exact += total; } else { bucket.estimated += total; }
        if (event.local) { bucket.local += total; } else { bucket.remote += total; }

        const model = String(event.model || '').trim();
        if (model) {
            if (!bucket.models[model]) bucket.models[model] = { total: 0, events: 0, exact: 0, estimated: 0 };
            bucket.models[model].total += total; bucket.models[model].events += 1;
            if (event.exact) { bucket.models[model].exact += total; } else { bucket.models[model].estimated += total; }
        }

        day.total += total;
        day.statuses[status] = (day.statuses[status] || 0) + 1;
        bucket.statuses[status] = (bucket.statuses[status] || 0) + 1;
        bucket.sources[source] = (bucket.sources[source] || 0) + 1;
        if (eventId) {
            store.recentEventIds.push(eventId);
            if (store.recentEventIds.length > RECENT_EVENT_ID_LIMIT)
                store.recentEventIds.splice(0, store.recentEventIds.length - RECENT_EVENT_ID_LIMIT);
        }

        const afterTotal = storeTotal(store);
        const afterStage = companionStageForTokens(afterTotal);
        let celebration = null;
        if (afterStage.key !== beforeStage.key && !store.milestonesCelebrated.includes(afterStage.key)) {
            store.milestonesCelebrated.push(afterStage.key);
            celebration = { stageKey: afterStage.key, stageLabel: afterStage.label, face: afterStage.face, totalTokens: afterTotal };
        }
        store.lastUpdatedAt = Math.floor(Date.now() / 1000);
        this._scheduleFlush();
        return { recorded: true, celebration };
    }

    static getSummary(rangeKey = 'all') {
        const store = this.load();
        const range = TOKEN_USAGE_RANGES.find(r => r.key === rangeKey) || TOKEN_USAGE_RANGES.at(-1);
        let cutoffKey = null;
        if (range.days) cutoffKey = GLib.DateTime.new_now_local().add_days(-(range.days - 1)).format('%Y-%m-%d');

        const summary = {
            rangeKey: range.key, label: range.summaryLabel,
            totalTokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedHitTokens: 0,
            exactTokens: 0, estimatedTokens: 0, localTokens: 0, remoteTokens: 0,
            events: 0, statuses: emptyStatusCounts(), activeDays: 0,
            providers: [], models: [], timeline: [],
            mostActiveDay: null, trackingStartedAt: store.trackingStartedAt,
            exactShare: 0, localShare: 0,
            previousTotalTokens: 0, tokenTrend: null, previousLocalShare: 0, localShareTrend: null,
            todayTokens: 0, dailyAverageTokens: 0, todayVsAverage: null,
            localStreakDays: 0, milestones: [],
        };

        const providerAgg = {}, modelAgg = {};

        for (const [dayKey, day] of Object.entries(store.days)) {
            if (cutoffKey && dayKey < cutoffKey) continue;
            if ((day.total || 0) > 0) {
                summary.activeDays++;
                if (!summary.mostActiveDay || (day.total || 0) > summary.mostActiveDay.total)
                    summary.mostActiveDay = { dayKey, total: day.total || 0 };
            }
            for (const s of STATUS_KEYS) summary.statuses[s] += day.statuses?.[s] || 0;
            for (const [provider, bucket] of Object.entries(day.providers || {})) {
                summary.totalTokens += bucket.total || 0;
                summary.promptTokens += bucket.prompt || 0;
                summary.completionTokens += bucket.completion || 0;
                summary.reasoningTokens += bucket.reasoning || 0;
                summary.cachedHitTokens += bucket.cachedHit || 0;
                summary.exactTokens += bucket.exact || 0;
                summary.estimatedTokens += bucket.estimated || 0;
                summary.localTokens += bucket.local || 0;
                summary.remoteTokens += bucket.remote || 0;
                summary.events += bucket.events || 0;

                if (!providerAgg[provider]) providerAgg[provider] = { provider, total: 0, events: 0, localTokens: 0, exact: 0, estimated: 0 };
                providerAgg[provider].total += bucket.total || 0;
                providerAgg[provider].events += bucket.events || 0;
                providerAgg[provider].localTokens += bucket.local || 0;
                providerAgg[provider].exact += bucket.exact || 0;
                providerAgg[provider].estimated += bucket.estimated || 0;

                for (const [model, m] of Object.entries(bucket.models || {})) {
                    const mk = `${provider}\u0000${model}`;
                    if (!modelAgg[mk]) modelAgg[mk] = { provider, model, total: 0, events: 0, exact: 0, estimated: 0 };
                    modelAgg[mk].total += m.total || 0;
                    modelAgg[mk].events += m.events || 0;
                    modelAgg[mk].exact += m.exact || 0;
                    modelAgg[mk].estimated += m.estimated || 0;
                }
            }
        }

        if (summary.totalTokens > 0) {
            summary.exactShare = summary.exactTokens / summary.totalTokens;
            summary.localShare = summary.localTokens / summary.totalTokens;
        }

        summary.providers = Object.values(providerAgg).sort((a, b) => b.total - a.total)
            .map(e => ({ ...e, share: summary.totalTokens > 0 ? e.total / summary.totalTokens : 0 }));
        summary.models = Object.values(modelAgg).sort((a, b) => b.total - a.total).slice(0, MAX_MODEL_ROWS)
            .map(e => ({ ...e, share: summary.totalTokens > 0 ? e.total / summary.totalTokens : 0 }));

        const now = GLib.DateTime.new_now_local();
        const todayKey = now.format('%Y-%m-%d');
        summary.todayTokens = store.days[todayKey]?.total || 0;
        summary.dailyAverageTokens = summary.activeDays > 0 ? Math.round(summary.totalTokens / summary.activeDays) : 0;
        summary.todayVsAverage = summary.dailyAverageTokens > 0
            ? (summary.todayTokens - summary.dailyAverageTokens) / summary.dailyAverageTokens : null;
        summary.localStreakDays = this._computeLocalStreak(store);

        if (range.days) {
            const prevStart = now.add_days(-(range.days * 2 - 1)).format('%Y-%m-%d');
            const prevEnd = now.add_days(-range.days).format('%Y-%m-%d');
            const prev = aggregateRange(store, prevStart, prevEnd);
            summary.previousTotalTokens = prev.total;
            summary.tokenTrend = prev.total > 0 ? (summary.totalTokens - prev.total) / prev.total : null;
            summary.previousLocalShare = prev.total > 0 ? prev.local / prev.total : 0;
            summary.localShareTrend = prev.total > 0 ? summary.localShare - summary.previousLocalShare : null;
        }

        summary.milestones = buildUsageMilestones(buildAllMilestoneSummary(store));

        for (let i = TIMELINE_DAYS - 1; i >= 0; i--) {
            const dt = now.add_days(-i);
            const dk = dt.format('%Y-%m-%d');
            summary.timeline.push({ dayKey: dk, weekday: dt.format('%a'), total: store.days[dk]?.total || 0 });
        }
        return summary;
    }

    static getSnapshot(defaultRangeKey = 'month') {
        const allSummary = this.getSummary('all');
        let summary = this.getSummary(defaultRangeKey);
        if (summary.totalTokens === 0 && defaultRangeKey !== 'all') summary = allSummary;
        return { summary, allSummary, companion: buildCompanionState(allSummary, summary), topProvider: summary.providers[0] || null };
    }

    static _computeLocalStreak(store) {
        const now = GLib.DateTime.new_now_local();
        let streak = 0;
        for (let o = 0; o < 3660; o++) {
            const key = now.add_days(-o).format('%Y-%m-%d');
            const day = store.days[key];
            if (!day) break;
            let local = 0;
            for (const b of Object.values(day.providers || {})) local += b.local || 0;
            if (local <= 0) break;
            streak++;
        }
        return streak;
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function clampCount(v) { const n = Math.round(Number(v) || 0); return n > 0 ? n : 0; }
function emptyStatusCounts() { return Object.fromEntries(STATUS_KEYS.map(k => [k, 0])); }

function normalizeStatus(s) { const v = String(s || '').trim(); return STATUS_KEYS.includes(v) ? v : 'completed'; }

function storeTotal(store) { let t = 0; for (const d of Object.values(store.days || {})) t += d?.total || 0; return t; }

function aggregateRange(store, start, end) {
    const agg = { total: 0, local: 0 };
    for (const [dk, d] of Object.entries(store.days || {})) {
        if (dk < start || dk > end) continue;
        agg.total += d.total || 0;
        for (const b of Object.values(d.providers || {})) agg.local += b.local || 0;
    }
    return agg;
}

function buildAllMilestoneSummary(store) {
    const s = { totalTokens: 0, localTokens: 0, activeDays: 0, localShare: 0 };
    for (const d of Object.values(store.days || {})) {
        if ((d?.total || 0) > 0) s.activeDays++;
        s.totalTokens += d?.total || 0;
        for (const b of Object.values(d?.providers || {})) s.localTokens += b.local || 0;
    }
    s.localShare = s.totalTokens > 0 ? s.localTokens / s.totalTokens : 0;
    return s;
}
