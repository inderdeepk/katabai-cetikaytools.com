// historyPayload.js — Provider payload shaping for stored message history.
//
// This module owns the pure logic that turns the in-memory conversation
// history into what actually goes over the wire:
//   • token estimates (text / content blocks / whole messages)
//   • budget truncators (Ollama serialized-size cap, DeepSeek token budget)
//   • progressive tool-result truncation across tool-call iterations
//   • provider-dialect sanitization (`sanitizeHistoryMessage`) and the
//     attachment payload blocks it embeds
//
// Everything here is host-free so it can be unit-tested directly; the
// dialog supplies provider state (vision config, session attachment cache)
// through small callback parameters.
import { IMAGE_TOKEN_ESTIMATE, stringifyContextValue } from '../core/sessionMemory.js';
import {
    buildDocumentPromptBlock,
    buildMissingDocumentPromptBlock,
    buildMissingImagePromptBlock,
    buildVisionAnalysisPromptBlock,
    looksLikeImageAttachment,
} from '../tools/documentTools.js';
import {
    CRAWL4AI_TOOL_NAME,
    EXPLORE_DOCS_TOOL_NAME,
    READ_URL_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME,
} from '../tools/toolDefinitions.js';
import { RAG_TOOL_NAME } from '../tools/ragTools.js';
import { splitLinksSection } from '../shared/pageLinks.js';

// DeepSeek context-window accounting.  The input budget is the context size
// minus the maximum output tokens the API may generate in one response.
// NOTE: src/core/sessionMemory.js keeps a documented mirror of the input
// budget (it cannot import from providers/ without inverting the layering).
export const DEEPSEEK_MAX_CONTEXT_TOKENS = 1000000;
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 384000;
export const DEEPSEEK_INPUT_TOKEN_BUDGET = DEEPSEEK_MAX_CONTEXT_TOKENS - DEEPSEEK_MAX_OUTPUT_TOKENS;
export const DEEPSEEK_CONTEXT_PREFIX_MESSAGES = 2;

// ── Token estimates ─────────────────────────────────────────────────────────

export function estimateTextTokens(text) {
    if (text === null || text === undefined || text === '') {
        return 0;
    }
    if (typeof text !== 'string') {
        // Defence: a non-string value must never degrade to
        // "[object Object]" (which massively under-counts a real payload).
        try {
            text = JSON.stringify(text);
        } catch (_e) {
            text = String(text);
        }
    }

    return Math.ceil(text.length / 4);
}

// Token estimate for a message `content` value.  Attached images are
// charged a fixed per-image cost instead of their base64 payload length:
// one photo's base64 is megabytes, so counting it as text made the context
// gauge read ~1M tokens for a single image and let images evict the whole
// text history from the budget (see stringifyContextValue).
export function estimateContentTokens(content) {
    if (content === null || content === undefined || content === '') {
        return 0;
    }
    if (typeof content === 'string') {
        return estimateTextTokens(content);
    }
    if (Array.isArray(content)) {
        let total = 0;
        for (const block of content) {
            if (!block || typeof block !== 'object') {
                total += estimateTextTokens(block);
                continue;
            }
            if (
                block.type === 'image_url' ||
                block.type === 'image' ||
                block.image_url ||
                block.source?.type === 'base64'
            ) {
                total += IMAGE_TOKEN_ESTIMATE;
                continue;
            }
            total += estimateTextTokens(JSON.stringify(block));
        }
        return total;
    }
    return estimateTextTokens(JSON.stringify(content));
}

export function estimateDeepSeekMessageTokens(message) {
    if (!message) {
        return 0;
    }

    let total = 6;
    total += estimateTextTokens(message.role);
    total += estimateContentTokens(message.content);
    total += estimateTextTokens(message.name);

    if (message.reasoning_content) {
        total += estimateTextTokens(message.reasoning_content);
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        total += estimateTextTokens(JSON.stringify(message.tool_calls));
    }

    if (Array.isArray(message.images) && message.images.length > 0) {
        total += message.images.length * IMAGE_TOKEN_ESTIMATE;
    }

    return total;
}

// ── Context-window truncation ───────────────────────────────────────────────

function isAnthropicToolResultMessage(message) {
    return (
        message?.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.length > 0 &&
        message.content.some((block) => block?.type === 'tool_result')
    );
}

function isToolResultMessage(message) {
    return message?.role === 'tool' || isAnthropicToolResultMessage(message);
}

function isAssistantToolCallMessage(message) {
    if (message?.role !== 'assistant') {
        return false;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return true;
    }
    return (
        Array.isArray(message.content) &&
        message.content.some((block) => block?.type === 'tool_use')
    );
}

