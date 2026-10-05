import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaderUpdater, READER_EXTENSION_VERSION, type ExtensionUpdateState } from '../extensions/jiuguan-reader/src/updater.js';
import manifest from '../extensions/jiuguan-reader/manifest.json';

const MODULE_URL = 'http://127.0.0.1:12345/scripts/extensions/third-party/jiuguan-reader/index.js';
const REPOSITORY = 'https://github.com/qijiu79-79/jiuguan-reader';
const COMMIT = 'a'.repeat(40);

interface RequestLog { endpoint: string; options: RequestInit; }

function fixture(options: {
  type?: 'local' | 'global';
  discover?: unknown;
  version?: Record<string, unknown>;
  result?: Record<string, unknown>;
  failure?: { endpoint: string; status: number };
  moduleUrl?: string;
} = {}) {
  const requests: RequestLog[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const endpoint = String(input);
    requests.push({ endpoint, options: init });
    if (options.failure?.endpoint === endpoint) return new Response('SERVER_PRIVATE_PATH_AND_SECRET', { status: options.failure.status });
    const value = endpoint === '/api/extensions/discover'
      ? options.discover ?? [{ name: 'third-party/jiuguan-reader', type: options.type ?? 'local' }]
      : endpoint === '/api/extensions/version'
        ? { currentBranchName: 'main', currentCommitHash: COMMIT, isUpToDate: false, remoteUrl: REPOSITORY, ...options.version }
        : { shortCommitHash: 'bbbbbbb', isUpToDate: false, remoteUrl: REPOSITORY, ...options.result };
    return Response.json(value);
  }) as typeof fetch;
  const updater = new ReaderUpdater({
    getHeaders: () => ({ 'X-CSRF-Token': 'fake-csrf-for-tests' }),
    fetcher,
    moduleUrl: options.moduleUrl ?? MODULE_URL,
  });
  return { updater, requests, fetcher };
}

test('更新界面的版本与安装 manifest 一致', () => {
  assert.equal(READER_EXTENSION_VERSION, manifest.version);
  assert.equal(manifest.homePage, REPOSITORY);
});

test('只检查时发现更新但不下载、不刷新或调用 AI', async () => {
  const { updater, requests } = fixture();
  const phases: ExtensionUpdateState['phase'][] = [];
  updater.subscribe((state) => phases.push(state.phase));
  assert.equal(requests.length, 0, '打开或订阅不能自动联网');
  await updater.check();
  assert.deepEqual(phases, ['idle', 'checking', 'available']);
  assert.deepEqual(requests.map((request) => request.endpoint), ['/api/extensions/discover', '/api/extensions/version']);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[1].options.body)), { extensionName: 'jiuguan-reader', global: false });
  assert.match(updater.getState().message, /没有下载或刷新/u);
  assert.ok(requests.every((request) => request.endpoint !== '/api/extensions/update'));
});

test('只检查时识别最新版本，不发起下载请求', async () => {
  const { updater, requests } = fixture({ version: { isUpToDate: true } });
  await updater.check();
  assert.equal(updater.getState().phase, 'current');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.endpoint !== '/api/extensions/update'));
});

for (const type of ['local', 'global'] as const) {
  test(`${type} 安装通过酒馆接口检查来源并更新，不碰卡片或设置`, async () => {
    const { updater, requests } = fixture({ type });
    const phases: ExtensionUpdateState['phase'][] = [];
    updater.subscribe((state) => phases.push(state.phase));
    assert.equal(requests.length, 0, '打开或订阅不能自动联网');
    await updater.update();
    assert.deepEqual(phases, ['idle', 'checking', 'updating', 'updated']);
    assert.deepEqual(requests.map((request) => request.endpoint), ['/api/extensions/discover', '/api/extensions/version', '/api/extensions/update']);
    assert.equal(requests[0].options.method, 'GET');
    for (const request of requests.slice(1)) {
      assert.equal(request.options.method, 'POST');
      assert.deepEqual(JSON.parse(String(request.options.body)), { extensionName: 'jiuguan-reader', global: type === 'global' });
    }
    for (const request of requests) {
      assert.equal(request.options.credentials, 'same-origin');
      assert.equal(new Headers(request.options.headers).get('X-CSRF-Token'), 'fake-csrf-for-tests');
      assert.ok(request.options.signal);
    }
    assert.match(updater.getState().message, /安全时机自动刷新/u);
  });
}

