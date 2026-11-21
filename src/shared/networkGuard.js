// networkGuard.js — Shared SSRF protection helpers for Katab tools
// Used by both webSearchTools.js and crawl4aiTools.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ---- IPv4 private / reserved ranges ------------------------------------------

function parseIPv4Part(part) {
    if (/^0x[0-9a-f]+$/i.test(part)) {
        return parseInt(part.slice(2), 16);
    }
    if (/^0[0-7]+$/.test(part)) {
        return parseInt(part, 8);
    }
    if (/^\d+$/.test(part)) {
        return parseInt(part, 10);
    }
    return NaN;
}

function parseCanonicalIPv4Octets(host) {
    if (!host || typeof host !== 'string') {
        return null;
    }
    const parts = host.split('.');
    if (parts.length !== 4) {
        return null;
    }
    const nums = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) {
            return null;
        }
        const n = Number(part);
        if (n < 0 || n > 255) {
            return null;
        }
        nums.push(n);
    }
    return nums;
}

/**
 * Parse canonical dotted-quad IPv4 as well as legacy POSIX inet_aton forms
 * (integer, hex, octal, 2/3-part shorthand like `127.1` or `0x7f000001`) into
 * a 4-octet array, or return null if not an IPv4 literal.
 */
function parseLegacyIPv4Octets(host) {
    if (!host || typeof host !== 'string') {
        return null;
    }
    const parts = host.split('.');
    if (parts.length < 1 || parts.length > 4) {
        return null;
    }
    // Single-part only counts as IPv4 if purely numeric or 0x-hex (not hostnames)
    if (parts.length === 1 && !/^(?:0x[0-9a-f]+|\d+)$/i.test(parts[0])) {
        return null;
    }
    const nums = parts.map(parseIPv4Part);
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
        return null;
    }
    if (nums.length === 4) {
        if (nums.some((n) => n > 255)) return null;
        return nums;
    }
    if (nums.length === 1) {
        const v = nums[0];
        if (v > 0xffffffff) return null;
        return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    }
    if (nums.length === 2) {
        if (nums[0] > 255 || nums[1] > 0xffffff) return null;
        return [nums[0], (nums[1] >>> 16) & 0xff, (nums[1] >>> 8) & 0xff, nums[1] & 0xff];
    }
    // 3 parts: a.b.c where c is 16-bit
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xffff) return null;
    return [nums[0], nums[1], (nums[2] >>> 8) & 0xff, nums[2] & 0xff];
}

function isPrivateIPv4Octets([a, b, c]) {
    if (a === 10 || a === 127 || a === 0) {
        return true;
    }
    if (a === 169 && b === 254) {
        return true; // link-local
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    }
    if (a === 192 && b === 168) {
        return true;
    }
    if (a === 100 && b >= 64 && b <= 127) {
        return true; // carrier-grade NAT
    }
    // 192.0.0.0/16 is NOT private as a whole — only the reserved /24 sub-blocks
    // 192.0.0.0/24 (IETF protocol assignments) and 192.0.2.0/24 (TEST-NET-1) are.
    // The rest of the /16 (e.g. Netlify's public edge 192.0.66.x) is routable and
    // must not be blocked or read_url silently fails on legit CDN-hosted sites.
    if (a === 192 && b === 0 && (c === 0 || c === 2)) {
        return true;
    }
    if (a === 192 && b === 88 && c === 99) {
        return true; // 6to4 relay anycast (RFC 7526)
    }
    if (a === 198 && (b === 18 || b === 19)) {
        return true; // benchmark networks
    }
    if (a === 198 && b === 51 && c === 100) {
        return true; // TEST-NET-2 (RFC 5737)
    }
    if (a === 203 && b === 0 && c === 113) {
        return true; // TEST-NET-3 (RFC 5737)
    }
    if (a >= 224) {
        return true; // multicast and reserved ranges
    }
    return false;
}

export function isPrivateIPv4(host) {
    const octets = parseCanonicalIPv4Octets(String(host || '').trim());
    if (!octets) {
        return false;
    }
    return isPrivateIPv4Octets(octets);
}

// ---- IPv6 blocked ranges -----------------------------------------------------

/**
 * Expand an IPv6 literal (with optional `%zone` suffix and optional embedded
 * dotted-quad IPv4 tail) into 8 unsigned 16-bit integer groups, or null if
 * invalid.
 */
function parseIPv6Groups(raw) {
    let value = String(raw || '')
        .trim()
        .toLowerCase();
    if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1);
    }
    // Strip optional zone identifier (e.g. fe80::1%eth0, ::1%lo)
    const zoneIdx = value.indexOf('%');
    if (zoneIdx >= 0) {
        value = value.slice(0, zoneIdx);
    }
    if (!value || !value.includes(':')) {
        return null;
    }

    // Handle embedded IPv4 suffix (e.g. ::ffff:127.0.0.1 or ::127.0.0.1)
    let ipv4Tail = null;
    const lastColon = value.lastIndexOf(':');
    const tail = value.slice(lastColon + 1);
    if (tail.includes('.')) {
        const octets = parseCanonicalIPv4Octets(tail);
        if (!octets) {
            return null;
        }
        ipv4Tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
        value = value.slice(0, lastColon);
        // Handle "::127.0.0.1" where stripping leaves ":"
        if (value === ':') {
            value = '::';
        } else if (value.endsWith(':')) {
            // e.g. "::ffff:127.0.0.1" -> "::ffff" (no trailing colon),
            // whereas "::127.0.0.1" had value=":" -> handled above.
            value = `${value}:`;
        }
    }

    const halves = value.split('::');
    if (halves.length > 2) {
        return null;
    }

    const parsePart = (part) => {
        if (!part) return [];
        const segs = part.split(':');
        const out = [];
        for (const seg of segs) {
            if (!/^[0-9a-f]{1,4}$/.test(seg)) {
                return null;
            }
            out.push(parseInt(seg, 16));
        }
        return out;
    };

    const left = parsePart(halves[0]);
    const right = halves.length === 2 ? parsePart(halves[1]) : [];
    if (!left || !right) {
        return null;
    }

    const targetLen = ipv4Tail ? 6 : 8;
    let groups;
    if (halves.length === 2) {
        const missing = targetLen - (left.length + right.length);
        if (missing < 0) {
            return null;
        }
        groups = [...left, ...new Array(missing).fill(0), ...right];
    } else {
        if (left.length !== targetLen) {
            return null;
        }
        groups = left;
    }

    if (ipv4Tail) {
        groups = [...groups, ...ipv4Tail];
    }
    return groups.length === 8 ? groups : null;
}

