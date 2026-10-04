// httpBody.js — Shared capped response-body reader for Katab network tools.
//
// webSearchTools, crawl4aiTools, and ragTools all stream a response body into
// memory with a hard size cap so a hostile or pathological endpoint cannot
// exhaust RAM.  This is the single implementation; each tool keeps a thin
// wrapper so its existing return type / error contract is preserved.

import GLib from 'gi://GLib';

/** Default read granularity (64 KB), matching the tools' historical value. */
export const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read an input stream to EOF (or the cap), refusing to exceed maxBytes.
 *
 * The stream is closed on successful completion and when the cap is hit;
 * read errors propagate as rejections without closing (matching the previous
 * per-tool implementations).
 *
 * @param {Gio.InputStream} inputStream stream positioned at the body start
 * @param {object} options
 * @param {number} options.maxBytes hard cap in bytes; exceeding it rejects
 * @param {number} [options.chunkBytes] read granularity (default 64 KB)
 * @param {Gio.Cancellable|null} [options.cancellable]
 * @param {boolean} [options.asBytes] resolve a GLib.Bytes instead of a Uint8Array
 * @param {function(number): Error} [options.makeError] build the cap error; receives maxBytes
 * @returns {Promise<Uint8Array|GLib.Bytes>}
 */
export function readCappedBytes(inputStream, {
    maxBytes,
    chunkBytes = DEFAULT_READ_CHUNK_BYTES,
    cancellable = null,
    asBytes = false,
    makeError = null,
} = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;

        const combineAndResolve = () => {
            const combined = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }
            try { inputStream.close(null); } catch (_e) { /* ignore */ }
            resolve(asBytes ? new GLib.Bytes(combined) : combined);
        };

        const readNext = () => {
            inputStream.read_bytes_async(chunkBytes, GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
                try {
                    const bytes = stream.read_bytes_finish(result);
                    const data = bytes.get_data();
                    if (!data || data.length === 0) {
                        combineAndResolve();
                        return;
                    }
                    total += data.length;
                    if (total > maxBytes) {
                        try { inputStream.close(null); } catch (_e) { /* ignore */ }
                        reject(makeError
                            ? makeError(maxBytes)
                            : new Error(`The response exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB safety limit.`));
                        return;
                    }
                    chunks.push(new Uint8Array(data));
                    readNext();
                } catch (error) {
                    reject(error);
                }
            });
        };

        readNext();
    });
}