test('最新版本不发送更新写请求', async () => {
  const { updater, requests } = fixture({ version: { isUpToDate: true } });
  await updater.update();
  assert.equal(updater.getState().phase, 'current');
  assert.equal(requests.length, 2);
});

test('已下载但未刷新时再次检查仍提醒应用更新，且不会重复下载', async () => {
  const version = { isUpToDate: false };
  const { updater, requests } = fixture({ version });
  await updater.update();
  version.isUpToDate = true;
  await updater.check();
  assert.equal(updater.getState().phase, 'updated');
  assert.match(updater.getState().message, /尚未应用/u);
  assert.equal(requests.filter((request) => request.endpoint === '/api/extensions/update').length, 1);
});

test('先检查再下载时保留检查时的 commit 基线，后续检查提示刷新', async () => {
  const version = { isUpToDate: false, currentCommitHash: COMMIT };
  const { updater, requests } = fixture({ version });
  await updater.check();
  assert.equal(updater.getState().phase, 'available');
  await updater.update();
  assert.equal(updater.getState().phase, 'updated');
  version.currentCommitHash = 'b'.repeat(40);
  version.isUpToDate = true;
  await updater.check();
  assert.equal(updater.getState().phase, 'updated');
  assert.match(updater.getState().message, /当前页面仍运行旧版本/u);
  assert.equal(requests.filter((request) => request.endpoint === '/api/extensions/update').length, 1);
});

test('并发点击只启动一个检查和更新任务', async () => {
  const { updater, requests } = fixture();
  await Promise.all([updater.update(), updater.update(), updater.update()]);
  assert.equal(requests.length, 3);
  assert.equal(updater.getState().phase, 'updated');
});

test('并发只检查调用共享同一个请求', async () => {
  const { updater, requests } = fixture();
  await Promise.all([updater.check(), updater.check(), updater.check()]);
  assert.equal(requests.length, 2);
  assert.equal(updater.getState().phase, 'available');
});

test('检查状态监听器同步重入时仍只运行一份检查', async () => {
  const { updater, requests } = fixture();
  let nestedCheck: Promise<void> | undefined;
  updater.subscribe((state) => {
    if (state.phase === 'checking' && !nestedCheck) nestedCheck = updater.check();
  });
  await updater.check();
  await nestedCheck;
  assert.equal(requests.length, 2);
});

test('下载按钮在检查进行中点击时排队执行，不与检查并发', async () => {
  const { fetcher: baseFetcher, requests } = fixture();
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const updater = new ReaderUpdater({
    getHeaders: () => ({ 'X-CSRF-Token': 'fake-csrf-for-tests' }),
    moduleUrl: MODULE_URL,
    fetcher: (async (input, init) => {
      if (String(input) === '/api/extensions/discover' && requests.length === 0) {
        markStarted();
        await gate;
      }
      return baseFetcher(input, init);
    }) as typeof fetch,
  });
  const checking = updater.check();
  await started;
  const updating = updater.update();
  release();
  await Promise.all([checking, updating]);
  assert.deepEqual(requests.map((request) => request.endpoint), [
    '/api/extensions/discover', '/api/extensions/version',
    '/api/extensions/discover', '/api/extensions/version', '/api/extensions/update',
  ]);
  assert.equal(requests.filter((request) => request.endpoint === '/api/extensions/update').length, 1);
  assert.equal(updater.getState().phase, 'updated');
});

