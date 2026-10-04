// branchRunner.js — Research branch execution (search → crawl → compress).
//
// Extracted from extension.js: the single-branch executor, the sequential
// branch orchestrator (retry/backoff, cross-branch context sharing,
// mid-research critique integration, checkpointing), and the lightweight
// refinement mini-branches. Everything side-effecting — runtimes, timeline
// UI, config readers, checkpoint store — is injected through the host bag
// (see KatabDialog._researchBranchHost()).
//
// Host bag surface:
//   {
//     webSearch(query, webSearchConfig, cancellable) -> Promise<{results:Array}>
//     crawl(url, crawl4aiConfig, cancellable)         -> Promise<[crawlResult]>
//     requestCompletion(messages, opts),   // non-streaming LLM call
//     modelOverride,                       // compression-role model override
//     getCancellable(),                    // read per call
//     isCancelled(error),                  // true when a thrown error is a user cancel
//     isTransient(error),                  // true when a branch error should be retried
//     sleep(ms),                           // promise delay for retry backoff
//     getConfig(),                         // { webSearchConfig, crawl4aiConfig }
//     getOriginalQuery(),
//     getCitationTracker(),                // may be null
//     getGlobalContext(), setGlobalContext(ctx), // cross-branch context object
//     getActivePlanLength(),               // refinement row indices
//     getPipelineHost(),                   // host bag for runRePlanningCritique
//     updateProgress(branchIndex, status, detail),
//     addTimelineEntry(phase, iconName, title, desc),
//     addSearchResultCards(entryRef, results),
//     addPageReadProgress(entryRef, url, status, detail),
//     formatBytes(length),
//     extendProgressCardForRefinement(gapQueries),
//     saveCheckpoint(label),
//   }
import { getCrawlResultText } from '../tools/crawl4aiTools.js';
import { compressResearchBranch } from './compressionTools.js';
import { registerFacts, registerSource } from './citationTracker.js';
import { runRePlanningCritique } from './pipeline.js';

// ── Progress states for research plan sub-tasks ─────────────────────────────
// (Moved here from extension.js; the timeline UI imports them back for
// rendering and these constants are what the host callbacks report.)
export const RESEARCH_PROGRESS_PENDING = 'pending';
export const RESEARCH_PROGRESS_SEARCHING = 'searching';
export const RESEARCH_PROGRESS_SCRAPING = 'scraping';
export const RESEARCH_PROGRESS_COMPRESSING = 'compressing';
export const RESEARCH_PROGRESS_DONE = 'done';
export const RESEARCH_PROGRESS_ERROR = 'error';
export const RESEARCH_PROGRESS_ANALYZING = 'analyzing'; // Gap analysis phase
export const RESEARCH_PROGRESS_REFINING = 'refining'; // Refinement research phase
export const RESEARCH_PROGRESS_OUTLINING = 'outlining'; // Synthesis outline phase
export const RESEARCH_PROGRESS_WRITING = 'writing'; // Final report phase

// ── Branch-level error recovery ──────────────────────────────────────────────
// When a research branch fails (search timeout, crawl error, engine down),
// we retry transient errors with exponential backoff but skip permanent
// errors (bad host, SSRF block, not found).  This matches the research
// report's recommendation: "if a web worker fails during step fifteen of
// a thirty-step research loop, the task manager recovers gracefully."
export const RESEARCH_BRANCH_MAX_RETRIES = 2;
export const RESEARCH_BRANCH_BACKOFF_MS = [2000, 5000]; // Exponential backoff per retry attempt

// ── Refinement research ──────────────────────────────────────────────────────
export const REFINEMENT_CRAWL_COUNT = 2; // Fewer than branch crawl (3) — refinement is fast

// ── Mid-research self-critique ───────────────────────────────────────────────
// After every N branches, the system pauses to evaluate accumulated findings
// against the original question.  If coverage gaps are detected, remaining
// search angles can be adjusted before execution continues.
export const MID_RESEARCH_CRITIQUE_INTERVAL = 2;
export const MAX_CRITIQUE_SPAWNED_BRANCHES = 2; // new angles spawned per critique
export const MAX_TOTAL_SPAWNED_BRANCHES = 3; // total new angles per research run

