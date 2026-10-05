// titleGenerator.js — Pure helpers for the manual conversation
// title/description generator.
//
// The dialog asks the active provider to summarize a saved conversation; this
// module owns everything that can be tested without the shell: transcript
// excerpt building, the single-user-message prompt shape (safe for providers
// that drop system messages, e.g. Anthropic's non-streaming dialect), and the
// tolerant response parser (strict JSON first, labeled lines as a fallback).

export const TITLE_GEN_TITLE_MAX_CHARS = 80;
export const TITLE_GEN_DESCRIPTION_MAX_CHARS = 240;
export const TITLE_GEN_TRANSCRIPT_MAX_CHARS = 8000;
export const TITLE_GEN_MESSAGE_MAX_CHARS = 600;
export const TITLE_GEN_MAX_TOKENS = 160;

// Conversation markers for messages that were injected internally and should
// never influence a title (self-healing retries, research summaries, synthesis
// priming, plan injections, the session-memory marker).
const INTERNAL_MESSAGE_FLAGS = [
    '_healingInjection',
    '_researchSummary',
    '_synthesisRetry',
    '_planInjection',
    '_sessionMemory',
];

export const TITLE_GEN_INSTRUCTION = `You write titles and descriptions for chat conversations.
Read the transcript below and reply with STRICT JSON ONLY — no markdown fences, no commentary:
{"title": "<short title>", "description": "<one-sentence summary>"}

Rules:
- "title": at most 60 characters, specific to the topic, without surrounding quotes or trailing punctuation.
- "description": one sentence, at most 160 characters, summarizing what the conversation covers.
- Use the same language as the conversation.`;

/** Extract displayable plain text from a message (string or content blocks). */
export function messageText(msg) {
    const content = msg?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
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

function isInternalMessage(msg) {
    return INTERNAL_MESSAGE_FLAGS.some((flag) => msg?.[flag]);
}

/**
 * Build a bounded "User: …/Assistant: …" transcript excerpt from the start of
 * the conversation (first exchanges carry the topic best).  Skips tool/system/
 * internal messages.  Returns '' when nothing displayable exists.
 */
export function buildTranscriptExcerpt(
    messages,
    {
        maxChars = TITLE_GEN_TRANSCRIPT_MAX_CHARS,
        maxMessageChars = TITLE_GEN_MESSAGE_MAX_CHARS,
    } = {},
) {
    if (!Array.isArray(messages) || messages.length === 0) return '';

    const lines = [];
    let total = 0;
    let truncated = false;
    for (const msg of messages) {
        if (!msg || isInternalMessage(msg)) continue;
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;

        let text = messageText(msg).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > maxMessageChars) {
            text = `${text.slice(0, maxMessageChars)}\u2026`;
        }

        const line = `${msg.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
        if (total + line.length + 1 > maxChars) {
            // Always keep at least a fragment of the first eligible message so
            // a single huge opening message still yields a usable excerpt.
            if (lines.length === 0) lines.push(line.slice(0, Math.max(1, maxChars)));
            truncated = true;
            break;
        }
        lines.push(line);
        total += line.length + 1;
    }

    if (lines.length === 0) return '';
    let excerpt = lines.join('\n');
    if (truncated) excerpt += '\n[The conversation continues beyond this excerpt.]';
    return excerpt;
}

/**
 * Build the messages array for `_requestNonStreamingCompletion`.
 * Returns null when there is nothing to summarize.  A single user message is
 * used deliberately: Anthropic's non-streaming builder drops system messages.
 */
export function buildTitleGenerationMessages(messages, options = {}) {
    const excerpt = buildTranscriptExcerpt(messages, options);
    if (!excerpt) return null;
    return [
        {
            role: 'user',
            content: `${TITLE_GEN_INSTRUCTION}\n\nConversation transcript:\n\n${excerpt}`,
        },
    ];
}

function sanitizeField(value, maxChars) {
    if (typeof value !== 'string') return '';
    let text = value
        .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length > maxChars) text = text.slice(0, maxChars).trim();
    return text;
}

function extractLabeledField(text, label) {
    const re = new RegExp(
        `(?:^|\\n)\\s*(?:#+\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:\\-\u2013]\\s*(.+)`,
        'i',
    );
    const match = text.match(re);
    return match ? match[1] : '';
}

/**
 * Parse a model response into `{ title, description }` (description may be '').
 * Accepts strict JSON (raw, fenced, or embedded in prose) and falls back to
 * labeled "Title: …"/"Description: …" lines.  Returns null when no usable
 * title can be recovered.
 */
export function parseTitleDescriptionResponse(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.trim();
    if (!cleaned) return null;

    // Strip a single fenced block (```json … ``` or ``` … ```).
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();

    let title = '';
    let description = '';

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                title = sanitizeField(parsed.title, TITLE_GEN_TITLE_MAX_CHARS);
                description = sanitizeField(parsed.description, TITLE_GEN_DESCRIPTION_MAX_CHARS);
            }
        } catch (_e) {
            // fall through to the labeled-line fallback
        }
    }

    if (!title) {
        title = sanitizeField(extractLabeledField(cleaned, 'title'), TITLE_GEN_TITLE_MAX_CHARS);
    }
    if (!description) {
        description = sanitizeField(
            extractLabeledField(cleaned, 'description'),
            TITLE_GEN_DESCRIPTION_MAX_CHARS,
        );
    }

    if (!title) return null;
    return { title, description };
}
