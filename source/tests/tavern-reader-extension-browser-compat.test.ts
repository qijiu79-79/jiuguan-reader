import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { createBrowserUuid, sha256Hex, type BrowserCryptoProvider } from '../extensions/jiuguan-reader/src/browser-compat.js';

const hashInputs = [
  '',
  '中文角色卡：灯塔守望者',
  '表情😀🧙🏽‍♀️与多字节文本',
  '\ud800孤立高代理\udfff',
  'a'.repeat(55),
  'a'.repeat(56),
  'a'.repeat(63),
  'a'.repeat(64),
  'a'.repeat(65),
  'card 世界书设定 🌊 '.repeat(2048),
];

function referenceHash(text: string): string {
  return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
}

test('WebCrypto and SillyTavern fallback match SHA-256 over UTF-8 bytes', async () => {
  for (const text of hashInputs) {
    const expected = referenceHash(text);
    assert.equal(await sha256Hex(text, { subtleCrypto: webcrypto.subtle }), expected);

    let receivedBytes = false;
    const fallback = await sha256Hex(text, {
      subtleCrypto: null,
      loadHostSha256: async () => (bytes) => {
        receivedBytes = bytes instanceof Uint8Array;
        assert.ok(receivedBytes, 'host hash must receive TextEncoder bytes, not the original text');
        return createHash('sha256').update(bytes).digest('hex');
      },
    });
    assert.equal(fallback, expected);
    assert.equal(receivedBytes, true);
  }
});

test('WebCrypto path does not load the host fallback', async () => {
  let fallbackLoads = 0;
  const result = await sha256Hex('只应走 WebCrypto', {
    subtleCrypto: webcrypto.subtle,
    loadHostSha256: async () => {
      fallbackLoads += 1;
      throw new Error('fallback must not be loaded');
    },
  });

  assert.equal(result, referenceHash('只应走 WebCrypto'));
  assert.equal(fallbackLoads, 0);
});

test('undefined subtle dependency uses the global WebCrypto provider', async () => {
  assert.ok(globalThis.crypto?.subtle, 'the Node 22 test runtime should expose WebCrypto');
  let fallbackLoads = 0;
  const text = '默认使用全局 WebCrypto';
  const result = await sha256Hex(text, {
    subtleCrypto: undefined,
    loadHostSha256: async () => {
      fallbackLoads += 1;
      throw new Error('fallback must not be loaded');
    },
  });

  assert.equal(result, referenceHash(text));
  assert.equal(fallbackLoads, 0);
});

test('host hash failures and invalid exports become a safe compatibility error', async (t) => {
  const expectedMessage = '当前酒馆环境无法提供兼容的 SHA-256 能力，无法可靠识别读卡资料；请刷新或更新酒馆页面后重试。';
  const cases: Array<[string, () => Promise<(bytes: Uint8Array) => string>]> = [
    ['import failure', async () => { throw new Error('sensitive implementation detail'); }],
    ['invalid digest', async () => () => 'not-a-sha256'],
    ['hash failure', async () => () => { throw new Error('sensitive implementation detail'); }],
  ];

  for (const [name, loadHostSha256] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        sha256Hex('私有角色卡内容', { subtleCrypto: null, loadHostSha256 }),
        (error: unknown) => error instanceof Error
          && error.message === expectedMessage
          && !error.message.includes('私有角色卡内容')
          && !error.message.includes('sensitive implementation detail'),
      );
    });
  }
});

test('HTTP-compatible UUID fallback uses getRandomValues and formats UUIDv4 bits', () => {
  let requestedByteArray = false;
  const provider = {
    getRandomValues: (bytes: Uint8Array): Uint8Array => {
      requestedByteArray = bytes instanceof Uint8Array && bytes.length === 16;
      bytes.fill(0xff);
      return bytes;
    },
  } as BrowserCryptoProvider;

  const uuid = createBrowserUuid(provider);
  assert.equal(requestedByteArray, true);
  assert.match(uuid, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu);
  assert.equal(uuid[14], '4');
  assert.match(uuid[19]!, /^[89ab]$/iu);
});

test('native randomUUID is preferred over getRandomValues', () => {
  const nativeUuid = 'f53b0ec4-a4cb-4dde-8ac6-1f87876a9c3c';
  let randomValueCalls = 0;
  const provider = {
    randomUUID: () => nativeUuid,
    getRandomValues: (bytes: Uint8Array): Uint8Array => {
      randomValueCalls += 1;
      return bytes;
    },
  } as BrowserCryptoProvider;

  assert.equal(createBrowserUuid(provider), nativeUuid);
  assert.equal(randomValueCalls, 0);
});

test('UUID creation fails clearly when no secure random source exists', () => {
  assert.throws(
    () => createBrowserUuid(null),
    { message: '当前浏览器没有可用的安全随机数，无法创建读卡记录编号；请更新浏览器后重试。' },
  );
});
