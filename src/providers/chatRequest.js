// chatRequest.js — Pure pieces of the streaming (chat) request dialects.
//
// This module will grow into the full per-provider streaming request builders.
// It starts with the Ollama sampling/context option construction — the most
// intricate pure logic in _streamResponse: null pruning plus the
// `repeat_last_n = -1` sentinel translation that newer Ollama releases require.

/**
 * Build the Ollama `options` object from a settings getter.
 *
 * @param {(prop: string, type: 'int'|'double'|'boolean') => (number|boolean|null)} getOpt
 *        reads `ollama-<prop>` with the given type; returns null when unset.
 * @returns {object} options with null/undefined entries removed and the
 *          repeat_last_n sentinel translated.
 */
export function buildOllamaOptions(getOpt) {
    const options = {
        temperature: getOpt('temperature', 'double'),
        num_ctx: getOpt('num-ctx', 'int'),
        num_predict: getOpt('num-predict', 'int'),
        num_keep: getOpt('num-keep', 'int'),
        use_mmap: getOpt('use-mmap', 'boolean'),
        use_mlock: getOpt('use-mlock', 'boolean'),
        num_gpu: getOpt('num-gpu', 'int'),
        num_thread: getOpt('num-thread', 'int'),
        top_k: getOpt('top-k', 'int'),
        top_p: getOpt('top-p', 'double'),
        min_p: getOpt('min-p', 'double'),
        tfs_z: getOpt('tfs-z', 'double'),
        mirostat: getOpt('mirostat', 'int'),
        mirostat_tau: getOpt('mirostat-tau', 'double'),
        mirostat_eta: getOpt('mirostat-eta', 'double'),
        repeat_last_n: getOpt('repeat-last-n', 'int'),
        repeat_penalty: getOpt('repeat-penalty', 'double'),
        presence_penalty: getOpt('presence-penalty', 'double'),
        frequency_penalty: getOpt('frequency-penalty', 'double'),
    };

    // Remove nulls just in case, though GSettings should provide defaults
    Object.keys(options).forEach(key => {
        if (options[key] === null || options[key] === undefined) {
            delete options[key];
        }
    });

    // Newer Ollama releases (via llama.cpp) reject repeat_last_n = -1 with
    // HTTP 400: "Value must be between 0 <= value <= 2147483647, but got -1".
    // -1 historically meant "scan the full active context", so translate it
    // to num_ctx to preserve that behavior without tripping the validation.
    if (options.repeat_last_n === -1) {
        options.repeat_last_n = (typeof options.num_ctx === 'number' && options.num_ctx > 0)
            ? options.num_ctx
            : 64;
    }

    return options;
}

/**
 * Normalize the Ollama keep_alive setting to a duration string with a unit.
 * The API rejects a bare "-1"; convert it to the indefinite equivalent.
 *
 * @param {string} keepAlive raw `ollama-keep-alive` value
 * @returns {string} e.g. '5m' or '999999h'
 */
export function normalizeOllamaKeepAlive(keepAlive) {
    if (!keepAlive || keepAlive === '-1') {
        return '999999h';
    }
    return keepAlive;
}