export function truncateOllamaMessages(messages, { maxBodyChars = 200000 } = {}) {
    // Serialized size with image payloads collapsed to a fixed per-image
    // cost — base64 bytes are a transport detail and must not dwarf the
    // budget (see stringifyContextValue).
    const estimateSize = (value) => {
        try {
            return stringifyContextValue(value).length;
        } catch (_) {
            return Infinity;
        }
    };

    if (!Array.isArray(messages) || messages.length <= 4) {
        log(
            `[Katab:truncate] Skipping (${Array.isArray(messages) ? messages.length : 0} msgs ≤ 4) — estimate=${estimateSize(messages)} chars`,
        );
        return messages;
    }

    // Per-message sizes computed once; each candidate for `keep` is then
    // O(1) via suffix sums (the old loop re-serialized the whole candidate
    // array on every step — O(n²) on the shell thread).
    const sizes = messages.map((message) => estimateSize(message));
    const suffix = new Array(messages.length + 1);
    suffix[messages.length] = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        suffix[i] = suffix[i + 1] + sizes[i];
    }

    const fullSize = suffix[0] + messages.length + 1;
    if (fullSize <= maxBodyChars) {
        log(
            `[Katab:truncate] No truncation needed — ${messages.length} msgs, ${fullSize} chars ≤ ${maxBodyChars}`,
        );
        return messages;
    }

    // Preserve leading system prompt if present; otherwise start at index 0.
    const hasLeadingSystem = messages[0]?.role === 'system';
    const prefix = hasLeadingSystem ? [messages[0]] : [];
    const prefixSize = hasLeadingSystem ? sizes[0] : 0;
    const minStart = hasLeadingSystem ? 1 : 0;

    // Step start forward, never starting on an orphaned tool-result message
    // (which violates OpenAI/Ollama/Anthropic tool-call pairing).
    for (let start = minStart; start < messages.length; start++) {
        if (isToolResultMessage(messages[start])) {
            continue;
        }
        const suffixCount = messages.length - start;
        const totalCount = prefix.length + suffixCount;
        const suffixSum = suffix[start];
        const size = Number.isFinite(suffixSum)
            ? prefixSize + suffixSum + totalCount + 1
            : Infinity;
        if (size <= maxBodyChars) {
            const candidate = [...prefix, ...messages.slice(start)];
            const dropped = messages.length - candidate.length;
            const droppedRoles = messages
                .slice(minStart, start)
                .map(
                    (m) =>
                        `${m.role}${m.tool_calls ? '(tool_calls)' : m.tool_call_id ? '(tool_result)' : ''}`,
                );
            log(
                `[Katab:truncate] Truncated: ${messages.length} → ${candidate.length} msgs (${size} chars). Dropped ${dropped} middle msgs: [${droppedRoles.join(', ')}]`,
            );
            return candidate;
        }
    }

    // Fallback: keep prefix + the final atomic span (so if the last message is
    // a tool result, its owning assistant(tool_calls) message stays attached).
    let tailStart = messages.length - 1;
    if (isToolResultMessage(messages[tailStart])) {
        while (tailStart > minStart && isToolResultMessage(messages[tailStart - 1])) {
            tailStart--;
        }
        if (tailStart > minStart && isAssistantToolCallMessage(messages[tailStart - 1])) {
            tailStart--;
        }
    }
    const minimal = [...prefix, ...messages.slice(tailStart)];
    log(
        `[Katab:truncate] Heavy truncation: ${messages.length} → ${minimal.length} msgs (${estimateSize(minimal)} chars)`,
    );
    return minimal;
}

export function truncateDeepSeekMessages(
    messages,
    { tokenBudget = DEEPSEEK_INPUT_TOKEN_BUDGET } = {},
) {
    if (!Array.isArray(messages) || messages.length <= 2) {
        return messages;
    }

    let annotated = messages.map((message, index) => ({
        index,
        message,
        tokens: estimateDeepSeekMessageTokens(message),
    }));

    let totalTokens = annotated.reduce((sum, item) => sum + item.tokens, 0);
    if (totalTokens <= tokenBudget) {
        return messages;
    }

    let prefixLength = getDeepSeekContextPrefixLength(messages);
    let selectedIndexes = new Set();
    let selectedTokens = 0;

    for (let i = 0; i < prefixLength; i++) {
        selectedIndexes.add(i);
        selectedTokens += annotated[i].tokens;
    }

    let lastSpan = getDeepSeekRetentionSpan(annotated, messages.length - 1, prefixLength);
    for (let i = lastSpan.start; i <= lastSpan.end; i++) {
        if (selectedIndexes.has(i)) {
            continue;
        }

        selectedIndexes.add(i);
        selectedTokens += annotated[i].tokens;
    }

    if (selectedTokens >= tokenBudget) {
        return annotated
            .filter((item) => selectedIndexes.has(item.index))
            .map((item) => item.message);
    }

    // Walk backward contiguously from the newest turns. Stop as soon as the
    // next span overflows budget rather than skipping it to cherry-pick older
    // messages (which would break chronological order and produce consecutive
    // same-role turns).
    for (let i = messages.length - 1; i >= prefixLength;) {
        if (selectedIndexes.has(i)) {
            i--;
            continue;
        }

        let span = getDeepSeekRetentionSpan(annotated, i, prefixLength);
        let missingIndexes = [];
        let missingTokens = 0;

        for (let j = span.start; j <= span.end; j++) {
            if (selectedIndexes.has(j)) {
                continue;
            }

            missingIndexes.push(j);
            missingTokens += annotated[j].tokens;
        }

        if (selectedTokens + missingTokens > tokenBudget) {
            break;
        }

        for (let retainedIndex of missingIndexes) {
            selectedIndexes.add(retainedIndex);
        }
        selectedTokens += missingTokens;
        i = span.start - 1;
    }

    if (selectedIndexes.size === messages.length) {
        return messages;
    }

    return annotated.filter((item) => selectedIndexes.has(item.index)).map((item) => item.message);
}