test('SSH 安装来源可以正确识别，仍只调用同源接口', async () => {
  const { updater, requests } = fixture({ version: { remoteUrl: 'git@github.com:qijiu79-79/jiuguan-reader.git' } });
  await updater.update();
  assert.equal(updater.getState().phase, 'updated');
  assert.ok(requests.every((request) => request.endpoint.startsWith('/api/extensions/')));
});

test('没有 Git 的 ZIP 安装明确提示改用仓库，而非误报最新', async () => {
  const { updater, requests } = fixture({ version: { currentBranchName: '', currentCommitHash: '', remoteUrl: '', isUpToDate: true } });
  await updater.update();
  assert.equal(updater.getState().phase, 'error');
  assert.match(updater.getState().message, /ZIP/u);
  assert.equal(requests.length, 2);
});

test('只检查遇到 ZIP 安装时给出来源提示且不下载', async () => {
  const { updater, requests } = fixture({ version: { currentBranchName: '', currentCommitHash: '', remoteUrl: '', isUpToDate: true } });
  await updater.check();
  assert.equal(updater.getState().phase, 'error');
  assert.match(updater.getState().message, /ZIP/u);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.endpoint !== '/api/extensions/update'));
});

for (const remoteUrl of [
  'https://github.com/other/jiuguan-reader',
  'https://github.com/qijiu79-79/jiuguan-reader-fork',
  'https://github.com.evil.example/qijiu79-79/jiuguan-reader',
  'https://example.invalid/qijiu79-79/jiuguan-reader',
  'https://private-token@github.com/qijiu79-79/jiuguan-reader',
  'https://github.com/qijiu79-79/jiuguan-reader?token=private-token',
]) {
  test(`非发布来源不会更新：${remoteUrl.replace(/private-token/gu, '[redacted]')}`, async () => {
    const { updater, requests } = fixture({ version: { remoteUrl } });
    await updater.update();
    assert.equal(updater.getState().phase, 'error');
    assert.equal(requests.length, 2);
    assert.match(updater.getState().message, /来源/u);
    assert.ok(!updater.getState().message.includes(remoteUrl));
  });
}

for (const discover of [[], {}, [{ name: 'third-party/jiuguan-reader', type: 'system' }], [
  { name: 'third-party/jiuguan-reader', type: 'global' }, { name: 'third-party/jiuguan-reader', type: 'local' },
]]) {
  test(`安装类型不能安全确认时不猜测或更新：${JSON.stringify(discover)}`, async () => {
    const { updater, requests } = fixture({ discover });
    await updater.update();
    assert.equal(updater.getState().phase, 'error');
    assert.equal(requests.length, 1);
  });
}

for (const version of [{ isUpToDate: 'false' }, { currentCommitHash: 'bad hash' }, { currentBranchName: '' }]) {
  test(`版本响应不完整时不更新：${JSON.stringify(version)}`, async () => {
    const { updater, requests } = fixture({ version });
    await updater.update();
    assert.equal(updater.getState().phase, 'error');
    assert.equal(requests.length, 2);
  });
}

for (const [status, message] of [[401, /登录/u], [403, /管理员/u], [404, /未找到/u], [500, /500/u]] as const) {
  test(`更新返回 ${status} 时显示中文错误，不暴露服务端正文`, async () => {
    const { updater } = fixture({ failure: { endpoint: '/api/extensions/update', status } });
    await updater.update();
    assert.equal(updater.getState().phase, 'error');
    assert.match(updater.getState().message, message);
    assert.ok(!updater.getState().message.includes('SERVER_PRIVATE_PATH_AND_SECRET'));
  });
}

test('无效更新响应不声称成功或自动刷新', async () => {
  const { updater } = fixture({ result: { shortCommitHash: '<script>bad</script>' } });
  await updater.update();
  assert.equal(updater.getState().phase, 'error');
  assert.match(updater.getState().message, /核对/u);
});