/**
 * Build the standardized service-down error used by the research pipeline
 * so every abort site surfaces the same clear, actionable message.
 * @param {Error|string|null} cause - The underlying connection failure
 * @returns {Error} Error with code 'research-service-down'
 */
export function serviceDownError(cause) {
    const detail = cause?.message || String(cause || 'Connection failed.');
    const err = new Error(
        `Deep research stopped: the web search / scraping service is unreachable.\n\n` +
            `${detail}\n\n` +
            `Start your SearxNG (web search) and Crawl4AI (web scraper) services, then run research again.`,
    );
    err.code = 'research-service-down';
    return err;
}

/**
 * Execute a single research branch: search → crawl top pages → compress each → merge.
 * Each branch handles one sub-task from the research plan.
 * @param {Object} host see module header
 * @param {Object} subTask - { sub_task, search_query, index }
 * @param {Object} config - { webSearchConfig, crawl4aiConfig }
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<{topic: string, findings: string, facts: Array, sources: string[], pageCount: number}>}
 */
export async function executeResearchBranch(host, subTask, config, cancellable) {
    const {
        webSearch,
        crawl,
        requestCompletion,
        modelOverride = undefined,
        isCancelled = () => false,
        isTransient = () => false,
        getCitationTracker = () => null,
        getGlobalContext = () => null,
        getOriginalQuery = () => '',
        updateProgress = () => {},
        addSearchResultCards = () => {},
        addPageReadProgress = () => {},
        formatBytes = () => '',
    } = host;

    const { sub_task, search_query, index } = subTask;

    // Update progress: searching
    updateProgress(index, RESEARCH_PROGRESS_SEARCHING, `Searching...`);

    // Step 1: Search
    let searchResults;
    try {
        const result = await webSearch(search_query, config.webSearchConfig, cancellable);
        searchResults = result?.results || [];
    } catch (e) {
        if (isCancelled(e)) throw e;
        // Re-throw transient errors so the retry loop in runResearchBranches can act
        if (isTransient(e)) {
            log(
                `[Katab:research] Branch "${sub_task}" search transient error — re-throwing for retry: ${e.message}`,
            );
            throw e;
        }
        log(`[Katab:research] Branch "${sub_task}" search failed: ${e.message}`);
        updateProgress(index, RESEARCH_PROGRESS_ERROR, 'Search failed');
        return { topic: sub_task, findings: '', facts: [], sources: [], pageCount: 0 };
    }

    if (!searchResults.length) {
        log(`[Katab:research] Branch "${sub_task}" — no search results`);
        updateProgress(index, RESEARCH_PROGRESS_DONE, 'No results found');
        return { topic: sub_task, findings: '', facts: [], sources: [], pageCount: 0 };
    }

    // ── Show search results as inline cards (new timeline UI) ────────
    const entryRef = subTask._timelineEntry;
    if (entryRef) {
        addSearchResultCards(entryRef, searchResults);
    }

    // Step 2: Crawl top results (up to 3), PREFERRING URLs not already
    // covered by earlier branches. `_globalResearchContext.coveredUrls`
    // holds normalized URLs from completed branches — filtering them out
    // makes the documented cross-branch redundancy avoidance real instead
    // of dead wiring, so later branches spend crawl budget on NEW sources.
    const coveredUrls = getGlobalContext()?.coveredUrls;
    let topUrls = searchResults.map((r) => r.url).filter(Boolean);
    if (coveredUrls && coveredUrls.size > 0) {
        const novel = topUrls.filter(
            (u) => !coveredUrls.has(String(u).trim().replace(/\/+$/, '').toLowerCase()),
        );
        if (novel.length > 0) topUrls = novel;
    }
    topUrls = topUrls.slice(0, 3);
    // Inject the branch search query so BM25 filtering can score relevance
    config.crawl4aiConfig.query = search_query;
    updateProgress(index, RESEARCH_PROGRESS_SCRAPING, `Scraping ${topUrls.length} pages...`);

    const pages = [];
    for (const url of topUrls) {
        // Show page read progress
        if (entryRef) {
            addPageReadProgress(entryRef, url, 'reading');
        }

        try {
            const crawlResults = await crawl(url, config.crawl4aiConfig, cancellable);
            const result = crawlResults?.[0];
            // LLM extraction results carry their content in structuredJson /
            // llmResponse with an empty fitMarkdown — read the best available text.
            const text = result ? getCrawlResultText(result) : '';
            if (result?.success && text) {
                pages.push({ url, text });
                // Update page read status
                if (entryRef) {
                    const sizeStr = formatBytes(text.length);
                    addPageReadProgress(entryRef, url, 'success', sizeStr);
                }
            } else {
                if (entryRef) {
                    addPageReadProgress(entryRef, url, 'error', 'No content extracted');
                }
            }
        } catch (e) {
            if (isCancelled(e)) throw e;
            // Re-throw transient crawl errors so the retry loop can act
            if (isTransient(e)) {
                log(
                    `[Katab:research] Branch "${sub_task}" crawl transient error for ${url} — re-throwing: ${e.message}`,
                );
                throw e;
            }
            log(`[Katab:research] Branch "${sub_task}" — crawl failed for ${url}: ${e.message}`);
            if (entryRef) {
                addPageReadProgress(
                    entryRef,
                    url,
                    'error',
                    String(e.message || 'Failed').slice(0, 40),
                );
            }
        }
    }

    if (!pages.length) {
        // No pages crawled — return search snippets as fallback
        const snippetText = searchResults
            .slice(0, 5)
            .map((r) => `- **${r.title}**\n  ${r.snippet}\n  [source](${r.url})`)
            .join('\n\n');
        updateProgress(index, RESEARCH_PROGRESS_DONE, `${searchResults.length} results (snippets)`);

        // Register sources in citation tracker
        const tracker = getCitationTracker();
        if (tracker) {
            for (const r of searchResults) {
                registerSource(tracker, r.url, r.title);
            }
        }

        return {
            topic: sub_task,
            findings: `Search results for "${search_query}":\n\n${snippetText}`,
            facts: [],
            sources: searchResults.map((r) => r.url),
            pageCount: 0,
        };
    }

    // Step 3: Compress (if compression module available)
    updateProgress(index, RESEARCH_PROGRESS_COMPRESSING, `Compressing ${pages.length} pages...`);

    // Build an llmCall wrapper for compression tools
    const llmCall = async (messages, opts = {}) => {
        return await requestCompletion(messages, {
            cancellable: opts.cancellable || cancellable,
            maxTokens: opts.maxTokens || 1024,
            modelOverride,
        });
    };

    let findings;
    let facts = [];
    const sources = pages.map((p) => p.url);

    try {
        const compressed = await compressResearchBranch({
            pages,
            topic: sub_task,
            llmCall,
            cancellable,
            researchContext: {
                originalQuery: getOriginalQuery(),
                subTask: sub_task,
            },
        });
        facts = compressed.facts;
        findings = compressed.findings || '';

        // Register facts in citation tracker
        const tracker = getCitationTracker();
        if (tracker && facts.length > 0) {
            registerFacts(tracker, facts);
        }
    } catch (e) {
        log(`[Katab:research] Branch "${sub_task}" compression failed: ${e.message}`);
        // Fallback: raw page summaries
        findings = pages
            .map((p) => `### Page: ${p.url}\n${p.text.slice(0, 3000)}...`)
            .join('\n\n---\n\n');
    }

    updateProgress(index, RESEARCH_PROGRESS_DONE, `${pages.length} pages, ${facts.length} facts`);
    return { topic: sub_task, findings, facts, sources, pageCount: pages.length };
}

