import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';

import { createReaderStore, type ReaderStoreDependencies } from '../extensions/jiuguan-reader/src/storage.js';
import type { SavedReading } from '../extensions/jiuguan-reader/src/types.js';

const characterKey = 'Asahi.png';
const fakeHeaders = { 'x-csrf-token': 'test-only-token' };

function createHarness(hashDependencies: Pick<ReaderStoreDependencies, 'subtleCrypto' | 'loadHostSha256'> = {}) {
  const files = new Map<string, string>();
  const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  let nextUploadStatus: number | undefined;
  let nextReturnedPath: string | undefined;

  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ url, method, headers, body });

    if (method === 'GET' && url.startsWith('/user/files/')) {
      const fileName = url.slice('/user/files/'.length);
      const contents = files.get(fileName);
      return contents === undefined
        ? new Response('', { status: 404 })
        : new Response(contents, { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (method === 'POST' && url === '/api/files/upload') {
      if (nextUploadStatus !== undefined) {
        const status = nextUploadStatus;
        nextUploadStatus = undefined;
        return new Response('upload rejected', { status });
      }

      assert.ok(body, 'upload body should be JSON');
      const upload = JSON.parse(body) as { name?: unknown; data?: unknown };
      assert.equal(typeof upload.name, 'string');
      assert.equal(typeof upload.data, 'string');
      const fileName = upload.name as string;
      files.set(fileName, decodeUtf8Base64(upload.data as string));
      const path = nextReturnedPath ?? `/user/files/${fileName}`;
      nextReturnedPath = undefined;
      return new Response(JSON.stringify({ path }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fake user-files request: ${method} ${url}`);
  };

  const store = createReaderStore({
    fetcher,
    getHeaders: () => fakeHeaders,
    subtleCrypto: webcrypto.subtle,
    ...hashDependencies,
  });

  return {
    files,
    requests,
    store,
    failNextUpload(status: number) { nextUploadStatus = status; },
    returnNextUploadPath(path: string) { nextReturnedPath = path; },
    seed(fileName: string, contents: string) { files.set(fileName, contents); },
  };
}

function makeSavedReading(overrides: Partial<SavedReading> = {}): SavedReading {
  return {
    schemaVersion: 1,
    characterKey,
    characterName: 'Asahi 旭',
    fingerprint: 'fingerprint-1',
    analysis: '她曾在海边长大，后来成为星际导航员。🌌',
    chunkNotes: ['早年经历：海边成长', '成年后：成为导航员'],
    sourceCount: 1,
    chunkCount: 2,
    sources: [{ id: '[S1]', label: '角色经历', text: '她的完整经历，包含中文与 emoji 🧭。' }],
    worldbooks: ['主关联：远航世界书'],
    warnings: [],
    readAt: '2026-10-01T00:00:00.000Z',
    model: '测试模型',
    answers: [{
      id: 'answer-1',
      question: '她为什么离开故乡？',
      answer: '她想绘制更完整的星图。',
      createdAt: '2026-10-01T00:01:00.000Z',
      model: '测试模型',
    }],
    ...overrides,
  };
}

async function fileNameFor(key: string): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `jiuguan-reader-${hash}.json`;
}

function decodeUtf8Base64(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

test('load returns null for a missing per-character reading file', async () => {
  const harness = createHarness();

  assert.equal(await harness.store.load(characterKey), null);
  assert.equal(harness.requests.length, 1);
  assert.match(harness.requests[0].url, /^\/user\/files\/jiuguan-reader-[a-f0-9]{64}\.json$/u);
  assert.equal(harness.requests[0].method, 'GET');
  assert.equal(harness.requests[0].headers.get('x-csrf-token'), 'test-only-token');
});

test('HTTP-compatible hashing reads existing files and saves questions to the same character file', async () => {
  const harness = createHarness({
    subtleCrypto: null,
    loadHostSha256: async () => (bytes) => createHash('sha256').update(bytes).digest('hex'),
  });
  const record = makeSavedReading({ characterKey: '手机局域网🌟.png' });
  const fileName = await fileNameFor(record.characterKey);
  harness.seed(fileName, JSON.stringify(record));

  assert.deepEqual(await harness.store.load(record.characterKey), record);
  const updated = makeSavedReading({
    characterKey: record.characterKey,
    answers: [...record.answers, {
      id: 'http-answer', question: '重要经历是什么？', answer: '她曾在海边长大。',
      createdAt: '2026-10-01T00:02:00.000Z', model: '测试模型',
    }],
  });
  await harness.store.save(updated);
  assert.deepEqual(await harness.store.load(record.characterKey), updated);
  const upload = harness.requests.find((request) => request.method === 'POST');
  assert.equal((JSON.parse(upload?.body ?? '{}') as { name?: string }).name, fileName);
  assert.equal(harness.files.size, 1);
});

test('save and load preserve the complete UTF-8 reading and overwrite only this character file', async () => {
  const harness = createHarness();
  const first = makeSavedReading();
  const updated = makeSavedReading({
    analysis: '更新后的解读：她选择带着新的星图回到故乡。✨',
    answers: [],
    readAt: '2026-10-01T01:00:00.000Z',
  });

  await harness.store.save(first);
  await harness.store.save(updated);

  assert.deepEqual(await harness.store.load(characterKey), updated);
  const uploads = harness.requests.filter((request) => request.method === 'POST');
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].url, '/api/files/upload');
  assert.equal(uploads[0].headers.get('x-csrf-token'), 'test-only-token');
  const firstUpload = JSON.parse(uploads[0].body ?? '{}') as { name?: string };
  const secondUpload = JSON.parse(uploads[1].body ?? '{}') as { name?: string };
  assert.equal(firstUpload.name, secondUpload.name);
  assert.equal(firstUpload.name, await fileNameFor(characterKey));
  assert.equal(harness.files.size, 1);
});

test('a rejected overwrite is not reported as saved and leaves the previous reading intact', async () => {
  const harness = createHarness();
  const first = makeSavedReading();
  await harness.store.save(first);
  harness.failNextUpload(503);

  await assert.rejects(
    harness.store.save(makeSavedReading({ analysis: '本次没有成功保存的内容' })),
    /HTTP 503/u,
  );
  assert.deepEqual(await harness.store.load(characterKey), first);
});

test('load rejects malformed JSON and records belonging to another character', async () => {
  const harness = createHarness();
  const fileName = await fileNameFor(characterKey);

  harness.seed(fileName, '{not-json');
  await assert.rejects(harness.store.load(characterKey), /格式无效/u);

  harness.seed(fileName, JSON.stringify(makeSavedReading({ characterKey: 'Different.png' })));
  await assert.rejects(harness.store.load(characterKey), /角色标识不匹配/u);
});

test('save requires the user-files API to confirm the exact safe file path', async () => {
  const harness = createHarness();
  harness.returnNextUploadPath('/user/files/another-file.json');

  await assert.rejects(harness.store.save(makeSavedReading()), /无法确认的用户文件路径/u);
});