function getDeepSeekContextPrefixLength(messages) {
    let prefixLength = 0;

    while (prefixLength < messages.length && messages[prefixLength]?.role === 'system') {
        prefixLength++;
    }

    let preservedMessages = 0;
    while (prefixLength < messages.length && preservedMessages < DEEPSEEK_CONTEXT_PREFIX_MESSAGES) {
        let message = messages[prefixLength];
        // Never keep an orphaned tool result or an assistant tool_calls turn
        // separated from its following tool results in the prefix.
        if (!message || isToolResultMessage(message) || isAssistantToolCallMessage(message)) {
            break;
        }

        prefixLength++;
        preservedMessages++;

        if (message.role === 'user') {
            break;
        }
    }

    return prefixLength;
}

function getDeepSeekRetentionSpan(annotated, index, prefixLength) {
    let start = index;
    let end = index;

    if (isToolResultMessage(annotated[index]?.message)) {
        while (start > prefixLength && isToolResultMessage(annotated[start - 1]?.message)) {
            start--;
        }

        if (start > prefixLength && isAssistantToolCallMessage(annotated[start - 1]?.message)) {
            start--;
        }
    } else if (isAssistantToolCallMessage(annotated[index]?.message)) {
        while (end + 1 < annotated.length && isToolResultMessage(annotated[end + 1]?.message)) {
            end++;
        }
    }

    let tokens = 0;
    for (let i = start; i <= end; i++) {
        tokens += annotated[i].tokens;
    }

    return { start, end, tokens };
}

// ── Progressive tool-result truncation ──────────────────────────────────────

// Progressively truncate tool-result text based on the current tool-call
// iteration.  Early iterations keep full results; later iterations get
// shorter content so the context stays within practical model limits.
export function truncateToolResultForIteration(
    text,
    { toolName, resultTruncationKey = null, iteration = 0, tiers } = {},
) {
    if (!text || typeof text !== 'string') return text;
    if (!Array.isArray(tiers) || tiers.length === 0) return text;
    let tier = tiers[tiers.length - 1];
    for (const t of tiers) {
        if (iteration <= t.maxIteration) {
            tier = t;
            break;
        }
    }

    const isSearch = resultTruncationKey === 'search' || toolName === WEB_SEARCH_TOOL_NAME;
    const isRead = resultTruncationKey === 'readUrl' || toolName === READ_URL_TOOL_NAME;
    // explore_docs results (TOC + page summary) are bounded like crawl results.
    const isCrawl =
        resultTruncationKey === 'crawl' ||
        toolName === CRAWL4AI_TOOL_NAME ||
        toolName === EXPLORE_DOCS_TOOL_NAME;
    const isKnowledge = resultTruncationKey === 'knowledge' || toolName === RAG_TOOL_NAME;

    if (isRead || isCrawl || isKnowledge) {
        const maxChars = isRead
            ? tier.readUrlChars
            : isCrawl
              ? tier.crawlChars
              : tier.knowledgeChars || tier.crawlChars;
        if (text.length > maxChars) {
            const trimNote = `[Content trimmed at iteration ${iteration} to manage context — re-read this page later if you need the rest.]`;
            if (isRead || isCrawl) {
                // Keep the page's links section (and any trailing safety
                // guard / nudges) intact so the agent can still navigate
                // to subpages after the body is trimmed.
                const { head, tail } = splitLinksSection(text);
                if (tail) {
                    const availableForHead = maxChars - tail.length - trimNote.length - 4;
                    if (availableForHead >= 200) {
                        return `${head.slice(0, availableForHead).trimEnd()}\n\n${trimNote}\n\n${tail}`;
                    }
                    // When the tail alone consumes nearly the whole budget,
                    // still preserve a short head + trimmed tail within maxChars.
                    const headBudget = Math.min(
                        head.length,
                        Math.max(200, Math.floor(maxChars * 0.45)),
                    );
                    const tailBudget = Math.max(0, maxChars - headBudget - trimNote.length - 4);
                    const keptTail =
                        tailBudget >= tail.length ? tail : tail.slice(0, tailBudget).trimEnd();
                    return keptTail
                        ? `${head.slice(0, headBudget).trimEnd()}\n\n${trimNote}\n\n${keptTail}`
                        : `${head.slice(0, maxChars).trimEnd()}\n\n${trimNote}`;
                }
            }
            return `${text.slice(0, maxChars).trimEnd()}\n\n${trimNote}`;
        }
    }

    if (isSearch) {
        // For web_search results, we trim individual result snippets.
        // The block is line-based: "N. Title\n   URL: ...\n   snippet\n".
        // We limit both the number of results and snippet length while keeping
        // URL lines intact so citations/links are never corrupted.
        const lines = text.split('\n');
        const result = [];
        let totalResultCount = 0;
        let inResult = false;
        let keptCurrent = false;
        for (const line of lines) {
            if (/^\d+\.\s/.test(line)) {
                totalResultCount++;
                inResult = true;
                keptCurrent = totalResultCount <= tier.searchResults;
                if (keptCurrent) {
                    result.push(line);
                }
            } else if (inResult) {
                if (!keptCurrent) {
                    continue;
                }
                if (line.startsWith('   ')) {
                    // Never truncate URL lines — broken URLs cause failed read_url calls.
                    const isUrlLine = line.trimStart().startsWith('URL:');
                    if (!isUrlLine && line.length > tier.searchSnippetChars + 3) {
                        result.push(line.slice(0, tier.searchSnippetChars).trimEnd() + '…');
                    } else {
                        result.push(line);
                    }
                } else {
                    result.push(line);
                }
            } else {
                result.push(line);
            }
        }
        if (totalResultCount > tier.searchResults) {
            result.push(
                `\n[${totalResultCount - tier.searchResults} more results trimmed — iteration ${iteration}.]`,
            );
        }
        return result.join('\n');
    }

    return text;
}