/**
 * Run all research branches SEQUENTIALLY to avoid overwhelming
 * SearXNG and Crawl4AI with simultaneous requests.  Parallel execution
 * causes rate-limit errors across all upstream engines.
 *
 * Now implements cross-branch context sharing: after each branch completes,
 * a condensed summary is pushed to `_globalResearchContext`.  Subsequent
 * branches receive context awareness so they can avoid re-discovering
 * already-covered ground and focus on their unique angle.
 *
 * @param {Object} host see module header
 * @param {Array} plan - Research plan with sub-tasks
 * @returns {Promise<Array>} Array of branch results
 */
export async function runResearchBranches(host, plan) {
    const {
        getConfig,
        getGlobalContext = () => null,
        setGlobalContext = () => {},
        getCancellable = () => null,
        isCancelled = () => false,
        isTransient = () => false,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        getPipelineHost = () => ({}),
        getOriginalQuery = () => '',
        updateProgress = () => {},
        addTimelineEntry = () => null,
        saveCheckpoint = () => {},
    } = host;

    const { webSearchConfig, crawl4aiConfig } = getConfig();

    // Initialize cross-branch context sharing. When resuming from a checkpoint
    // the context was restored in _beginResearchExecution — PRESERVE it so
    // remaining branches still know what earlier branches covered (otherwise
    // they re-crawl redundant URLs). Only create fresh state when none exists.
    let globalContext = getGlobalContext();
    if (!globalContext || !Array.isArray(globalContext.summaries)) {
        globalContext = {
            summaries: [],
            coveredUrls: new Set(),
            keyFacts: [],
        };
        setGlobalContext(globalContext);
    }
    if (!(globalContext.coveredUrls instanceof Set)) {
        globalContext.coveredUrls = new Set(globalContext.coveredUrls || []);
    }
    if (!Array.isArray(globalContext.keyFacts)) {
        globalContext.keyFacts = [];
    }

    log(
        `[Katab:research] Starting ${plan.length} research branches sequentially (rate-limit friendly)...`,
    );

    // Entries are created progressively — one at a time as each branch starts.
    // No pre-creation loop here.  See the creation inside the execution loop below.

    const results = [];
    const droppedSet = new Set(); // indices dropped by the re-planning critique
    let spawnedTotal = 0; // total branches spawned across all critiques
    // Set when the search/scrape backend is unreachable (connection failure).
    // Once set, the whole research run aborts instead of grinding every
    // remaining branch through per-branch retries.
    let serviceDown = false;
    for (let i = 0; i < plan.length; i++) {
        const task = plan[i];

        // Skip branches the mid-research critique dropped as redundant/low-value.
        if (droppedSet.has(i)) {
            results.push({
                topic: task?.sub_task || '',
                findings: '',
                facts: [],
                sources: [],
                pageCount: 0,
            });
            continue;
        }

        // ── Cross-branch awareness for branches 2+ ──────────────────
        // Later branches benefit from prior work through the covered-URL
        // filter in executeResearchBranch (already-crawled URLs are skipped
        // so crawl budget goes to NEW sources). A legacy `_contextAware`
        // note was once built here but never consumed — removed so the code
        // reflects the real mechanism.
        if (i > 0 && globalContext.summaries.length > 0) {
            log(
                `[Katab:research] Branch ${i + 1} received cross-branch context from ${globalContext.summaries.length} prior branches`,
            );
        }

        // ── Create timeline entry on-demand (progressive disclosure) ──
        if (!task._timelineEntry) {
            const entryRef = addTimelineEntry(
                RESEARCH_PROGRESS_SEARCHING,
                'system-search-symbolic',
                `Angle ${i + 1}: ${task.sub_task}`,
                `Query: "${task.search_query}"`,
            );
            if (entryRef) {
                task._timelineEntry = entryRef;
            }
        }

        updateProgress(i, RESEARCH_PROGRESS_SEARCHING, `Branch ${i + 1}/${plan.length}...`);

        // ── Retry loop for transient branch failures ────────────────
        let result = null;
        let branchError = null;
        for (let attempt = 0; attempt <= RESEARCH_BRANCH_MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = RESEARCH_BRANCH_BACKOFF_MS[attempt - 1] || 5000;
                log(
                    `[Katab:research] Branch "${task.sub_task}" retry ${attempt}/${RESEARCH_BRANCH_MAX_RETRIES} after ${delay}ms...`,
                );
                updateProgress(
                    i,
                    RESEARCH_PROGRESS_SEARCHING,
                    `Retry ${attempt}/${RESEARCH_BRANCH_MAX_RETRIES}...`,
                );
                await sleep(delay);
            }

            try {
                branchError = null;
                result = await executeResearchBranch(
                    host,
                    { ...task, index: i },
                    { webSearchConfig, crawl4aiConfig },
                    getCancellable(),
                );
                break; // Success — exit retry loop
            } catch (e) {
                if (isCancelled(e)) throw e;
                branchError = e;
                // The search/scrape backend is unreachable (connection
                // failure). This is a service-down condition, not a
                // transient blip — abort the whole run rather than retry a
                // dead service on this and every remaining branch.
                if (e.code === 'connection-failed' || e.code === 'network-error') {
                    serviceDown = true;
                    log(
                        `[Katab:research] Research service unreachable (branch "${task.sub_task}"): ${e.message}`,
                    );
                    break;
                }
                if (!isTransient(e)) {
                    log(
                        `[Katab:research] Branch "${task.sub_task}" failed with non-transient error — skipping.`,
                    );
                    break; // Permanent error — skip this branch
                }
                // Transient error — will retry on next loop iteration
                log(
                    `[Katab:research] Branch "${task.sub_task}" transient error (attempt ${attempt + 1}): ${e.message}`,
                );
            }
        }

        // Service unreachable: abort the entire research run with a clear
        // error instead of silently grinding through the remaining branches.
        if (serviceDown) {
            // Mark this and all remaining branches failed in the UI so the
            // error is visible immediately (not after the run ends).
            for (let j = i; j < plan.length; j++) {
                updateProgress(j, RESEARCH_PROGRESS_ERROR, 'Aborted — service unreachable');
            }
            // _abortResearchForServiceDown clears any checkpoint, so we
            // don't persist one for an aborted run.
            throw serviceDownError(branchError);
        }

        if (branchError && !result) {
            log(
                `[Katab:research] Branch "${task.sub_task}" failed after retries: ${branchError.message}`,
            );
            updateProgress(i, RESEARCH_PROGRESS_ERROR, 'Failed');
            results.push({
                topic: task.sub_task,
                findings: '',
                facts: [],
                sources: [],
                pageCount: 0,
            });
            // Still save checkpoint so progress on completed branches is preserved
            saveCheckpoint(`branch ${i + 1}/${plan.length} (failed)`);
            continue;
        }

        results.push(result);

        // ── Push completed branch summary to global context ─────────
        if (result.findings && result.findings.length > 50) {
            const gist =
                result.findings.length > 300
                    ? result.findings.slice(0, 300).replace(/\n/g, ' ') + '...'
                    : result.findings.replace(/\n/g, ' ');
            globalContext.summaries.push({
                topic: result.topic,
                gist,
                sourceCount: result.sources?.length || 0,
            });
            // Track covered URLs to help later branches avoid redundancy
            if (result.sources) {
                for (const url of result.sources) {
                    globalContext.coveredUrls.add(
                        String(url).trim().replace(/\/+$/, '').toLowerCase(),
                    );
                }
            }
            if (result.facts?.length) {
                globalContext.keyFacts.push(...result.facts.slice(0, 5));
            }
        }

        // Save checkpoint after each branch completes
        saveCheckpoint(`branch ${i + 1}/${plan.length}`);

        // ── Mid-research re-planning critique — every N branches ────
        if ((i + 1) % MID_RESEARCH_CRITIQUE_INTERVAL === 0 && i + 1 < plan.length) {
            const remaining = plan.slice(i + 1);
            const critique = await runRePlanningCritique(
                getPipelineHost(),
                results,
                remaining,
                getOriginalQuery(),
            );
            if (critique.sufficient) {
                log(
                    `[Katab:critique] Findings sufficient after ${i + 1} branches — skipping remaining ${remaining.length}.`,
                );
                // Mark remaining branches as skipped
                for (let j = i + 1; j < plan.length; j++) {
                    updateProgress(j, RESEARCH_PROGRESS_DONE, 'Skipped (sufficient)');
                }
                break; // Exit the branch loop early
            }

            // Apply targeted search query adjustments to remaining angles.
            if (critique.adjustments && critique.adjustments.length > 0) {
                for (const adj of critique.adjustments) {
                    if (adj.index >= 0 && adj.index < remaining.length) {
                        const target = remaining[adj.index];
                        if (target && adj.new_query) {
                            log(
                                `[Katab:critique] Adjusted angle "${target.sub_task}" query → "${adj.new_query}" (${adj.rationale})`,
                            );
                            target.search_query = adj.new_query;
                        }
                    }
                }
            }

            // Drop remaining angles the critic judged redundant / low-value.
            if (critique.drop_indices && critique.drop_indices.length > 0) {
                for (const relIdx of critique.drop_indices) {
                    const absIdx = i + 1 + relIdx;
                    if (absIdx < plan.length) {
                        droppedSet.add(absIdx);
                        log(
                            `[Katab:critique] Dropping remaining angle "${plan[absIdx]?.sub_task}" (redundant/low-value).`,
                        );
                        updateProgress(absIdx, RESEARCH_PROGRESS_DONE, 'Skipped (redundant)');
                    }
                }
            }

            // Spawn NEW angles from discovered sub-topics (bounded).
            if (critique.new_branches && critique.new_branches.length > 0) {
                const remainingBudget = MAX_TOTAL_SPAWNED_BRANCHES - spawnedTotal;
                const toSpawn = critique.new_branches.slice(
                    0,
                    Math.min(MAX_CRITIQUE_SPAWNED_BRANCHES, remainingBudget),
                );
                for (const nb of toSpawn) {
                    plan.push({
                        sub_task: String(nb.sub_task || 'New angle').slice(0, 80),
                        search_query: String(nb.search_query),
                        _timelineEntry: null,
                    });
                    spawnedTotal++;
                    log(
                        `[Katab:critique] Spawned new branch "${nb.sub_task}" (query: "${nb.search_query}")`,
                    );
                }
            }
        }
    }

    const totalPages = results.reduce((sum, r) => sum + (r.pageCount || 0), 0);
    const totalFacts = results.reduce((sum, r) => sum + (r.facts?.length || 0), 0);
    log(
        `[Katab:research] All branches complete — ${totalPages} pages scraped, ${totalFacts} facts extracted across ${results.length} branches.`,
    );

    return results;
}