export function isBlockedIPv6(host) {
    const groups = parseIPv6Groups(host);
    if (!groups) {
        return false;
    }
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

    // Unspecified (::) and loopback (::1, 0:0:0:0:0:0:0:1, 0000::1)
    const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
    if (firstSixZero && g6 === 0 && (g7 === 0 || g7 === 1)) {
        return true;
    }
    // Unique local fc00::/7 (true 16-bit prefix check avoids fc::1 false positive)
    if ((g0 & 0xfe00) === 0xfc00) {
        return true;
    }
    // Link-local fe80::/10
    if ((g0 & 0xffc0) === 0xfe80) {
        return true;
    }
    // Deprecated site-local fec0::/10
    if ((g0 & 0xffc0) === 0xfec0) {
        return true;
    }
    // Multicast ff00::/8
    if ((g0 & 0xff00) === 0xff00) {
        return true;
    }

    const embeddedIPv4 = [(g6 >>> 8) & 0xff, g6 & 0xff, (g7 >>> 8) & 0xff, g7 & 0xff];

    // IPv4-mapped ::ffff:0:0/96 (covers both ::ffff:127.0.0.1 AND ::ffff:7f00:1)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
        return isPrivateIPv4Octets(embeddedIPv4);
    }
    // IPv4-translated ::ffff:0:0:0/96 (SIIT)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
        return isPrivateIPv4Octets(embeddedIPv4);
    }
    // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
    if (
        (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) ||
        (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001)
    ) {
        return isPrivateIPv4Octets(embeddedIPv4);
    }
    // Deprecated IPv4-compatible ::a.b.c.d
    if (firstSixZero && (g6 !== 0 || g7 > 1)) {
        return isPrivateIPv4Octets(embeddedIPv4);
    }

    return false;
}

// ---- Host-level check --------------------------------------------------------

export function isBlockedHost(host, allowLocal) {
    if (allowLocal) {
        return false;
    }
    if (!host) {
        return true;
    }

    let value = String(host).trim().toLowerCase();
    if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1);
    }
    // Strip trailing FQDN root dot(s) so `localhost.` / `host.local.` cannot bypass
    value = value.replace(/\.+$/, '');
    if (!value) {
        return true;
    }

    if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) {
        return true;
    }
    if (isPrivateIPv4(value)) {
        return true;
    }
    const legacyOctets = parseLegacyIPv4Octets(value);
    if (legacyOctets && isPrivateIPv4Octets(legacyOctets)) {
        return true;
    }
    if (value.includes(':') && isBlockedIPv6(value)) {
        return true;
    }

    return false;
}

// ---- URL-level validation (throws on blocked URLs) ---------------------------

export function assertFetchableUrl(rawUrl, { allowLocal = false } = {}, errorClass = null) {
    const url = (rawUrl || '').trim();
    if (!url) {
        const errMsg = 'No URL was provided.';
        if (errorClass) {
            throw new errorClass(errMsg, { code: 'no-url' });
        }
        throw new Error(errMsg);
    }

    let uri;
    try {
        uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch (_error) {
        const errMsg = `"${url}" is not a valid URL.`;
        if (errorClass) {
            throw new errorClass(errMsg, { code: 'invalid-url' });
        }
        throw new Error(errMsg);
    }

    const scheme = (uri.get_scheme() || '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
        const errMsg = 'Only http and https URLs can be used.';
        if (errorClass) {
            throw new errorClass(errMsg, { code: 'bad-scheme' });
        }
        throw new Error(errMsg);
    }

    const host = uri.get_host() || '';
    if (isBlockedHost(host, allowLocal)) {
        const errMsg = `Access to ${host || 'that address'} is blocked because it points to a private or local network. Enable local addresses in Settings if you trust it.`;
        if (errorClass) {
            throw new errorClass(errMsg, { code: 'blocked-host' });
        }
        throw new Error(errMsg);
    }

    return url;
}

// ---- URL helpers -------------------------------------------------------------

export function getUrlHost(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() || '';
    } catch (_error) {
        return '';
    }
}

export function resolveRedirectUrl(baseUrl, location) {
    const target = (location || '').trim();
    if (!target) {
        throw new Error('The page redirected without a Location header.');
    }
    try {
        return GLib.Uri.resolve_relative(baseUrl, target, GLib.UriFlags.NONE);
    } catch (_error) {
        throw new Error('The page redirected to an invalid URL.');
    }
}

// ---- Async DNS resolution ----------------------------------------------------

export function lookupHostAddresses(host, cancellable = null) {
    return new Promise((resolve, reject) => {
        try {
            const resolver = Gio.Resolver.get_default();
            resolver.lookup_by_name_async(host, cancellable, (source, result) => {
                try {
                    resolve(source.lookup_by_name_finish(result) || []);
                } catch (error) {
                    reject(error);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}
