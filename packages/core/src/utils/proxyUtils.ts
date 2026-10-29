/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { Agent, type Dispatcher, EnvHttpProxyAgent } from 'undici';

/**
 * Normalizes a proxy URL to ensure it has a valid protocol prefix.
 *
 * Many proxy tools and environment variables provide proxy addresses without
 * a protocol prefix (e.g., "127.0.0.1:7860" instead of "http://127.0.0.1:7860").
 * This function adds the "http://" prefix if missing, since HTTP proxies are
 * the most common default.
 *
 * Note: Only HTTP and HTTPS proxies are supported. SOCKS proxies (socks://,
 * socks4://, socks4a://, socks5://, socks5h://) are NOT supported because the
 * underlying undici library does not support them.
 * See: https://github.com/nodejs/undici/issues/2224
 *
 * @param proxyUrl - The proxy URL to normalize
 * @returns The normalized proxy URL with protocol prefix, or undefined if input is undefined/empty
 * @throws Error if a SOCKS proxy URL is provided
 */
export function normalizeProxyUrl(
  proxyUrl: string | undefined,
): string | undefined {
  if (!proxyUrl) {
    return undefined;
  }

  const trimmed = proxyUrl.trim();
  if (!trimmed) {
    return undefined;
  }

  // Check if the URL already has a protocol prefix
  // Only support http and https protocols (undici limitation)
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Reject SOCKS proxies - undici does not support them.
  //
  // Any scheme in the socks family is matched, not just socks/socks4/socks5.
  // The `socks5h` and `socks4a` variants -- which ask the proxy to resolve
  // hostnames, and are what curl, proxychains and most tunnels emit -- were
  // missed by the narrower test, so `HTTPS_PROXY=socks5h://127.0.0.1:1080`
  // fell through to the http:// prefix below and produced
  // `http://socks5h://127.0.0.1:1080`. That parses as the host `socks5h` on
  // port 80, so the user saw an ENOTFOUND for a nonexistent host instead of
  // the actionable message this guard exists to give. A scheme starting with
  // `socks` is always a SOCKS proxy, and prefixing http:// to one is never
  // the right answer.
  if (/^socks[a-z0-9]*:\/\//i.test(trimmed)) {
    throw new Error(
      `SOCKS proxy is not supported. The underlying HTTP client (undici) only supports HTTP and HTTPS proxies. ` +
        `Please use an HTTP/HTTPS proxy instead, or set up a SOCKS-to-HTTP proxy converter. ` +
        `See: https://github.com/nodejs/undici/issues/2224`,
    );
  }

  // Add http:// prefix for proxy URLs without protocol
  // HTTP is the default for most proxy configurations
  return `http://${trimmed}`;
}

/**
 * Parse a NO_PROXY-style value into a normalized host list.
 *
 * Accepts a string (comma-, semicolon-, or whitespace-separated — corporate
 * setups use all three) or an array. Entries are trimmed, lower-cased, and
 * empty entries dropped.
 */
export function parseNoProxy(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  const parts = Array.isArray(value) ? value : value.split(/[,;\s]+/);
  return parts.map((p) => p.trim().toLowerCase()).filter(Boolean);
}

/**
 * Load extra CA certificates and combine them with the default trust store
 * (Node's bundled roots plus any `NODE_EXTRA_CA_CERTS` file) so that supplying
 * `ca` only ever *widens* trust — it never drops the defaults. Returns
 * undefined when there are no extra certs, so callers can leave undici on its
 * default secure context.
 */
export function buildCaBundle(certPaths: string[]): string[] | undefined {
  const extra = certPaths.map((p) => p.trim()).filter(Boolean);
  if (extra.length === 0) {
    return undefined;
  }
  const bundle: string[] = [...tls.rootCertificates];
  const envCa = process.env['NODE_EXTRA_CA_CERTS'];
  if (envCa) {
    try {
      bundle.push(readFileSync(envCa, 'utf8'));
    } catch {
      // NODE_EXTRA_CA_CERTS points at an unreadable file; Node already warned.
    }
  }
  for (const p of extra) {
    try {
      bundle.push(readFileSync(p, 'utf8'));
    } catch (e) {
      process.emitWarning(
        `could not read CA certificate "${p}": ${(e as Error).message}`,
        { code: 'QWEN_CA_CERT' },
      );
    }
  }
  return bundle;
}

let envHttpProxyWarningSilenced = false;

/**
 * Silence undici's one-time "EnvHttpProxyAgent is experimental" notice
 * (`process.emitWarning(..., { code: 'UNDICI-EHPA' })`). We use the agent
 * deliberately for NO_PROXY-aware routing; the warning is just startup noise
 * for anyone behind a proxy. Only that one code is dropped — all other
 * warnings pass through. Call once before constructing an EnvHttpProxyAgent.
 */
export function silenceEnvHttpProxyExperimentalWarning(): void {
  if (envHttpProxyWarningSilenced) {
    return;
  }
  envHttpProxyWarningSilenced = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const options = rest.find(
      (arg): arg is { code?: string } =>
        typeof arg === 'object' && arg !== null,
    );
    if (options?.code === 'UNDICI-EHPA') {
      return;
    }
    (original as (warning: string | Error, ...rest: unknown[]) => void)(
      warning,
      ...rest,
    );
  }) as typeof process.emitWarning;
}

/**
 * Build the global undici dispatcher from the resolved proxy configuration.
 *
 * - With a proxy URL → an `EnvHttpProxyAgent` that routes through the proxy
 *   except for hosts in `noProxy`, which connect directly. This is what lets an
 *   internal endpoint bypass a corporate proxy that can't reach it.
 * - Without a proxy but with extra CA certs → a plain `Agent` carrying the
 *   widened trust store.
 * - Otherwise → undefined (leave undici on its default global dispatcher).
 */
export function createHttpDispatcher(opts: {
  proxyUrl?: string;
  noProxy?: string[];
  caCertificates?: string[];
}): Dispatcher | undefined {
  const proxyUrl = normalizeProxyUrl(opts.proxyUrl);
  const ca = buildCaBundle(opts.caCertificates ?? []);
  const connect = ca ? { ca } : undefined;

  if (proxyUrl) {
    silenceEnvHttpProxyExperimentalWarning();
    return new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: (opts.noProxy ?? []).join(','),
      ...(connect ? { connect } : {}),
    });
  }
  if (connect) {
    return new Agent({ connect });
  }
  return undefined;
}