/**
 * Execute the gap-addressing queries as lightweight mini-branches.
 * Each query gets: search → crawl top 2 results → compress.
 * Fewer crawls than the main branch phase (2 vs 3) to keep refinement fast.
 *
 * @param {Object} host see module header
 * @param {Array} gapQueries - [{rationale, search_query}]
 * @returns {Promise<Array<{topic: string, findings: string, facts: Array, sources: string[], pageCount: number}>>}
 */
export async function runRefinementResearch(host, gapQueries) {
    if (!gapQueries || gapQueries.length === 0) return [];

    const {
        webSearch,
        crawl,
        requestCompletion,
        modelOverride = undefined,
        getConfig,
        getCancellable = () => null,
        isCancelled = () => false,
        getCitationTracker = () => null,
        getOriginalQuery = () => '',
        getActivePlanLength = () => 0,
        updateProgress = () => {},
        extendProgressCardForRefinement = () => {},
    } = host;

    const { webSearchConfig, crawl4aiConfig } = getConfig();

    log(`[Katab:research] Starting refinement phase — ${gapQueries.length} follow-up queries...`);

    // Extend the progress card with refinement rows
    extendProgressCardForRefinement(gapQueries);

    const refinementResults = [];
    for (let i = 0; i < gapQueries.length; i++) {
        const gap = gapQueries[i];
        const refIndex = getActivePlanLength() + i;
        updateProgress(refIndex, RESEARCH_PROGRESS_REFINING, 'Searching...');

        // Step 1: Search
        let searchResults;
        try {
            const result = await webSearch(gap.search_query, webSearchConfig, getCancellable());
            searchResults = result?.results || [];
        } catch (e) {
            if (isCancelled(e)) throw e;
            // Service unreachable — abort the whole research run rather than
            // silently degrade every refinement query.
            if (e.code === 'connection-failed' || e.code === 'network-error') {
                throw serviceDownError(e);
            }
            log(`[Katab:research] Refinement search "${gap.search_query}" failed: ${e.message}`);
            updateProgress(refIndex, RESEARCH_PROGRESS_ERROR, 'Search failed');
            refinementResults.push({
                topic: gap.rationale,
                findings: '',
                facts: [],
                sources: [],
                pageCount: 0,
            });
            continue;
        }

        if (!searchResults.length) {
            updateProgress(refIndex, RESEARCH_PROGRESS_DONE, 'No results');
            refinementResults.push({
                topic: gap.rationale,
                findings: '',
                facts: [],
                sources: [],
                pageCount: 0,
            });
            continue;
        }

        // Step 2: Crawl top results (only 2 for refinement)
        const topUrls = searchResults
            .slice(0, REFINEMENT_CRAWL_COUNT)
            .map((r) => r.url)
            .filter(Boolean);
        // Inject the refinement search query for BM25 relevance scoring
        crawl4aiConfig.query = gap.search_query;
        updateProgress(refIndex, RESEARCH_PROGRESS_SCRAPING, `Scraping ${topUrls.length} pages...`);

        const pages = [];
        for (const url of topUrls) {
            try {
                const crawlResults = await crawl(url, crawl4aiConfig, getCancellable());
                const result = crawlResults?.[0];
                // LLM extraction results carry their content in structuredJson /
                // llmResponse with an empty fitMarkdown — read the best available text.
                const text = result ? getCrawlResultText(result) : '';
                if (result?.success && text) {
                    pages.push({ url, text });
                }
            } catch (e) {
                if (isCancelled(e)) throw e;
                if (e.code === 'connection-failed' || e.code === 'network-error') {
                    throw serviceDownError(e);
                }
                log(`[Katab:research] Refinement crawl failed for ${url}: ${e.message}`);
            }
        }

        if (!pages.length) {
            const snippetText = searchResults
                .slice(0, 3)
                .map((r) => `- **${r.title}**\n  ${r.snippet}\n  [source](${r.url})`)
                .join('\n\n');
            updateProgress(
                refIndex,
                RESEARCH_PROGRESS_DONE,
                `${searchResults.length} results (snippets)`,
            );
            refinementResults.push({
                topic: gap.rationale,
                findings: `Refinement search for "${gap.search_query}":\n\n${snippetText}`,
                facts: [],
                sources: searchResults.map((r) => r.url),
                pageCount: 0,
            });
            continue;
        }

        // Step 3: Compress
        updateProgress(
            refIndex,
            RESEARCH_PROGRESS_COMPRESSING,
            `Compressing ${pages.length} pages...`,
        );

        const llmCall = async (messages, opts = {}) => {
            return await requestCompletion(messages, {
                cancellable: opts.cancellable || getCancellable(),
                maxTokens: opts.maxTokens || 1024,
                modelOverride,
            });
        };

        let findings;
        let facts = [];
        const sources = pages.map((p) => p.url);

        try {
            const compressed = await compressResearchBranch({
                pages,
                topic: gap.rationale,
                llmCall,
                cancellable: getCancellable(),
                researchContext: {
                    originalQuery: getOriginalQuery(),
                    subTask: gap.rationale,
                },
            });
            facts = compressed.facts;
            findings = compressed.findings || '';

            // Register in citation tracker
            const tracker = getCitationTracker();
            if (tracker && facts.length > 0) {
                registerFacts(tracker, facts);
            }
            // Also register sources
            if (tracker) {
                for (const url of sources) {
                    registerSource(tracker, url);
                }
            }
        } catch (e) {
            log(`[Katab:research] Refinement compression failed: ${e.message}`);
            findings = pages
                .map((p) => `### Page: ${p.url}\n${p.text.slice(0, 2000)}...`)
                .join('\n\n---\n\n');
        }

        updateProgress(
            refIndex,
            RESEARCH_PROGRESS_DONE,
            `${pages.length} pages, ${facts.length} facts`,
        );
        refinementResults.push({
            topic: gap.rationale,
            findings,
            facts,
            sources,
            pageCount: pages.length,
        });
    }

    const totalPages = refinementResults.reduce((sum, r) => sum + (r.pageCount || 0), 0);
    log(
        `[Katab:research] Refinement complete — ${totalPages} additional pages across ${refinementResults.length} queries.`,
    );
    return refinementResults;
}
