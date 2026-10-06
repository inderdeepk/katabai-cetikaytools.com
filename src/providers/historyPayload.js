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
            `[Katab:truncate] Skipping (${messages.length} msgs ≤ 4) — estimate=${estimateSize(messages)} chars`,
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

    // Keep the system prompt (index 0) and drop oldest middle messages
    // until the serialized body fits under maxBodyChars.
    const systemMsg = messages[0];
    const systemSize = sizes[0];
    for (let keep = messages.length; keep >= 2; keep--) {
        const suffixSum = suffix[messages.length - keep + 1];
        const size = Number.isFinite(suffixSum) ? systemSize + suffixSum + keep + 1 : Infinity;
        if (size <= maxBodyChars) {
            const candidate = [systemMsg, ...messages.slice(messages.length - keep + 1)];
            const dropped = messages.length - candidate.length;
            const droppedRoles = messages
                .slice(1, messages.length - keep + 1)
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

    // Fallback: system + last message only
    const minimal = [systemMsg, messages[messages.length - 1]];
    log(
        `[Katab:truncate] Heavy truncation: ${messages.length} → 2 msgs (${estimateSize(minimal)} chars)`,
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
            i = span.start - 1;
            continue;
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
        if (!message || message.role === 'tool') {
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

    if (annotated[index]?.message?.role === 'tool') {
        while (start > prefixLength && annotated[start - 1]?.message?.role === 'tool') {
            start--;
        }

        if (
            start > prefixLength &&
            annotated[start - 1]?.message?.role === 'assistant' &&
            annotated[start - 1]?.message?.tool_calls !== undefined
        ) {
            start--;
        }
    } else if (
        annotated[index]?.message?.role === 'assistant' &&
        annotated[index]?.message?.tool_calls !== undefined
    ) {
        while (end + 1 < annotated.length && annotated[end + 1]?.message?.role === 'tool') {
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
export function truncateToolResultForIteration(text, { toolName, iteration = 0, tiers } = {}) {
    if (!text || typeof text !== 'string') return text;
    if (!Array.isArray(tiers) || tiers.length === 0) return text;
    let tier = tiers[tiers.length - 1];
    for (const t of tiers) {
        if (iteration <= t.maxIteration) {
            tier = t;
            break;
        }
    }

    const isSearch = toolName === WEB_SEARCH_TOOL_NAME;
    const isRead = toolName === READ_URL_TOOL_NAME;
    // explore_docs results (TOC + page summary) are bounded like crawl results.
    const isCrawl = toolName === CRAWL4AI_TOOL_NAME || toolName === EXPLORE_DOCS_TOOL_NAME;
    // knowledge_search results are capped too (registry resultTruncationKey
    // is informational only — the switch lives here).
    const isKnowledge = toolName === RAG_TOOL_NAME;

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
                    const headBudget = Math.max(200, maxChars - tail.length - trimNote.length - 4);
                    return `${head.slice(0, headBudget).trimEnd()}\n\n${trimNote}\n\n${tail}`;
                }
            }
            return `${text.slice(0, maxChars).trimEnd()}\n\n${trimNote}`;
        }
    }

    if (isSearch) {
        // For web_search results, we trim individual result snippets.
        // The block is line-based: "N. Title\n   URL: ...\n   snippet\n".
        // We limit both the number of results and snippet length.
        const lines = text.split('\n');
        const result = [];
        let resultCount = 0;
        let inResult = false;
        for (const line of lines) {
            if (/^\d+\.\s/.test(line)) {
                resultCount++;
                if (resultCount > tier.searchResults) break;
                inResult = true;
                result.push(line);
            } else if (inResult && line.startsWith('   ') && resultCount <= tier.searchResults) {
                if (line.length > tier.searchSnippetChars + 3) {
                    result.push(line.slice(0, tier.searchSnippetChars).trimEnd() + '…');
                } else {
                    result.push(line);
                }
            } else if (!inResult || resultCount <= tier.searchResults) {
                result.push(line);
            }
        }
        if (resultCount > tier.searchResults) {
            result.push(
                `\n[${resultCount - tier.searchResults} more results trimmed — iteration ${iteration}.]`,
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
    let content = msg.content;
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
    // a provider switch mid-conversation) into the string format that
    // these APIs expect.
    if (provider !== 'anthropic' && Array.isArray(sanitized.content) && !nativeVision) {
        const blocks = sanitized.content;
        // Assistant tool_use blocks → convert to tool_calls payload.
        if (sanitized.role === 'assistant' && blocks.every((b) => b?.type === 'tool_use')) {
            sanitized.tool_calls = blocks.map((b) => ({
                id: b.id || '',
                type: 'function',
                function: {
                    name: b.name || '',
                    arguments: JSON.stringify(b.input || {}),
                },
            }));
            delete sanitized.content;
        } else {
            // Everything else (tool_result blocks, mixed content, etc.)
            // → flatten to a plain-text string so the API accepts it.
            sanitized.content = extractMessageText({ content: blocks });
            if (!sanitized.content) {
                delete sanitized.content;
            }
        }
    }

    // DeepSeek and other OpenAI-compatible APIs reject any message
    // field that is an object/map where a string is expected.  This can
    // happen when switching from a provider that stores exotic types in
    // message fields (e.g. an object slipped into `content` or `name`
    // during a malformed response).  Coerce every known string-valued
    // field to a plain string before serialization.
    if (provider !== 'anthropic') {
        // Coerce string-valued fields and also `role` (defence-in-depth).
        for (const field of ['role', 'content', 'name', 'tool_call_id', 'reasoning_content']) {
            const val = sanitized[field];
            if (val !== undefined && val !== null && typeof val !== 'string') {
                // Native DeepSeek Flash vision keeps `content` as an array
                // of text/image_url blocks — do not stringify it.
                if (field === 'content' && nativeVision && Array.isArray(val)) {
                    continue;
                }
                sanitized[field] =
                    typeof val === 'object' ? extractMessageText({ content: val }) : String(val);
                if (!sanitized[field]) {
                    delete sanitized[field];
                }
            }
        }
        // Strip every other field whose value is an object — DeepSeek
        // (and other OpenAI-compatible APIs) will reject any unknown
        // map-valued key.
        for (const key of Object.keys(sanitized)) {
            if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
                // `tool_calls` is the only array-of-objects field the
                // API accepts; let it through.
                if (key === 'tool_calls' && Array.isArray(sanitized[key])) {
                    continue;
                }
                // Native DeepSeek Flash vision also keeps array `content`.
                if (key === 'content' && nativeVision && Array.isArray(sanitized[key])) {
                    continue;
                }
                delete sanitized[key];
            }
        }
    }

    if (message.webSearchContext) {
        if (typeof sanitized.content === 'string') {
            sanitized.content = sanitized.content
                ? `${sanitized.content}\n\n${message.webSearchContext}`
                : message.webSearchContext;
        } else if (sanitized.content === undefined) {
            sanitized.content = message.webSearchContext;
        }
    }

    if (message.crawl4aiContext) {
        if (typeof sanitized.content === 'string') {
            sanitized.content = sanitized.content
                ? `${sanitized.content}\n\n${message.crawl4aiContext}`
                : message.crawl4aiContext;
        } else if (sanitized.content === undefined) {
            sanitized.content = message.crawl4aiContext;
        }
    }

    if (message.knowledgeContext) {
        if (typeof sanitized.content === 'string') {
            sanitized.content = sanitized.content
                ? `${sanitized.content}\n\n${message.knowledgeContext}`
                : message.knowledgeContext;
        } else if (sanitized.content === undefined) {
            sanitized.content = message.knowledgeContext;
        }
    }

    if (message.tool_calls !== undefined) {
        sanitized.tool_calls = message.tool_calls;
        // OpenAI-compatible APIs (DeepSeek, OpenAI, Ollama) require content
        // to be null or absent when tool_calls is present. Strip empty/falsy
        // content so the API does not reject the message or return an empty reply.
        if (!sanitized.content) {
            delete sanitized.content;
        }
    }

    // OpenAI-compatible APIs are strict about message and tool_call shapes.
    // Strip every key that is not part of the OpenAI Chat Completions schema
    // so that provider-specific artifacts (index, documents, provider,
    // metrics, etc.) never reach the API.
    if (provider !== 'anthropic') {
        const ALLOWED_MESSAGE_KEYS = new Set([
            'role',
            'content',
            'name',
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
        // Ollama expects its native format (arguments as objects, no forced type field)
        // — do NOT convert, or the server will 400 on the next turn.
        if (Array.isArray(sanitized.tool_calls) && provider !== 'ollama') {
            for (const tc of sanitized.tool_calls) {
                if (!tc || typeof tc !== 'object') continue;
                // Strip unexpected keys from tool_call
                for (const k of Object.keys(tc)) {
                    if (k !== 'id' && k !== 'type' && k !== 'function') {
                        delete tc[k];
                    }
                }
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
                                : '';
                    }
                }
            }
        }
    }

    if (message.tool_call_id !== undefined) {
        sanitized.tool_call_id = message.tool_call_id;
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
        } else if (message.tool_calls !== undefined && message.reasoning_content) {
            // Thinking is OFF but this message had tool_calls with
            // reasoning_content — echo it so the model can continue.
            sanitized.reasoning_content = message.reasoning_content;
        }
    }

    if (message.name !== undefined) {
        sanitized.name = message.name;
    }

    if (provider === 'ollama') {
        const existingImages = Array.isArray(message.images) ? message.images.filter(Boolean) : [];
        const images = [...existingImages, ...attachmentPayload.images].filter(Boolean);
        if (images.length) {
            sanitized.images = images;
        }
    }

    return sanitized;
}
