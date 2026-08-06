import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { FetchedBytes, FetchedText } from './types.ts';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SafeFetchOptions = {
  officialDomain: string;
  accept: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  fetchImpl?: FetchImplementation;
  resolveHost?: HostResolver;
};

export class SourceCheckFetchError extends Error {
  override name = 'SourceCheckFetchError';
}

export async function safeFetchText(
  inputUrl: string,
  options: SafeFetchOptions,
): Promise<FetchedText> {
  const fetched = await safeFetchBytes(inputUrl, options);
  const text = new TextDecoder('utf-8').decode(fetched.bytes);
  if (text.trim() === '') {
    throw new SourceCheckFetchError('応答本文が空です。');
  }
  const { bytes: _bytes, ...metadata } = fetched;
  void _bytes;
  return { ...metadata, text };
}

export async function safeFetchBytes(
  inputUrl: string,
  options: SafeFetchOptions,
): Promise<FetchedBytes> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const userAgent = options.userAgent
    ?? process.env.SOURCE_CHECK_USER_AGENT
    ?? 'administrative-needs-prototype/0.1 source-check';
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = new URL(inputUrl);
  let redirectCount = 0;

  while (true) {
    await assertSafeUrl(currentUrl, options.officialDomain, resolveHost);

    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          accept: options.accept,
          'user-agent': userAgent,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SourceCheckFetchError(`HTTP取得に失敗しました: ${detail}`);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (location === null) {
        throw new SourceCheckFetchError(`HTTP ${response.status} ですが Location ヘッダーがありません。`);
      }
      if (redirectCount >= maxRedirects) {
        throw new SourceCheckFetchError(`リダイレクト回数が上限 ${maxRedirects} 回を超えました。`);
      }
      currentUrl = new URL(location, currentUrl);
      redirectCount += 1;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new SourceCheckFetchError(`HTTPステータスが成功範囲ではありません: ${response.status}`);
    }

    const declaredLength = parseContentLength(response.headers.get('content-length'));
    if (declaredLength !== null && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new SourceCheckFetchError(`応答サイズが上限 ${maxBytes} バイトを超えています。`);
    }

    const bytes = await readBytesWithLimit(response, maxBytes);
    if (bytes.byteLength === 0) {
      throw new SourceCheckFetchError('応答本文が空です。');
    }

    return {
      originalUrl: inputUrl,
      finalUrl: currentUrl.href,
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      bytes,
      responseBytes: bytes.byteLength,
      durationMs: Math.round(performance.now() - startedAt),
      redirectCount,
    };
  }
}

export async function assertSafeUrl(
  url: URL,
  officialDomain: string,
  resolveHost: HostResolver = defaultResolveHost,
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SourceCheckFetchError('URLのスキームは http または https にしてください。');
  }
  if (url.username !== '' || url.password !== '') {
    throw new SourceCheckFetchError('ユーザー名やパスワードを含むURLにはアクセスできません。');
  }
  if (!isHostnameAllowed(url.hostname, officialDomain)) {
    throw new SourceCheckFetchError(
      `アクセス先 ${url.hostname} は公式ドメイン ${officialDomain} の配下ではありません。`,
    );
  }

  const hostname = stripIpv6Brackets(url.hostname);
  if (isIP(hostname) !== 0) {
    throw new SourceCheckFetchError('IPアドレスを直接指定したURLにはアクセスできません。');
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolveHost(hostname);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SourceCheckFetchError(`ホスト名を解決できませんでした: ${detail}`);
  }
  if (addresses.length === 0) {
    throw new SourceCheckFetchError('ホスト名に対応するIPアドレスがありません。');
  }
  for (const address of addresses) {
    if (isBlockedAddress(address.address, address.family)) {
      throw new SourceCheckFetchError(`内部・予約済みIPアドレスへのアクセスを拒否しました: ${address.address}`);
    }
  }
}

export function isHostnameAllowed(hostname: string, officialDomain: string): boolean {
  const host = normalizeDomain(hostname);
  const allowed = normalizeDomain(officialDomain);
  return host === allowed || host.endsWith(`.${allowed}`);
}

export function isBlockedAddress(address: string, family: 4 | 6): boolean {
  const normalized = address.split('%', 1)[0]!;
  if (normalized.toLocaleLowerCase('en').startsWith('::ffff:')) return true;
  return BLOCKED_ADDRESSES.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

async function defaultResolveHost(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

async function readBytesWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new SourceCheckFetchError(`応答サイズが上限 ${maxBytes} バイトを超えています。`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeDomain(value: string): string {
  const withoutBrackets = stripIpv6Brackets(value.trim());
  const hostname = new URL(`http://${withoutBrackets}`).hostname;
  return stripIpv6Brackets(hostname).replace(/\.$/u, '').toLocaleLowerCase('en');
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}