// ── Attachment helpers ──────────────────────────────────────────────────────

export function getMessageAttachments(message) {
    return Array.isArray(message?.documents) ? message.documents : [];
}

export function getAttachmentKind(attachmentMeta) {
    if (!attachmentMeta) {
        return null;
    }

    if (attachmentMeta.kind) {
        return attachmentMeta.kind;
    }

    return looksLikeImageAttachment(attachmentMeta) ? 'image' : 'document';
}

export function messageHasImageAttachments(message) {
    return getMessageAttachments(message).some(
        (attachmentMeta) => getAttachmentKind(attachmentMeta) === 'image',
    );
}

/** Extract searchable plain-text from a message object.
 *  Handles string content, array content (Anthropic content blocks),
 *  and tool results. Returns an empty string for unsearchable payloads. */
export function extractMessageText(msg) {
    let content = msg?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        let parts = [];
        for (let block of content) {
            if (!block) continue;
            if (typeof block === 'string') {
                parts.push(block);
            } else if (typeof block.text === 'string') {
                parts.push(block.text);
            } else if (block.type === 'tool_result' && typeof block.content === 'string') {
                parts.push(block.content);
            }
        }
        return parts.join(' ');
    }
    return '';
}

/**
 * Build the provider-facing content + images for a message's attachments.
 *
 * @param {Object} message - Stored history message
 * @param {Object} [options]
 * @param {string} [options.provider] - Active provider key
 * @param {string|null} [options.visionAnalysis] - Vision-model analysis text
 *   (empty string is a sentinel for a failed analysis)
 * @param {string} [options.visionModelName]
 * @param {boolean} [options.nativeVision] - DeepSeek Flash native image input
 * @param {Function} [options.getSessionAttachment] - path → cached parsed
 *   attachment ({kind, base64Data, mimeType, text, ...}) | null
 */