test('检查期间权限或网络失败不会发起更新', async () => {
  const { updater, requests } = fixture({ failure: { endpoint: '/api/extensions/version', status: 503 } });
  await updater.update();
  assert.equal(updater.getState().phase, 'error');
  assert.equal(requests.length, 2);
});

test('只检查期间权限失败显示酒馆错误且不发起更新', async () => {
  const { updater, requests } = fixture({ failure: { endpoint: '/api/extensions/version', status: 403 } });
  await updater.check();
  assert.equal(updater.getState().phase, 'error');
  assert.match(updater.getState().message, /管理员/u);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.endpoint !== '/api/extensions/update'));
});

test('无法解析自己的安装路径时不联网', async () => {
  const { updater, requests } = fixture({ moduleUrl: 'file:///tmp/private-file.ts' });
  await updater.update();
  assert.equal(updater.getState().phase, 'error');
  assert.equal(requests.length, 0);
});

test('超时后可重试，并提示服务器可能仍在处理', async () => {
  let timeout = true;
  const { fetcher: healthyFetcher } = fixture();
  const updater = new ReaderUpdater({
    getHeaders: () => ({}), moduleUrl: MODULE_URL, requestTimeoutMs: 5,
    fetcher: (async (input, init) => {
      if (!timeout) return healthyFetcher(input, init);
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('FAKE_SECRET')), { once: true }));
    }) as typeof fetch,
  });
  await updater.update();
  assert.equal(updater.getState().phase, 'error');
  assert.match(updater.getState().message, /服务器可能仍在处理/u);
  assert.ok(!updater.getState().message.includes('FAKE_SECRET'));
  timeout = false;
  await updater.update();
  assert.equal(updater.getState().phase, 'updated', '同一个更新器在超时后可成功重试');
});

test('订阅解除后不再通知', async () => {
  const { updater } = fixture();
  let calls = 0;
  const unsubscribe = updater.subscribe(() => { calls += 1; });
  unsubscribe();
  await updater.update();
  assert.equal(calls, 1);
});

test('下载超时后只检查、不重复拉取；后台已完成时显示待刷新', async () => {
  const version = { isUpToDate: false, currentCommitHash: COMMIT };
  const { fetcher: healthyFetcher, requests } = fixture({ version });
  let writeRequests = 0;
  const updater = new ReaderUpdater({
    getHeaders: () => ({}), moduleUrl: MODULE_URL, requestTimeoutMs: 5,
    fetcher: (async (input, init) => {
      if (String(input) !== '/api/extensions/update') return healthyFetcher(input, init);
      writeRequests += 1;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('fake dropped request')), { once: true }));
    }) as typeof fetch,
  });
  await updater.update();
  assert.equal(updater.getState().phase, 'error');
  assert.match(updater.getState().message, /超时/u);
  await updater.check();
  assert.equal(writeRequests, 1, '超时不能被当作服务器取消，不再次发起 pull');
  assert.equal(updater.getState().phase, 'error');
  assert.match(updater.getState().message, /只核对状态/u);
  version.currentCommitHash = 'b'.repeat(40);
  version.isUpToDate = true;
  await updater.check();
  assert.equal(updater.getState().phase, 'updated');
  assert.match(updater.getState().message, /尚未应用/u);
  assert.equal(writeRequests, 1);
  assert.equal(requests.filter((request) => request.endpoint === '/api/extensions/version').length, 3);
});

test('服务器已明确返回更新失败后允许正常重试', async () => {
  const failure = { endpoint: '/api/extensions/update', status: 500 };
  const { updater, requests } = fixture({ failure });
  await updater.update();
  assert.equal(updater.getState().phase, 'error');
  failure.endpoint = '/no-failure';
  await updater.update();
  assert.equal(updater.getState().phase, 'updated');
  assert.equal(requests.filter((request) => request.endpoint === '/api/extensions/update').length, 2);
});
