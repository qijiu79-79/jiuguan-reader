const MODULE_URL = '/lib.js';
const SHA256_COMPATIBILITY_ERROR = '当前酒馆环境无法提供兼容的 SHA-256 能力，无法可靠识别读卡资料；请刷新或更新酒馆页面后重试。';
const UUID_COMPATIBILITY_ERROR = '当前浏览器没有可用的安全随机数，无法创建读卡记录编号；请更新浏览器后重试。';

type HostSha256 = (bytes: Uint8Array) => string;

export interface HashDependencies {
  subtleCrypto?: Pick<SubtleCrypto, 'digest'> | null;
  loadHostSha256?: () => Promise<HostSha256>;
}

export type BrowserCryptoProvider = Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>>;

/** Hash UTF-8 text with WebCrypto, or SillyTavern's same-origin hash helper on HTTP pages. */
export async function sha256Hex(text: string, dependencies: HashDependencies = {}): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(text);
    const subtle = dependencies.subtleCrypto === undefined
      ? globalThis.crypto?.subtle
      : dependencies.subtleCrypto;
    if (subtle) {
      const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
      if (digest.length !== 32) throw new Error('Invalid SHA-256 digest length');
      return bytesToHex(digest);
    }

    const hash = await (dependencies.loadHostSha256 ?? loadHostSha256)();
    const result = hash(bytes);
    if (typeof result !== 'string' || !/^[\da-f]{64}$/iu.test(result)) {
      throw new Error('Invalid SHA-256 result');
    }
    return result.toLowerCase();
  } catch {
    throw new Error(SHA256_COMPATIBILITY_ERROR);
  }
}

/** Create a v4 UUID using native randomUUID or the secure getRandomValues fallback. */
export function createBrowserUuid(cryptoProvider: BrowserCryptoProvider | null = globalThis.crypto): string {
  if (typeof cryptoProvider?.randomUUID === 'function') {
    try {
      return cryptoProvider.randomUUID();
    } catch {
      // Some runtimes expose randomUUID but reject it outside a secure context; try getRandomValues.
    }
  }

  if (typeof cryptoProvider?.getRandomValues !== 'function') {
    throw new Error(UUID_COMPATIBILITY_ERROR);
  }

  try {
    const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
    if (bytes.length !== 16) throw new Error('Invalid random byte count');
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    throw new Error(UUID_COMPATIBILITY_ERROR);
  }
}

async function loadHostSha256(): Promise<HostSha256> {
  const hostLibrary = await import(/* @vite-ignore */ MODULE_URL) as { sha256?: unknown };
  if (typeof hostLibrary.sha256 !== 'function') throw new Error('SillyTavern does not export sha256');
  return hostLibrary.sha256 as HostSha256;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
