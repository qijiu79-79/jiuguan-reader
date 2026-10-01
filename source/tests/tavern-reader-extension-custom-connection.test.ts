import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomConnectionClient, resolveCustomApiBaseUrl } from '../extensions/jiuguan-reader/src/custom-connection.js';
import { createReaderHost } from '../extensions/jiuguan-reader/src/host.js';
import { defaultReaderSettings, normalizeReaderSettings } from '../extensions/jiuguan-reader/src/settings.js';
import type { ReaderMessage } from '../extensions/jiuguan-reader/src/types.js';

const fakeKey = 'fictional-independent-credential';
const connection = { mode: 'custom' as const, profileId: '', baseUrl: 'https://provider.example.test/v1', model: 'reader-model' };
const messages: ReaderMessage[] = [{ role: 'system', content: '  唯一系统提示词\n保留空白。  ' }, { role: 'user', content: '虚构资料 {{char}}' }];
const result = { choices: [{ message: { content: '虚构解读' }, finish_reason: 'stop' }] };

test('独立API地址接受裸地址、版本前缀及完整请求地址，不重复拼接v1', () => {
  for (const [input, expected] of [
    [' https://provider.example.test/ ', 'https://provider.example.test/v1'],
    ['https://provider.example.test/api/v3/', 'https://provider.example.test/api/v3'],
    ['https://provider.example.test/v1/chat/completions', 'https://provider.example.test/v1'],
    ['http://127.0.0.1:34567/v1/models', 'http://127.0.0.1:34567/v1'],
    ['https://provider.example.test/custom-prefix', 'https://provider.example.test/custom-prefix'],
  ]) assert.equal(resolveCustomApiBaseUrl(input!), expected);
  for (const input of ['', 'not-a-url', 'file:///private/card', 'https://user:password@example.test/v1', 'https://example.test/v1?key=fake', 'https://example.test/v1#fake']) {
    assert.throws(() => resolveCustomApiBaseUrl(input), /API 地址/u);
  }
});

test('用当前填写的地址和Key拉模型，不要求先保存或选择模型，不记住拉取草稿', async () => {
  const payloads: Record<string, unknown>[] = [];
  const client = createCustomConnectionClient({ getHeaders: () => ({ 'X-CSRF-Token': 'fake-csrf' }), fetcher: async (route, init) => {
    assert.equal(route, '/api/backends/chat-completions/status');
    assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), 'fake-csrf');
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json({ data: [{ id: 'z-model' }, { id: ' a-model ' }, { id: 'a-model' }] });
  } });
  const draft = { ...connection, model: '' };
  assert.deepEqual(await client.listModels(draft, new AbortController().signal, fakeKey), ['a-model', 'z-model']);
  assert.deepEqual(payloads[0], { chat_completion_source: 'openai', reverse_proxy: connection.baseUrl, proxy_password: fakeKey });
  assert.equal(client.hasApiKey(draft), false);
  await client.listModels(draft, new AbortController().signal);
  assert.equal(payloads[1]!.proxy_password, '', '不能把上次未保存的拉取草稿偷偷复用');
});

test('独立Key只保留于页面内存，按地址隔离，新客户端与持久设置中都没有Key', async () => {
  const payloads: Record<string, unknown>[] = [];
  const dependencies = { getHeaders: () => ({}), fetcher: async (_route: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json({ data: [{ id: 'reader-model' }] });
  } };
  const client = createCustomConnectionClient(dependencies);
  client.rememberApiKey(connection, fakeKey);
  await client.listModels(connection, new AbortController().signal);
  await client.listModels({ ...connection, baseUrl: 'https://other.example.test/v1' }, new AbortController().signal);
  assert.equal(payloads[0]!.proxy_password, fakeKey);
  assert.equal(payloads[1]!.proxy_password, '');
  assert.equal(createCustomConnectionClient(dependencies).hasApiKey(connection), false);
  const settings = normalizeReaderSettings({ connection: { ...connection, apiKey: fakeKey }, apiKey: fakeKey });
  assert.equal(settings.connection.mode, 'custom');
  assert.equal(settings.connection.baseUrl, connection.baseUrl);
  assert.equal(JSON.stringify(settings).includes(fakeKey), false);
});

test('保存独立API不动聊天配置或原生密钥，只在设置写入成功后记住Key', async () => {
  const context = { extensionSettings: {} as Record<string, unknown>, mainApi: 'openai', chatCompletionSettings: { custom_url: 'https://chat.example.test/v1', secret_id: 'fictional-chat-secret' } };
  const before = structuredClone(context.chatCompletionSettings);
  let failSave = true;
  const host = createReaderHost({ getContext: () => context, store: { load: async () => null, save: async () => {} }, saveNativeSettings: async () => { if (failSave) throw new Error('fake failure'); } });
  const settings = { ...defaultReaderSettings(), connection };
  await assert.rejects(host.saveSettings(settings, fakeKey), /设置和输入仍保留/u);
  assert.equal(host.hasCustomApiKey!(connection), false);
  assert.deepEqual(context.extensionSettings, {});
  failSave = false;
  await host.saveSettings(settings, fakeKey);
  assert.equal(host.hasCustomApiKey!(connection), true);
  assert.equal(JSON.stringify(context.extensionSettings).includes(fakeKey), false);
  assert.deepEqual(context.chatCompletionSettings, before);
  assert.equal(host.describeConnection(connection), '独立 API（reader-model）');
});

