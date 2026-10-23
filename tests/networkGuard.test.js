// networkGuard.test.js — Tests for SSRF protection helpers
import {
    isPrivateIPv4,
    isBlockedIPv6,
    isBlockedHost,
    assertFetchableUrl,
    getUrlHost,
    resolveRedirectUrl,
    lookupHostAddresses,
} from '../src/shared/networkGuard.js';
import { assert, assertEqual, assertThrows, runTests } from './testUtils.js';

class TestToolError extends Error {
    constructor(message, { code = '' } = {}) {
        super(message);
        this.code = code;
    }
}

function captureError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}

const tests = [
    // ── isPrivateIPv4 ──────────────────────────────────────────────────────

    [
        'isPrivateIPv4: 10.0.0.0/8',
        () => {
            assert(isPrivateIPv4('10.0.0.1'), '10.0.0.1');
            assert(isPrivateIPv4('10.255.255.255'), '10.255.255.255');
            assert(!isPrivateIPv4('11.0.0.1'), '11.0.0.1 is public');
        },
    ],

    [
        'isPrivateIPv4: 127.0.0.0/8 (loopback)',
        () => {
            assert(isPrivateIPv4('127.0.0.1'), 'loopback');
            assert(isPrivateIPv4('127.255.255.255'), 'loopback end');
        },
    ],

    [
        'isPrivateIPv4: 0.0.0.0/8',
        () => {
            assert(isPrivateIPv4('0.0.0.0'), 'zero address');
            assert(isPrivateIPv4('0.255.255.255'), 'zero range end');
        },
    ],

    [
        'isPrivateIPv4: 169.254.0.0/16 (link-local)',
        () => {
            assert(isPrivateIPv4('169.254.0.1'), 'link-local start');
            assert(isPrivateIPv4('169.254.255.254'), 'link-local end');
            assert(!isPrivateIPv4('169.255.0.1'), 'just outside link-local');
        },
    ],

    [
        'isPrivateIPv4: 172.16.0.0/12',
        () => {
            assert(isPrivateIPv4('172.16.0.1'), '172.16 start');
            assert(isPrivateIPv4('172.31.255.255'), '172.31 end');
            assert(!isPrivateIPv4('172.15.0.1'), '172.15 outside');
            assert(!isPrivateIPv4('172.32.0.1'), '172.32 outside');
        },
    ],

    [
        'isPrivateIPv4: 192.168.0.0/16',
        () => {
            assert(isPrivateIPv4('192.168.0.1'), '192.168 start');
            assert(isPrivateIPv4('192.168.255.255'), '192.168 end');
            assert(!isPrivateIPv4('192.169.0.1'), '192.169 outside');
        },
    ],

    [
        'isPrivateIPv4: 100.64.0.0/10 (CGNAT)',
        () => {
            assert(isPrivateIPv4('100.64.0.1'), 'CGNAT start');
            assert(isPrivateIPv4('100.127.255.255'), 'CGNAT end');
            assert(!isPrivateIPv4('100.63.0.1'), 'just below CGNAT');
            assert(!isPrivateIPv4('100.128.0.1'), 'just above CGNAT');
        },
    ],

    [
        'isPrivateIPv4: 192.0.0.0/24 + 192.0.2.0/24 (reserved only)',
        () => {
            assert(isPrivateIPv4('192.0.0.1'), 'IETF protocol assignments');
            assert(isPrivateIPv4('192.0.0.255'), 'IETF protocol assignments end');
            assert(isPrivateIPv4('192.0.2.1'), 'TEST-NET-1 start');
            assert(isPrivateIPv4('192.0.2.254'), 'TEST-NET-1 end');
            // 192.0.0.0/16 is NOT private as a whole — only the /24 sub-blocks are
            // reserved. Public CDN space (e.g. Netlify 192.0.66.x) must NOT be blocked,
            // otherwise read_url silently fails on legitimately hosted pages.
            assert(!isPrivateIPv4('192.0.1.1'), '192.0.1.x is public');
            assert(!isPrivateIPv4('192.0.66.60'), 'Netlify public CDN must not be blocked');
            assert(!isPrivateIPv4('192.0.255.1'), '192.0.255.x is public');
            assert(!isPrivateIPv4('192.1.0.1'), 'outside 192.0 range');
        },
    ],

    [
        'isPrivateIPv4: 198.18-19.0.0/15 (benchmark)',
        () => {
            assert(isPrivateIPv4('198.18.0.1'), 'benchmark start');
            assert(isPrivateIPv4('198.19.255.255'), 'benchmark end');
            assert(!isPrivateIPv4('198.17.0.1'), 'outside benchmark');
        },
    ],

    [
        'isPrivateIPv4: multicast & reserved (>=224)',
        () => {
            assert(isPrivateIPv4('224.0.0.1'), 'multicast start');
            assert(isPrivateIPv4('239.255.255.255'), 'multicast end');
            assert(isPrivateIPv4('240.0.0.1'), 'reserved');
            assert(isPrivateIPv4('255.255.255.255'), 'broadcast');
        },
    ],

    [
        'isPrivateIPv4: public IPs',
        () => {
            assert(!isPrivateIPv4('8.8.8.8'), 'Google DNS');
            assert(!isPrivateIPv4('1.1.1.1'), 'Cloudflare DNS');
            assert(!isPrivateIPv4('151.101.1.140'), 'Fastly');
            assert(!isPrivateIPv4('208.67.222.222'), 'OpenDNS');
        },
    ],

    [
        'isPrivateIPv4: invalid / non-IPv4 strings',
        () => {
            assert(!isPrivateIPv4('not-an-ip'), 'non-IP string');
            assert(!isPrivateIPv4(''), 'empty');
            assert(!isPrivateIPv4('256.0.0.1'), 'octet >255');
            assert(!isPrivateIPv4('10.0.0'), 'three octets');
            assert(!isPrivateIPv4('::1'), 'IPv6');
        },
    ],

    // ── isBlockedIPv6 ──────────────────────────────────────────────────────

    [
        'isBlockedIPv6: loopback',
        () => {
            assert(isBlockedIPv6('::1'), 'loopback');
            assert(isBlockedIPv6('::'), 'unspecified');
        },
    ],

    [
        'isBlockedIPv6: unique local (fc00::/7)',
        () => {
            assert(isBlockedIPv6('fc00::1'), 'fc prefix');
            assert(isBlockedIPv6('fd00::1'), 'fd prefix');
            assert(isBlockedIPv6('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), 'fd end');
        },
    ],

    [
        'isBlockedIPv6: link-local (fe80::/10)',
        () => {
            assert(isBlockedIPv6('fe80::1'), 'fe80 start');
            assert(isBlockedIPv6('fe90::1'), 'fe90');
            assert(isBlockedIPv6('fea0::1'), 'fea0');
            assert(isBlockedIPv6('feb0::1'), 'feb0 end');
        },
    ],

    [
        'isBlockedIPv6: IPv4-mapped (::ffff:x.x.x.x)',
        () => {
            assert(isBlockedIPv6('::ffff:127.0.0.1'), 'mapped loopback');
            assert(isBlockedIPv6('::ffff:192.168.1.1'), 'mapped private');
            assert(!isBlockedIPv6('::ffff:8.8.8.8'), 'mapped public');
        },
    ],

    [
        'isBlockedIPv6: public IPv6',
        () => {
            assert(!isBlockedIPv6('2001:db8::1'), 'documentation prefix');
            assert(!isBlockedIPv6('2606:4700::1111'), 'Cloudflare');
            assert(!isBlockedIPv6('2a00:1450:4001:802::200e'), 'Google');
        },
    ],

    // ── isBlockedHost ──────────────────────────────────────────────────────

    [
        'isBlockedHost: localhost variants',
        () => {
            assert(isBlockedHost('localhost', false), 'localhost');
            assert(isBlockedHost('foo.localhost', false), 'subdomain of localhost');
            assert(isBlockedHost('myapp.local', false), '.local TLD');
        },
    ],

    [
        'isBlockedHost: private IPv4 as hostname',
        () => {
            assert(isBlockedHost('127.0.0.1', false), 'loopback');
            assert(isBlockedHost('192.168.1.1', false), 'private');
            assert(!isBlockedHost('8.8.8.8', false), 'public');
        },
    ],

    [
        'isBlockedHost: IPv6 as hostname',
        () => {
            assert(isBlockedHost('::1', false), 'IPv6 loopback');
            assert(isBlockedHost('fe80::1', false), 'IPv6 link-local');
            assert(!isBlockedHost('2001:db8::1', false), 'public IPv6');
        },
    ],

    [
        'isBlockedHost: bracketed IPv6',
        () => {
            assert(isBlockedHost('[::1]', false), 'bracketed loopback');
            assert(!isBlockedHost('[2001:db8::1]', false), 'bracketed public');
        },
    ],

    [
        'isBlockedHost: allowLocal bypasses all checks',
        () => {
            assert(!isBlockedHost('localhost', true), 'localhost allowed');
            assert(!isBlockedHost('127.0.0.1', true), 'loopback allowed');
            assert(!isBlockedHost('::1', true), 'IPv6 loopback allowed');
            assert(!isBlockedHost('192.168.1.1', true), 'private allowed');
        },
    ],

    [
        'isBlockedHost: public hostnames pass',
        () => {
            assert(!isBlockedHost('example.com', false), 'example.com');
            assert(!isBlockedHost('api.openai.com', false), 'api.openai.com');
            assert(!isBlockedHost('google.com', false), 'google.com');
        },
    ],

    [
        'isBlockedHost: empty/null host',
        () => {
            assert(isBlockedHost('', false), 'empty string');
            assert(isBlockedHost(null, false), 'null');
            assert(isBlockedHost(undefined, false), 'undefined');
        },
    ],

    // ── assertFetchableUrl ─────────────────────────────────────────────────

    [
        'assertFetchableUrl: accepts http/https and returns the trimmed URL',
        () => {
            assertEqual(
                assertFetchableUrl('  https://example.com/a?b=1  '),
                'https://example.com/a?b=1',
                'https trimmed, URL preserved',
            );
            assertEqual(
                assertFetchableUrl('http://example.com'),
                'http://example.com',
                'http allowed',
            );
        },
    ],

    [
        'assertFetchableUrl: rejects empty input with no-url',
        () => {
            for (const value of ['', '   ', null, undefined]) {
                const error = captureError(() => assertFetchableUrl(value, {}, TestToolError));
                assert(error, `rejects ${JSON.stringify(value)}`);
                assertEqual(error.code, 'no-url', 'no-url code');
            }
        },
    ],

    [
        'assertFetchableUrl: rejects unparsable URLs with invalid-url',
        () => {
            assertThrows(() => assertFetchableUrl('not a url'), 'is not a valid URL');
            const error = captureError(() =>
                assertFetchableUrl('//example.com', {}, TestToolError),
            );
            assertEqual(error?.code, 'invalid-url', 'invalid-url code');
        },
    ],

    [
        'assertFetchableUrl: rejects non-http(s) schemes with bad-scheme',
        () => {
            for (const url of [
                'ftp://example.com/x',
                'file:///etc/passwd',
                'javascript:alert(1)',
                'mailto:someone@example.com',
            ]) {
                assertThrows(() => assertFetchableUrl(url), 'Only http and https', url);
            }
            const error = captureError(() =>
                assertFetchableUrl('ftp://example.com', {}, TestToolError),
            );
            assertEqual(error?.code, 'bad-scheme', 'bad-scheme code');
        },
    ],

    [
        'assertFetchableUrl: blocks private, loopback, and link-local hosts',
        () => {
            for (const url of [
                'http://localhost/',
                'http://app.localhost/',
                'http://printer.local/',
                'http://10.1.2.3/',
                'http://192.168.1.1/',
                'http://127.0.0.1:8080/',
                'http://169.254.169.254/latest/meta-data/',
                'http://[::1]/',
                'http://[fd00::1]/',
                'http://',
            ]) {
                assertThrows(
                    () => assertFetchableUrl(url),
                    'blocked because it points to a private or local network',
                    url,
                );
            }
            const error = captureError(() =>
                assertFetchableUrl('http://10.0.0.1', {}, TestToolError),
            );
            assertEqual(error?.code, 'blocked-host', 'blocked-host code');
        },
    ],

    [
        'assertFetchableUrl: allowLocal bypasses host blocking only',
        () => {
            assertEqual(
                assertFetchableUrl('http://127.0.0.1:11434/api', { allowLocal: true }),
                'http://127.0.0.1:11434/api',
                'loopback allowed',
            );
            assertThrows(
                () => assertFetchableUrl('ftp://127.0.0.1', { allowLocal: true }),
                'Only http and https',
                'scheme still enforced',
            );
        },
    ],

    [
        'assertFetchableUrl: does not mistake public hosts for private ones',
        () => {
            for (const url of [
                'https://example.com/',
                'https://192.0.66.5/',
                'https://172.32.0.1/',
                'https://198.20.0.1/',
            ]) {
                assertEqual(assertFetchableUrl(url), url, url);
            }
        },
    ],

    // ── getUrlHost ─────────────────────────────────────────────────────────

    [
        'getUrlHost: extracts the host and tolerates junk input',
        () => {
            assertEqual(getUrlHost('https://example.com/a/b'), 'example.com', 'plain host');
            assertEqual(
                getUrlHost('https://user:pw@example.com:8443/a'),
                'example.com',
                'credentials and port stripped',
            );
            assertEqual(getUrlHost('http://[::1]/'), '::1', 'IPv6 host');
            assertEqual(getUrlHost('http://'), '', 'empty host');
            assertEqual(getUrlHost('not a url'), '', 'unparsable → empty');
            assertEqual(getUrlHost(''), '', 'empty string → empty');
            assertEqual(getUrlHost(null), '', 'null → empty');
        },
    ],

    // ── resolveRedirectUrl ─────────────────────────────────────────────────

    [
        'resolveRedirectUrl: resolves relative, root-relative, and absolute targets',
        () => {
            const base = 'https://example.com/dir/page';
            assertEqual(resolveRedirectUrl(base, 'next?q=1'), 'https://example.com/dir/next?q=1');
            assertEqual(resolveRedirectUrl(base, '/root'), 'https://example.com/root');
            assertEqual(
                resolveRedirectUrl(base, 'https://other.example/x'),
                'https://other.example/x',
            );
        },
    ],

    [
        'resolveRedirectUrl: rejects a missing or blank Location',
        () => {
            const base = 'https://example.com/dir/page';
            assertThrows(() => resolveRedirectUrl(base, ''), 'without a Location');
            assertThrows(() => resolveRedirectUrl(base, '   '), 'without a Location');
            assertThrows(() => resolveRedirectUrl(base, null), 'without a Location');
        },
    ],

    [
        'resolveRedirectUrl: rejects malformed targets',
        () => {
            const base = 'https://example.com/dir/page';
            assertThrows(() => resolveRedirectUrl(base, 'http://['), 'invalid URL');
            assertThrows(() => resolveRedirectUrl(base, 'http://%zz'), 'invalid URL');
        },
    ],

    // ── lookupHostAddresses ────────────────────────────────────────────────

    [
        'lookupHostAddresses: resolves localhost to loopback',
        async () => {
            const addresses = await lookupHostAddresses('localhost');
            const texts = addresses.map((address) => address.to_string());
            assert(texts.length > 0, 'at least one address');
            assert(
                texts.some((text) => text === '127.0.0.1' || text === '::1'),
                `loopback present: ${texts.join(', ')}`,
            );
        },
    ],

    [
        'lookupHostAddresses: rejects an unresolvable host',
        async () => {
            let error = null;
            try {
                await lookupHostAddresses('does-not-exist.invalid');
            } catch (caught) {
                error = caught;
            }
            assert(error, 'resolution failure rejects');
        },
    ],
];

await runTests(tests);