export function buildApiAttachmentPayload(
    message,
    {
        provider,
        visionAnalysis = null,
        visionModelName = '',
        nativeVision = false,
        getSessionAttachment = () => null,
    } = {},
) {
    // Structured content (arrays of content blocks, e.g. Anthropic tool_use /
    // tool_result turns) is passed through verbatim.
    if (Array.isArray(message?.content)) {
        return { content: message.content, images: [] };
    }
    let content = String(message?.content ?? '');
    const attachments = getMessageAttachments(message);
    if (!attachments.length) {
        return { content, images: [] };
    }

    const attachmentBlocks = [];
    const imageBlocks = [];
    const images = [];

    for (const attachmentMeta of attachments) {
        const sessionAttachment = attachmentMeta?.path
            ? getSessionAttachment(attachmentMeta.path)
            : null;
        const attachmentKind = sessionAttachment?.kind || getAttachmentKind(attachmentMeta);

        if (attachmentKind === 'image') {
            if (provider === 'ollama' && sessionAttachment?.base64Data) {
                images.push(sessionAttachment.base64Data);
            } else if (provider === 'deepseek' && nativeVision && sessionAttachment?.base64Data) {
                // Native DeepSeek Flash vision: images become OpenAI-style
                // image_url content blocks sent straight to the DeepSeek API.
                imageBlocks.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:${sessionAttachment.mimeType || attachmentMeta.mimeType || 'image/png'};base64,${sessionAttachment.base64Data}`,
                    },
                });
            } else if (
                provider === 'deepseek' &&
                visionAnalysis !== null &&
                visionAnalysis !== undefined
            ) {
                // DeepSeek is text-only: the vision model's analysis replaces
                // the raw image. Add the block once (dedupe across images).
                // Empty string is a sentinel for a failed analysis — the
                // helper renders a clear "unavailable" notice.
                if (!attachmentBlocks.some((b) => b && b.startsWith('[Vision analysis'))) {
                    attachmentBlocks.push(
                        buildVisionAnalysisPromptBlock(visionAnalysis, visionModelName),
                    );
                }
            } else {
                attachmentBlocks.push(buildMissingImagePromptBlock(attachmentMeta));
            }
            continue;
        }

        if (sessionAttachment) {
            attachmentBlocks.push(buildDocumentPromptBlock(sessionAttachment));
        } else {
            attachmentBlocks.push(buildMissingDocumentPromptBlock(attachmentMeta));
        }
    }

    if (imageBlocks.length) {
        const blocks = [];
        if (content && content.trim()) {
            blocks.push({ type: 'text', text: content });
        }
        blocks.push(...imageBlocks);
        if (attachmentBlocks.length) {
            blocks.push({ type: 'text', text: attachmentBlocks.join('\n\n') });
        }
        if (!blocks.some((block) => block && block.type === 'text')) {
            blocks.unshift({ type: 'text', text: 'Please analyze the attached image(s).' });
        }
        return { content: blocks, images: [] };
    }

    if (!attachmentBlocks.length) {
        return { content, images };
    }

    if (!content) {
        return {
            content: attachmentBlocks.join('\n\n'),
            images,
        };
    }

    return {
        content: `${content}\n\n${attachmentBlocks.join('\n\n')}`,
        images,
    };
}

// ── Provider-dialect sanitization ───────────────────────────────────────────

/**
 * Deep-clone `tool_calls` (array + function objects) so provider-specific
 * normalization never rewrites the stored history.  The old in-place rewrite
 * corrupted cross-provider conversations: sending an Ollama-origin history to
 * DeepSeek stringified `function.arguments` PERMANENTLY, and switching back to
 * Ollama then sent a JSON string where the native API expects an object.
 */
function cloneToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls)) return toolCalls;
    return toolCalls.map((call) => {
        if (!call || typeof call !== 'object') return call;
        const cloned = { ...call };
        if (call.function && typeof call.function === 'object') {
            cloned.function = { ...call.function };
        }
        return cloned;
    });
}

function sanitizeAnthropicId(rawId, fallback) {
    const cleaned = String(rawId || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned || fallback;
}

/** Ollama expects `function.arguments` as a JSON object/map; older turns may
 *  store a JSON string, empty string, or non-object after a provider switch. */
function normalizeOllamaToolCall(call) {
    if (!call || typeof call !== 'object') return call;
    const fn = call.function;
    if (!fn || typeof fn !== 'object') return call;
    if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) {
        return call;
    }
    if (typeof fn.arguments === 'string') {
        const raw = fn.arguments.trim();
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return { ...call, function: { ...fn, arguments: parsed } };
                }
            } catch (_e) {
                /* fall through to empty object */
            }
        }
    }
    return { ...call, function: { ...fn, arguments: {} } };
}

function appendContextText(sanitized, ctxText) {
    if (!ctxText) return;
    if (Array.isArray(sanitized.content)) {
        sanitized.content = [...sanitized.content, { type: 'text', text: String(ctxText) }];
    } else if (typeof sanitized.content === 'string') {
        sanitized.content = sanitized.content ? `${sanitized.content}\n\n${ctxText}` : ctxText;
    } else if (sanitized.content === undefined) {
        sanitized.content = ctxText;
    }
}

/**
 * Convert an OpenAI/DeepSeek-shaped history message into Anthropic's dialect.
 * Without this, switching providers mid-conversation sent `role:'tool'` rows
 * (Anthropic only accepts user/assistant) and raw `tool_calls` objects, which
 * the API rejects with HTTP 400.
 */
function finalizeAnthropicMessage(sanitized, message) {
    // Tool results → a user message carrying a `tool_result` content block.
    if (
        sanitized.role === 'tool' ||
        (message?.tool_call_id !== undefined && sanitized.role !== 'assistant')
    ) {
        const text =
            typeof sanitized.content === 'string'
                ? sanitized.content
                : extractMessageText({ content: sanitized.content ?? '' });
        const rawId = message?.tool_call_id ?? message?.tool_calls?.[0]?.id ?? '';
        const toolUseId = sanitizeAnthropicId(rawId, 'toolu_0');
        return {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: text || '(no output)',
                },
            ],
        };
    }

    // Assistant tool calls → `tool_use` content blocks (text first, if any).
    if (
        sanitized.role === 'assistant' &&
        Array.isArray(sanitized.tool_calls) &&
        sanitized.tool_calls.length > 0
    ) {
        const blocks = [];
        const text =
            typeof sanitized.content === 'string'
                ? sanitized.content
                : extractMessageText({ content: sanitized.content ?? '' });
        if (text && text.trim()) {
            blocks.push({ type: 'text', text });
        }
        let toolIdx = 0;
        for (const call of sanitized.tool_calls) {
            if (!call || typeof call !== 'object') continue;
            const fn = call.function && typeof call.function === 'object' ? call.function : {};
            let input = {};
            if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) {
                input = fn.arguments;
            } else if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
                try {
                    const parsed = JSON.parse(fn.arguments);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        input = parsed;
                    }
                } catch (_e) {
                    input = {};
                }
            }
            blocks.push({
                type: 'tool_use',
                id: sanitizeAnthropicId(call.id, `toolu_${toolIdx}`),
                name: String(fn.name || ''),
                input,
            });
            toolIdx++;
        }
        if (blocks.length > 0) {
            return { role: 'assistant', content: blocks };
        }
    }

    // Anthropic message objects accept only role + content.
    const content =
        sanitized.content === undefined || sanitized.content === null ? '' : sanitized.content;
    return { role: sanitized.role, content };
}

/**
 * Convert one stored history message into the provider-facing message shape.
 *
 * @param {Object} message - Stored history message (may carry UI-only fields)
 * @param {Object} [options]
 * @param {string} options.provider - Active provider key
 * @param {boolean} [options.thinkingEnabled] - DeepSeek thinking mode
 * @param {Function} [options.isDeepSeekNativeVisionModel] - () → boolean
 * @param {Function} [options.getVisionModelConfig] - () → config | null
 * @param {Function} [options.getSessionAttachment] - path → cached attachment
 * @returns {Object} sanitized message
 */
export function sanitizeHistoryMessage(
    message,
    {
        provider,
        thinkingEnabled = false,
        isDeepSeekNativeVisionModel = () => false,
        getVisionModelConfig = () => null,
        getSessionAttachment = () => null,
    } = {},
) {
    let sanitized = {
        role: message.role,
    };

    const attachments = getMessageAttachments(message);
    const visionConfig = provider === 'deepseek' ? getVisionModelConfig() : null;
    // Native DeepSeek Flash vision: user image messages keep their array
    // content blocks (text + image_url) instead of being flattened to a
    // string or routed through the orchestration vision model.
    const nativeVision =
        provider === 'deepseek' &&
        message.role === 'user' &&
        messageHasImageAttachments(message) &&
        isDeepSeekNativeVisionModel();
    const attachmentPayload = buildApiAttachmentPayload(message, {
        provider,
        // `??` (not `||`) preserves the empty-string sentinel used to mark
        // a failed vision analysis.
        visionAnalysis: provider === 'deepseek' ? (message.visionAnalysis ?? null) : null,
        visionModelName: visionConfig?.model || '',
        nativeVision,
        getSessionAttachment,
    });

    if (message.content !== undefined || attachments.length) {
        sanitized.content = attachmentPayload.content;
    }

    // When the provider is not Anthropic (i.e. DeepSeek, OpenAI, Ollama
    // or other OpenAI-compatible APIs), convert array-format content
    // blocks (e.g. Anthropic tool_use / tool_result turns that survive
    // a provider switch mid-conversation) into the format these APIs expect.
    if (provider !== 'anthropic' && Array.isArray(sanitized.content) && !nativeVision) {
        const blocks = sanitized.content;
        const toolUseBlocks =
            sanitized.role === 'assistant' ? blocks.filter((b) => b?.type === 'tool_use') : [];
        // Assistant blocks containing tool_use (with or without leading text)
        // → convert tool_use entries to tool_calls and preserve any text.
        if (toolUseBlocks.length > 0) {
            sanitized.tool_calls = toolUseBlocks.map((b, idx) => ({
                id: b.id || `call_${idx}`,
                type: 'function',
                function: {
                    name: b.name || '',
                    arguments: JSON.stringify(
                        b.input && typeof b.input === 'object' && !Array.isArray(b.input)
                            ? b.input
                            : {},
                    ),
                },
            }));
            const textParts = blocks
                .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
                .map((b) => b.text);
            if (textParts.length > 0) {
                sanitized.content = textParts.join('\n');
            } else {
                delete sanitized.content;
            }
        } else {
            // Everything else (tool_result blocks, mixed text content, etc.)
            // → flatten to a plain-text string so the API accepts it.
            sanitized.content = extractMessageText({ content: blocks });
            if (!sanitized.content) {
                delete sanitized.content;
            }
        }
    }

    appendContextText(sanitized, message.webSearchContext);
    appendContextText(sanitized, message.crawl4aiContext);
    appendContextText(sanitized, message.knowledgeContext);

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        // Clone before any dialect-specific normalization below so the stored
        // history keeps its original (provider-native) argument shape.
        sanitized.tool_calls = cloneToolCalls(message.tool_calls);
        // OpenAI-compatible APIs (DeepSeek, OpenAI, Ollama) require content
        // to be null or absent when tool_calls is present and empty. Strip
        // empty/falsy content so the API does not reject or return empty.
        if (!sanitized.content) {
            delete sanitized.content;
        }
    }

    // Copy optional protocol fields BEFORE string coercion & key allowlisting
    // so defense-in-depth validation runs over every outgoing field.
    if (message.tool_call_id !== undefined) {
        sanitized.tool_call_id = message.tool_call_id;
    }
    if (message.name !== undefined) {
        sanitized.name = message.name;
    }
    if (provider === 'ollama' && sanitized.role === 'tool') {
        const toolName = message.tool_name || message.name;
        if (toolName) {
            sanitized.tool_name = toolName;
        }
    }

    // For DeepSeek: assistant messages that carry reasoning_content must
    // echo it back. When the current request has thinking enabled the API
    // requires it on *every* assistant message — even tool-call turns where
    // thinking was disabled — to maintain chain-of-thought continuity.
    // When thinking is disabled we still echo it on tool-call turns because
    // the API generated that reasoning_content originally and expects it
    // alongside the tool_calls.
    if (provider === 'deepseek' && message.role === 'assistant') {
        if (thinkingEnabled) {
            // Thinking is ON: every assistant message MUST carry
            // reasoning_content (at minimum an empty string).
            sanitized.reasoning_content = message.reasoning_content || '';
        } else if (
            Array.isArray(message.tool_calls) &&
            message.tool_calls.length > 0 &&
            message.reasoning_content
        ) {
            // Thinking is OFF but this message had tool_calls with
            // reasoning_content — echo it so the model can continue.
            sanitized.reasoning_content = message.reasoning_content;
        }
    }

    if (provider === 'ollama') {
        const existingImages = Array.isArray(message.images) ? message.images.filter(Boolean) : [];
        const images = [...existingImages, ...attachmentPayload.images].filter(Boolean);
        if (images.length) {
            sanitized.images = images;
        }
        // Ollama's native tool_calls expect `arguments` as an object (not the
        // OpenAI JSON string) — restore it for turns recorded under another
        // provider.
        if (Array.isArray(sanitized.tool_calls)) {
            sanitized.tool_calls = sanitized.tool_calls.map(normalizeOllamaToolCall);
        }
    }

    // DeepSeek and other OpenAI-compatible APIs reject any message
    // field that is an object/map where a string is expected, and reject
    // unexpected UI-only keys.
    if (provider !== 'anthropic') {
        for (const field of [
            'role',
            'content',
            'name',
            'tool_name',
            'tool_call_id',
            'reasoning_content',
        ]) {
            const val = sanitized[field];
            if (val !== undefined && val !== null && typeof val !== 'string') {
                if (field === 'content' && nativeVision && Array.isArray(val)) {
                    continue;
                }
                sanitized[field] =
                    typeof val === 'object' ? extractMessageText({ content: val }) : String(val);
                if (!sanitized[field] && field !== 'reasoning_content') {
                    delete sanitized[field];
                }
            }
        }
        for (const key of Object.keys(sanitized)) {
            if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
                if (key === 'tool_calls' && Array.isArray(sanitized[key])) {
                    continue;
                }
                if (key === 'content' && nativeVision && Array.isArray(sanitized[key])) {
                    continue;
                }
                if (key === 'images' && provider === 'ollama' && Array.isArray(sanitized[key])) {
                    continue;
                }
                delete sanitized[key];
            }
        }

        const ALLOWED_MESSAGE_KEYS = new Set([
            'role',
            'content',
            'name',
            'tool_name', // Ollama native /api/chat tool result identifier
            'tool_calls',
            'tool_call_id',
            'reasoning_content', // DeepSeek-specific, harmless for others
            'type', // DeepSeek-specific, harmless for others
            'images', // Ollama image attachments
        ]);
        for (const key of Object.keys(sanitized)) {
            if (!ALLOWED_MESSAGE_KEYS.has(key)) {
                delete sanitized[key];
            }
        }

        // DeepSeek requires a `type` field on every message (set to the role).
        // This is not part of the OpenAI spec; other providers (Ollama) may
        // reject it, so only add it when targeting DeepSeek.
        if (provider === 'deepseek' && !sanitized.type) {
            sanitized.type = sanitized.role;
        } else if (provider !== 'deepseek') {
            delete sanitized.type;
        }

        // Ensure tool_calls conform: only id / type / function, and
        // function only name / arguments (both strings).
        // Ollama expects its native format (arguments as objects) — handled above.
        if (Array.isArray(sanitized.tool_calls) && provider !== 'ollama') {
            for (let idx = 0; idx < sanitized.tool_calls.length; idx++) {
                const tc = sanitized.tool_calls[idx];
                if (!tc || typeof tc !== 'object') continue;
                for (const k of Object.keys(tc)) {
                    if (k !== 'id' && k !== 'type' && k !== 'function') {
                        delete tc[k];
                    }
                }
                if (!tc.id) tc.id = `call_${idx}`;
                if (!tc.type) tc.type = 'function';
                if (tc.function && typeof tc.function === 'object') {
                    for (const k of Object.keys(tc.function)) {
                        if (k !== 'name' && k !== 'arguments') {
                            delete tc.function[k];
                        }
                    }
                    if (typeof tc.function.arguments !== 'string') {
                        tc.function.arguments =
                            tc.function.arguments != null
                                ? JSON.stringify(tc.function.arguments)
                                : '{}';
                    } else if (!tc.function.arguments.trim()) {
                        tc.function.arguments = '{}';
                    }
                }
            }
        }
    }

    // Anthropic accepts only user/assistant roles and content blocks — adapt
    // OpenAI/DeepSeek-style tool history instead of sending it verbatim.
    if (provider === 'anthropic') {
        return finalizeAnthropicMessage(sanitized, message);
    }

    return sanitized;
}

/**
 * Sanitize an entire message sequence for a target provider, handling 1-to-N
 * and N-to-1 cross-provider tool history conversions:
 *   - Anthropic → OpenAI/DeepSeek/Ollama: expands Anthropic `user` messages
 *     carrying `tool_result` blocks into individual `role: 'tool'` messages
 *     (preserving `tool_call_id` so OpenAI/DeepSeek don't return HTTP 400).
 *   - OpenAI/DeepSeek/Ollama → Anthropic: coalesces consecutive `role: 'user'`
 *     tool-result messages into a single `user` message with multiple
 *     `tool_result` blocks and reconciles missing Ollama tool-call IDs.
 *
 * @param {Array<Object>} messages
 * @param {Object} options - Same options passed to `sanitizeHistoryMessage`
 * @returns {Array<Object>}
 */
export function sanitizeHistoryMessages(messages, options = {}) {
    if (!Array.isArray(messages)) {
        return [];
    }
    const provider = options.provider;
    const out = [];

    // Track tool-call IDs from the immediately preceding assistant turn so
    // Ollama-origin tool messages without IDs match cleanly on Anthropic/OpenAI.
    let pendingToolIds = [];
    let pendingToolCursor = 0;

    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') {
            continue;
        }

        // Cross-provider Anthropic → OpenAI/DeepSeek/Ollama expansion:
        // An Anthropic user message with `tool_result` blocks must become
        // individual `role: 'tool'` rows following the assistant's `tool_calls`.
        if (
            provider !== 'anthropic' &&
            msg.role === 'user' &&
            Array.isArray(msg.content) &&
            msg.content.some((b) => b?.type === 'tool_result' && b.tool_use_id)
        ) {
            const extraText = [];
            for (const block of msg.content) {
                if (block?.type === 'tool_result' && block.tool_use_id) {
                    const toolMsg = {
                        role: 'tool',
                        tool_call_id: String(block.tool_use_id),
                        content:
                            typeof block.content === 'string'
                                ? block.content
                                : extractMessageText({ content: block.content }),
                    };
                    if (provider === 'deepseek') {
                        toolMsg.type = 'tool';
                    }
                    out.push(toolMsg);
                } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
                    extraText.push(block.text);
                }
            }
            if (extraText.length > 0) {
                out.push(
                    sanitizeHistoryMessage({ ...msg, content: extraText.join('\n\n') }, options),
                );
            }
            continue;
        }

        // Drop orphaned tool results with no preceding assistant tool_calls turn —
        // OpenAI, DeepSeek, and Anthropic all reject orphan tool messages with HTTP 400.
        if (msg.role === 'tool' && pendingToolIds.length === 0) {
            continue;
        }

        // Pair missing tool_call_id on Ollama-origin tool messages with the
        // synthesized IDs from the preceding assistant tool_calls turn.
        let effectiveMsg = msg;
        if (msg.role === 'tool' && !msg.tool_call_id && pendingToolCursor < pendingToolIds.length) {
            effectiveMsg = { ...msg, tool_call_id: pendingToolIds[pendingToolCursor++] };
        }

        const sanitized = sanitizeHistoryMessage(effectiveMsg, options);

        if (effectiveMsg.role === 'assistant') {
            if (Array.isArray(sanitized.tool_calls) && sanitized.tool_calls.length > 0) {
                pendingToolIds = sanitized.tool_calls.map((tc, i) => tc.id || `call_${i}`);
                pendingToolCursor = 0;
            } else if (
                provider === 'anthropic' &&
                Array.isArray(sanitized.content) &&
                sanitized.content.some((b) => b?.type === 'tool_use')
            ) {
                pendingToolIds = sanitized.content
                    .filter((b) => b?.type === 'tool_use')
                    .map((b) => b.id);
                pendingToolCursor = 0;
            } else {
                pendingToolIds = [];
                pendingToolCursor = 0;
            }
        } else if (effectiveMsg.role !== 'tool') {
            pendingToolIds = [];
            pendingToolCursor = 0;
        }

        // For Anthropic, merge consecutive same-role messages (e.g. parallel
        // tool results) immediately so downstream callers get valid alternation.
        if (
            provider === 'anthropic' &&
            sanitized.role !== 'system' &&
            out.length > 0 &&
            out[out.length - 1].role === sanitized.role
        ) {
            const prev = out[out.length - 1];
            const prevBlocks = Array.isArray(prev.content)
                ? prev.content
                : prev.content
                  ? [{ type: 'text', text: String(prev.content) }]
                  : [];
            const nextBlocks = Array.isArray(sanitized.content)
                ? sanitized.content
                : sanitized.content
                  ? [{ type: 'text', text: String(sanitized.content) }]
                  : [];
            prev.content = [...prevBlocks, ...nextBlocks];
        } else {
            out.push(sanitized);
        }
    }

    return out;
}