test('独立请求经酒馆后端发出，只发送自己的地址Key模型和原样消息，不继承聊天连接', async () => {
  const payloads: Record<string, unknown>[] = [];
  const context = { extensionSettings: {} as Record<string, unknown>, mainApi: 'textgenerationwebui', chatCompletionSettings: { custom_url: 'https://chat.example.test/v1', proxy_password: 'fictional-chat-key', temp_openai: 0.2, top_p_openai: 0.8 } };
  const host = createReaderHost({ getContext: () => context, store: { load: async () => null, save: async () => {} }, saveNativeSettings: async () => {}, fetcher: async (route, init) => {
    assert.equal(route, '/api/backends/chat-completions/generate');
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json(result);
  } });
  const settings = { ...defaultReaderSettings(), stream: false, connection, generation: { inherit: false, temperature: 0.35, topP: 0.9, frequencyPenalty: 0.1, presencePenalty: -0.2 }, maxOutputTokens: 2048 };
  await host.saveSettings(settings, fakeKey);
  assert.equal(await host.generate(messages, host.getSettings(), new AbortController().signal), '虚构解读');
  assert.deepEqual(payloads[0], {
    chat_completion_source: 'openai', reverse_proxy: connection.baseUrl, proxy_password: fakeKey,
    model: connection.model, messages, stream: false, max_tokens: 2048,
    use_sysprompt: true, custom_prompt_post_processing: '',
    temperature: 0.35, top_p: 0.9, frequency_penalty: 0.1, presence_penalty: -0.2,
  });
  assert.equal(JSON.stringify(payloads).includes('fictional-chat-key'), false);
});

test('独立接口错误保留HTTP原因并隐藏回显Key，不回退到当前连接', async () => {
  const client = createCustomConnectionClient({ getHeaders: () => ({}), fetcher: async () => Response.json({ error: { message: `invalid credential ${fakeKey} at https://provider.example.test/v1` } }, { status: 401 }) });
  await assert.rejects(client.listModels(connection, new AbortController().signal, fakeKey), (error: Error) => {
    assert.match(error.message, /HTTP 401.*invalid credential/u);
    assert.equal(error.message.includes(fakeKey), false);
    assert.equal(error.message.includes('https://provider'), false);
    return true;
  });
});

test('分块任务固定独立连接和采样值，中途换Key时停止，不混用连接', async () => {
  const payloads: Record<string, unknown>[] = [];
  const client = createCustomConnectionClient({ getHeaders: () => ({}), fetcher: async (_route, init) => { payloads.push(JSON.parse(String(init?.body))); return Response.json(result); } });
  const settings = { ...defaultReaderSettings(), connection };
  const signal = new AbortController().signal;
  client.rememberApiKey(connection, fakeKey);
  await client.generate(messages, settings, signal, { temperature: 0.2 });
  await client.generate(messages, settings, signal, { temperature: 1.5 });
  assert.equal(payloads[1]!.temperature, 0.2);
  client.rememberApiKey(connection, 'fictional-replacement');
  await assert.rejects(client.generate(messages, settings, signal, {}), /发生变化/u);
  assert.equal(payloads.length, 2);
});

test('取消独立拉取即结束等待，即使测试fetch忽略signal也不挂住', async () => {
  const host = createReaderHost({ getContext: () => ({ extensionSettings: {} }), store: { load: async () => null, save: async () => {} }, fetcher: async () => new Promise<Response>(() => {}) });
  const abort = new AbortController();
  const pending = host.listModels(connection, abort.signal, fakeKey);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('刷新后独立Key缺失明确要求补填，追问前阻止请求；无密钥接口可明确选择', async () => {
  let calls = 0;
  const client = createCustomConnectionClient({ getHeaders: () => ({}), fetcher: async () => { calls += 1; return Response.json(result); } });
  const settings = { ...defaultReaderSettings(), connection };
  await assert.rejects(client.generate(messages, settings, new AbortController().signal, {}), /刷新或在另一台设备.*重填/u);
  assert.equal(calls, 0);
  await client.generate(messages, { ...settings, connection: { ...connection, noApiKey: true } }, new AbortController().signal, {});
  assert.equal(calls, 1);
});

test('401认证失败显示补填指引，429显示额度原因，响应回显Key仍脱敏', async () => {
  for (const [status, body, expected] of [
    [401, { error: { message: `Unauthorized ${fakeKey}` } }, /HTTP 401.*重填 Key/u],
    [429, { detail: 'rate limit' }, /HTTP 429.*额度/u],
  ] as const) {
    const client = createCustomConnectionClient({ getHeaders: () => ({}), fetcher: async () => Response.json(body, { status }) });
    await assert.rejects(client.listModels(connection, new AbortController().signal, fakeKey), (error: Error) => {
      assert.match(error.message, expected);
      assert.equal(error.message.includes(fakeKey), false);
      return true;
    });
  }
});

test('酒馆把上游401转成400 Unauthorized时仍提示补填Key', async () => {
  const client = createCustomConnectionClient({ getHeaders: () => ({}), fetcher: async () => Response.json({ error: { message: 'Synthetic failure.' } }, { status: 400, statusText: 'Unauthorized' }) });
  await assert.rejects(client.listModels(connection, new AbortController().signal, fakeKey), /HTTP 400.*重填 Key/u);
});
