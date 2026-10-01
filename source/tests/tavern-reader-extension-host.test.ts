import assert from 'node:assert/strict';
import test from 'node:test';

import { createReaderHost, type ReaderHostDependencies } from '../extensions/jiuguan-reader/src/host.js';
import type { ReaderHost, ReaderMessage, ReaderSettings, SavedReading } from '../extensions/jiuguan-reader/src/types.js';

const nullStore: ReaderHost['store'] = { load: async () => null, save: async () => {} };
type TestNativeContext = ReturnType<NonNullable<ReaderHostDependencies['getContext']>>;

function createCharacterContext() {
  const shallow = {
    avatar: 'Asahi.png',
    name: 'Asahi',
    data: { extensions: { world: 'Primary Book' } },
  };
  const full = {
    avatar: 'Asahi.png',
    name: 'Asahi',
    data: {
      description: '角色完整经历与设定',
      personality: '谨慎',
      scenario: '背景情境',
      extensions: { world: 'Primary Book' },
      character_book: { entries: [{ id: 1, content: '内嵌世界书条目' }] },
    },
  };
  const requestedBooks: string[] = [];
  const connectionProfiles: Array<Record<string, unknown>> = [];
  let getOneCharacterCalls = 0;
  let currentModel = 'current-model-a';
  const context: TestNativeContext = {
    characterId: 0,
    groupId: '',
    characters: [shallow],
    extensionSettings: { disabledExtensions: [] as string[] },
    mainApi: 'openai',
    chatCompletionSettings: {
      chat_completion_source: 'openai',
      temp_openai: 0.4,
      freq_pen_openai: 0.2,
      pres_pen_openai: 0,
      top_p_openai: 0.85,
      reverse_proxy: '',
      custom_prompt_post_processing: 'should be disabled',
      use_sysprompt: true,
    },
    CONNECT_API_MAP: {
      'chat-profile': { selected: 'openai', source: 'custom' },
      'text-profile': { selected: 'textgenerationwebui', type: 'textgenerationwebui' },
    },
    getChatCompletionModel: () => currentModel,
    ChatCompletionService: {
      processRequest: async () => makeCompletionResponse('unused', 'stop'),
    },
    getOneCharacter: async (avatar: string) => {
      assert.equal(avatar, 'Asahi.png');
      getOneCharacterCalls += 1;
      context.characters![0] = full;
    },
    loadWorldInfo: async (name: string) => {
      requestedBooks.push(name);
      return { name, entries: { 1: { content: `${name} 的完整原文条目`, enabled: false } } };
    },
    ConnectionManagerRequestService: {
      getSupportedProfiles: () => connectionProfiles,
      sendRequest: async () => makeCompletionResponse('unused', 'stop'),
    },
  };
  return {
    context,
    shallow,
    full,
    requestedBooks,
    connectionProfiles,
    setCurrentModel(model: string) { currentModel = model; },
    getOneCharacterCalls: () => getOneCharacterCalls,
  };
}

function makeCompletionResponse(content: string, finishReason?: string): Record<string, unknown> {
  return {
    choices: [{
      message: { role: 'assistant', content },
      ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
    }],
  };
}

test('getMaterial refreshes the complete card and reads only its primary and character-extra worldbooks', async () => {
  const fixture = createCharacterContext();
  const host = createReaderHost({
    getContext: () => fixture.context,
    getWorldInfoSettings: () => ({
      world_info: {
        charLore: [{ name: 'Asahi', extraBooks: ['Extra Book'] }],
        globalBook: 'Global Book',
      },
    }),
    store: nullStore,
  });

  const material = await host.getMaterial();

  assert.equal(fixture.getOneCharacterCalls(), 1);
  assert.equal(material.characterKey, 'Asahi.png');
  assert.equal(material.card, fixture.full);
  assert.equal(material.card.data && (material.card.data as Record<string, unknown>).description, '角色完整经历与设定');
  assert.deepEqual(fixture.requestedBooks, ['Primary Book', 'Extra Book']);
  assert.deepEqual(material.worldbooks.map(({ name, binding }) => ({ name, binding })), [
    { name: 'Primary Book', binding: 'primary' },
    { name: 'Extra Book', binding: 'extra' },
  ]);
  assert.equal(material.worldbooks.every((book) => (book.data.entries as Record<string, unknown>) !== undefined), true);
  assert.equal(material.warnings.length, 0);
});

test('getMaterial warns when a linked worldbook cannot be read instead of claiming full coverage', async () => {
  const fixture = createCharacterContext();
  fixture.context.loadWorldInfo = async () => null;
  const host = createReaderHost({
    getContext: () => fixture.context,
    getWorldInfoSettings: () => ({ world_info: { charLore: [{ name: 'Asahi', extraBooks: [] }] } }),
    store: nullStore,
  });

  const material = await host.getMaterial();

  assert.equal(material.worldbooks.length, 0);
  assert.match(material.warnings.join('\n'), /Primary Book.*无法读取/u);
});

test('getMaterial refuses a shallow card when getOneCharacter did not replace it', async () => {
  const fixture = createCharacterContext();
  fixture.context.getOneCharacter = async () => {};
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });

  await assert.rejects(host.getMaterial(), /没有取得完整角色卡资料/u);
});

test('current Chat Completion sends raw messages with current model/settings and never uses generateRaw', async () => {
  const fixture = createCharacterContext();
  const calls: Array<{
    requestData: Record<string, unknown>;
    options: Record<string, unknown>;
    extractData: boolean;
    signal: AbortSignal;
  }> = [];
  fixture.context.ChatCompletionService!.processRequest = async (requestData, options, extractData, signal) => {
    calls.push({ requestData, options, extractData, signal });
    return makeCompletionResponse('中文读卡结果', 'stop');
  };
  fixture.context.ConnectionManagerRequestService!.sendRequest = async () => {
    throw new Error('must not use a connection profile');
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const messages: ReaderMessage[] = [
    { role: 'system', content: '只使用唯一系统提示词' },
    { role: 'user', content: '卡片原始资料 {{char}}，不要读取聊天。' },
  ];
  const signal = new AbortController().signal;

  const result = await host.generate(messages, {
    ...host.getSettings(),
    connection: { mode: 'current', profileId: '' },
    maxOutputTokens: 876,
  }, signal);

  assert.equal(result, '中文读卡结果');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].requestData.messages, messages);
  assert.equal(calls[0].requestData.model, 'current-model-a');
  assert.equal(calls[0].requestData.chat_completion_source, 'openai');
  assert.equal(calls[0].requestData.max_tokens, 876);
  assert.equal(calls[0].requestData.stream, false);
  assert.equal(calls[0].requestData.temperature, 0.4);
  assert.equal(calls[0].requestData.frequency_penalty, 0.2);
  assert.equal(calls[0].requestData.top_p, 0.85);
  assert.equal(calls[0].requestData.use_sysprompt, true);
  assert.equal(calls[0].requestData.custom_prompt_post_processing, '');
  assert.deepEqual(calls[0].options, {});
  assert.equal(calls[0].extractData, false);
  assert.equal(calls[0].signal, signal);
});

test('profile API uses raw Chat Completion data and hides non-Chat profiles from the picker', async () => {
  const fixture = createCharacterContext();
  const calls: Array<{ profileId: string; messages: ReaderMessage[]; maxTokens: number; options: Record<string, unknown>; override: Record<string, unknown> }> = [];
  fixture.connectionProfiles.push(
    { id: 'profile-a', name: '专用读卡连接', api: 'chat-profile', model: 'profile-model', 'api-url': 'https://profile.example/v1', 'secret-id': 'test-secret-id', proxy: 'proxy-a' },
    { id: 'profile-text', name: '文本补全连接', api: 'text-profile', model: 'text-model' },
  );
  fixture.context.ConnectionManagerRequestService!.sendRequest = async (profileId, messages, maxTokens, options, override) => {
    calls.push({ profileId, messages, maxTokens, options, override });
    return makeCompletionResponse('指定连接结果', 'stop');
  };
  const host = createReaderHost({
    getContext: () => fixture.context,
    store: nullStore,
    getProfileProxyEndpoint: (proxyName) => proxyName === 'proxy-a' ? 'https://proxy.example/v1' : undefined,
  });
  const messages: ReaderMessage[] = [
    { role: 'system', content: '唯一读卡系统提示词' },
    { role: 'user', content: '只发角色卡与世界书原文' },
  ];
  const abort = new AbortController();

  const result = await host.generate(messages, {
    ...host.getSettings(),
    connection: { mode: 'profile', profileId: 'profile-a' },
  }, abort.signal);

  assert.equal(result, '指定连接结果');
  assert.deepEqual(host.getProfiles(), [{ id: 'profile-a', name: '专用读卡连接' }]);
  assert.equal(host.describeConnection({ mode: 'profile', profileId: 'profile-a' }), '专用读卡连接');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileId, 'profile-a');
  assert.deepEqual(calls[0].messages, messages);
  assert.equal(calls[0].maxTokens, host.getSettings().maxOutputTokens);
  assert.equal(calls[0].options.signal, abort.signal);
  assert.equal(calls[0].options.extractData, false);
  assert.equal(calls[0].options.includePreset, false);
  assert.equal(calls[0].options.includeInstruct, false);
  assert.equal(calls[0].override.model, 'profile-model');
  assert.equal(calls[0].override.chat_completion_source, 'custom');
  assert.equal(calls[0].override.custom_url, 'https://profile.example/v1');
  assert.equal(calls[0].override.secret_id, 'test-secret-id');
  assert.equal(calls[0].override.use_sysprompt, true);
  assert.equal(calls[0].override.custom_prompt_post_processing, '');
});

test('profile without an assigned secret sends a non-UUID sentinel instead of falling back to the active key', async (t) => {
  for (const secretId of [undefined, ''] as const) {
    await t.test(secretId === undefined ? 'missing secret-id' : 'empty secret-id', async () => {
      const fixture = createCharacterContext();
      const profile: Record<string, unknown> = {
        id: 'profile-without-key',
        name: '未绑定密钥的独立连接',
        api: 'chat-profile',
        model: 'profile-model',
        'api-url': 'https://profile.example/v1',
      };
      if (secretId !== undefined) profile['secret-id'] = secretId;
      fixture.connectionProfiles.push(profile);
      let sentOverride: Record<string, unknown> | undefined;
      let proxyLookupCount = 0;
      fixture.context.ConnectionManagerRequestService!.sendRequest = async (_profileId, _messages, _maxTokens, _options, override) => {
        sentOverride = override;
        return makeCompletionResponse('独立连接结果', 'stop');
      };
      const host = createReaderHost({
        getContext: () => fixture.context,
        store: nullStore,
        getProfileProxyEndpoint: () => {
          proxyLookupCount += 1;
          return undefined;
        },
      });

      await host.generate([{ role: 'user', content: '只发角色卡资料' }], {
        ...host.getSettings(),
        connection: { mode: 'profile', profileId: 'profile-without-key' },
      }, new AbortController().signal);

      assert.equal(sentOverride?.secret_id, 'jiuguan-reader:no-profile-secret');
      assert.equal(proxyLookupCount, 0, '没有代理名称时不检查或导入代理预设');
    });
  }
});

test('profile proxy keeps using a confirmed URL and stops when the same preset name changes URL', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({
    id: 'profile-a', name: '带代理的读卡连接', api: 'chat-profile', model: 'profile-model',
    'secret-id': 'test-secret-id', proxy: 'shared-proxy',
  });
  let proxyEndpoint: string | undefined = 'https://proxy-a.example/v1';
  const proxyLookups: string[] = [];
  let calls = 0;
  fixture.context.ConnectionManagerRequestService!.sendRequest = async () => {
    calls += 1;
    return makeCompletionResponse('段落结果', 'stop');
  };
  const host = createReaderHost({
    getContext: () => fixture.context,
    store: nullStore,
    getProfileProxyEndpoint: (name) => {
      proxyLookups.push(name);
      return proxyEndpoint;
    },
  });
  const settings = { ...host.getSettings(), connection: { mode: 'profile' as const, profileId: 'profile-a' } };
  const signal = new AbortController().signal;

  await host.generate([{ role: 'user', content: '第一段' }], settings, signal);
  await host.generate([{ role: 'user', content: '第二段' }], settings, signal);
  assert.equal(calls, 2, '确认仍是同一 URL 时允许继续分段');

  proxyEndpoint = 'https://proxy-b.example/v1';
  await assert.rejects(
    host.generate([{ role: 'user', content: '第三段' }], settings, signal),
    /代理地址在本次读卡过程中发生变化或无法确认/u,
  );
  assert.equal(calls, 2, '端点变化时不发送下一段');
  assert.deepEqual(proxyLookups, ['shared-proxy', 'shared-proxy', 'shared-proxy']);
});

test('profile proxy stops before the next request if its named preset was deleted', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({
    id: 'profile-a', name: '带代理的读卡连接', api: 'chat-profile', model: 'profile-model',
    'secret-id': 'test-secret-id', proxy: 'shared-proxy',
  });
  let proxyEndpoint: string | undefined = 'https://proxy-a.example/v1';
  let calls = 0;
  fixture.context.ConnectionManagerRequestService!.sendRequest = async () => {
    calls += 1;
    return makeCompletionResponse('段落结果', 'stop');
  };
  const host = createReaderHost({
    getContext: () => fixture.context,
    store: nullStore,
    getProfileProxyEndpoint: () => proxyEndpoint,
  });
  const settings = { ...host.getSettings(), connection: { mode: 'profile' as const, profileId: 'profile-a' } };
  const signal = new AbortController().signal;

  await host.generate([{ role: 'user', content: '第一段' }], settings, signal);
  proxyEndpoint = undefined;
  await assert.rejects(
    host.generate([{ role: 'user', content: '第二段' }], settings, signal),
    /代理地址在本次读卡过程中发生变化或无法确认/u,
  );
  assert.equal(calls, 1);
});

test('profile proxy must be confirmed before sending even the first request', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({
    id: 'profile-a', name: '带代理的读卡连接', api: 'chat-profile', model: 'profile-model',
    proxy: 'missing-proxy',
  });
  let calls = 0;
  fixture.context.ConnectionManagerRequestService!.sendRequest = async () => {
    calls += 1;
    return makeCompletionResponse('不应发送', 'stop');
  };
  const host = createReaderHost({
    getContext: () => fixture.context,
    store: nullStore,
    getProfileProxyEndpoint: () => undefined,
  });
  const settings = { ...host.getSettings(), connection: { mode: 'profile' as const, profileId: 'profile-a' } };
  await assert.rejects(
    host.generate([{ role: 'user', content: '第一段' }], settings, new AbortController().signal),
    /无法确认指定连接的代理地址/u,
  );
  assert.equal(calls, 0);
});

test('profile proxy names retain their exact whitespace when checking the host preset', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({
    id: 'profile-a', name: '带代理的读卡连接', api: 'chat-profile', model: 'profile-model',
    proxy: ' shared-proxy ',
  });
  const host = createReaderHost({
    getContext: () => fixture.context,
    store: nullStore,
    getProfileProxyEndpoint: (name) => {
      assert.equal(name, ' shared-proxy ');
      return 'https://proxy-a.example/v1';
    },
  });
  const settings = { ...host.getSettings(), connection: { mode: 'profile' as const, profileId: 'profile-a' } };
  assert.equal(await host.generate([{ role: 'user', content: '第一段' }], settings, new AbortController().signal), 'unused');
});

test('profile changes during a multi-request job stop it instead of mixing models', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({
    id: 'profile-a', name: '专用读卡连接', api: 'chat-profile', model: 'profile-model-a', 'secret-id': 'test-secret-id',
  });
  let calls = 0;
  fixture.context.ConnectionManagerRequestService!.sendRequest = async () => {
    calls += 1;
    return makeCompletionResponse('段落结果', 'stop');
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const settings = { ...host.getSettings(), connection: { mode: 'profile' as const, profileId: 'profile-a' } };
  const abort = new AbortController();

  await host.generate([{ role: 'user', content: '第一段' }], settings, abort.signal);
  fixture.connectionProfiles[0].model = 'profile-model-b';
  await assert.rejects(
    host.generate([{ role: 'user', content: '第二段' }], settings, abort.signal),
    /档案在本次读卡过程中发生变化/u,
  );
  assert.equal(calls, 1);
});

test('current non-connection defaults stay locked while a changed model stops the same read job', async () => {
  const fixture = createCharacterContext();
  const payloads: Array<Record<string, unknown>> = [];
  fixture.context.ChatCompletionService!.processRequest = async (requestData) => {
    payloads.push(requestData);
    return makeCompletionResponse(`结果${payloads.length}`, 'stop');
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const settings = { ...host.getSettings(), connection: { mode: 'current' as const, profileId: '' } };
  const abort = new AbortController();

  await host.generate([{ role: 'user', content: '第一段' }], settings, abort.signal);
  fixture.context.chatCompletionSettings!.temp_openai = 0.99;
  await host.generate([{ role: 'user', content: '第二段' }], settings, abort.signal);

  assert.equal(payloads[0].model, 'current-model-a');
  assert.equal(payloads[1].model, 'current-model-a');
  assert.equal(payloads[0].temperature, 0.4);
  assert.equal(payloads[1].temperature, 0.4);
  assert.equal(payloads[0].use_sysprompt, false);

  fixture.setCurrentModel('current-model-b');
  await assert.rejects(
    host.generate([{ role: 'user', content: '第三段' }], settings, abort.signal),
    /当前连接在本次读卡过程中发生变化/u,
  );
  assert.equal(payloads.length, 2);
});

test('current endpoint and optional secret-id changes stop the same read job without reading a key', async () => {
  for (const changedSetting of ['custom_url', 'secret_id'] as const) {
    const fixture = createCharacterContext();
    fixture.context.chatCompletionSettings!.chat_completion_source = 'custom';
    fixture.context.chatCompletionSettings!.custom_url = 'https://custom.example/v1';
    fixture.context.chatCompletionSettings!.secret_id = 'safe-secret-id-a';
    let calls = 0;
    fixture.context.ChatCompletionService!.processRequest = async () => {
      calls += 1;
      return makeCompletionResponse('段落结果', 'stop');
    };
    const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
    const settings = { ...host.getSettings(), connection: { mode: 'current' as const, profileId: '' } };
    const abort = new AbortController();

    await host.generate([{ role: 'user', content: '第一段' }], settings, abort.signal);
    fixture.context.chatCompletionSettings![changedSetting] = changedSetting === 'custom_url'
      ? 'https://other-custom.example/v1'
      : 'safe-secret-id-b';
    await assert.rejects(
      host.generate([{ role: 'user', content: '第二段' }], settings, abort.signal),
      /当前连接在本次读卡过程中发生变化/u,
    );
    assert.equal(calls, 1);
  }
});

test('aborted native Chat Completion request rejects and discards a late result', async () => {
  const fixture = createCharacterContext();
  let finish: ((value: Record<string, unknown>) => void) | undefined;
  fixture.context.ChatCompletionService!.processRequest = () => new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const abort = new AbortController();
  const request = host.generate([{ role: 'user', content: '资料' }], host.getSettings(), abort.signal);
  abort.abort();

  await assert.rejects(request, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  finish?.(makeCompletionResponse('迟到结果', 'stop'));
});

test('current service preserves safe HTTP/rate-limit reasons while removing fake credentials and URLs', async () => {
  const fixture = createCharacterContext();
  fixture.context.ChatCompletionService!.processRequest = async () => {
    throw new Error('API request failed', {
      cause: new Error('HTTP 429 Too Many Requests: api_key=sk-fake-secret-123456789 Bearer mock-bearer-credential https://api.example.test/v1?api_key=url-fake-secret'),
    });
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });

  await assert.rejects(
    host.generate([{ role: 'user', content: '资料' }], host.getSettings(), new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 429.*Too Many Requests/u);
      assert.equal(error.message.includes('sk-fake-secret-123456789'), false);
      assert.equal(error.message.includes('mock-bearer-credential'), false);
      assert.equal(error.message.includes('url-fake-secret'), false);
      assert.equal(error.message.includes('api.example.test'), false);
      return true;
    },
  );
});

test('profile service preserves provider rejection details while redacting JSON credentials', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({
    id: 'profile-a', name: '专用读卡连接', api: 'chat-profile', model: 'profile-model', 'secret-id': 'test-secret-id',
  });
  fixture.context.ConnectionManagerRequestService!.sendRequest = async () => {
    throw new Error('API request failed', {
      cause: new Error('{"error":"401 Unauthorized","apiKey":"json-fake-secret","key":"fake-key-value"}'),
    });
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const settings = { ...host.getSettings(), connection: { mode: 'profile' as const, profileId: 'profile-a' } };

  await assert.rejects(
    host.generate([{ role: 'user', content: '资料' }], settings, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /401 Unauthorized/u);
      assert.equal(error.message.includes('json-fake-secret'), false);
      assert.equal(error.message.includes('fake-key-value'), false);
      return true;
    },
  );
});

test('truncated and unclassified Chat Completion finish reasons are rejected', async () => {
  const fixture = createCharacterContext();
  fixture.context.ChatCompletionService!.processRequest = async () => makeCompletionResponse('不完整内容', 'length');
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const settings = { ...host.getSettings(), connection: { mode: 'current' as const, profileId: '' } };
  const aborted = () => new AbortController().signal;

  await assert.rejects(host.generate([{ role: 'user', content: '资料' }], settings, aborted()), /达到输出上限/u);
  fixture.context.ChatCompletionService!.processRequest = async () => makeCompletionResponse('没有结束原因');
  await assert.rejects(host.generate([{ role: 'user', content: '资料' }], settings, aborted()), /没有返回可确认的结束原因/u);
});

test('known Anthropic and Gemini Chat Completion stop metadata is preserved and accepted', async () => {
  const fixture = createCharacterContext();
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const settings = { ...host.getSettings(), connection: { mode: 'current' as const, profileId: '' } };
  const signal = new AbortController().signal;
  fixture.context.ChatCompletionService!.processRequest = async () => ({
    content: [{ type: 'text', text: 'Claude 格式结果' }],
    stop_reason: 'end_turn',
  });
  assert.equal(await host.generate([{ role: 'user', content: '资料' }], settings, signal), 'Claude 格式结果');

  fixture.context.ChatCompletionService!.processRequest = async () => ({
    candidates: [{
      content: { parts: [{ text: 'Gemini 格式结果' }] },
      finishReason: 'STOP',
    }],
  });
  assert.equal(await host.generate([{ role: 'user', content: '资料' }], settings, signal), 'Gemini 格式结果');
});

test('provider refusal text and refusal finish reasons remain visible to the reader', async () => {
  const fixture = createCharacterContext();
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const settings = { ...host.getSettings(), connection: { mode: 'current' as const, profileId: '' } };
  const signal = new AbortController().signal;

  fixture.context.ChatCompletionService!.processRequest = async () => ({
    choices: [{ message: { role: 'assistant', content: '', refusal: '服务商拒绝了这次请求。' }, finish_reason: 'stop' }],
  });
  assert.equal(
    await host.generate([{ role: 'user', content: '资料' }], settings, signal),
    '服务商拒绝了这次请求。',
  );

  fixture.context.ChatCompletionService!.processRequest = async () => makeCompletionResponse('服务商返回的过滤说明', 'content_filter');
  assert.equal(
    await host.generate([{ role: 'user', content: '资料' }], settings, signal),
    '服务商返回的过滤说明',
  );

  fixture.context.ChatCompletionService!.processRequest = async () => ({
    content: [{ type: 'text', text: 'Anthropic 服务商拒绝说明' }],
    stop_reason: 'refusal',
  });
  assert.equal(
    await host.generate([{ role: 'user', content: '资料' }], settings, signal),
    'Anthropic 服务商拒绝说明',
  );

  fixture.context.ChatCompletionService!.processRequest = async () => ({
    candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
  });
  await assert.rejects(
    host.generate([{ role: 'user', content: '资料' }], settings, signal),
    /SAFETY.*没有返回正文/u,
  );
});

test('current Text Completion is rejected without falling back to another API', async () => {
  const fixture = createCharacterContext();
  fixture.context.mainApi = 'textgenerationwebui';
  let calls = 0;
  fixture.context.ChatCompletionService!.processRequest = async () => {
    calls += 1;
    return makeCompletionResponse('must not send', 'stop');
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });

  await assert.rejects(
    host.generate([{ role: 'user', content: '资料' }], host.getSettings(), new AbortController().signal),
    /仅支持酒馆 Chat Completion/u,
  );
  assert.equal(calls, 0);
});

test('settings save awaits native confirmation and restores in-memory settings after a failed save', async () => {
  const fixture = createCharacterContext();
  fixture.context.extensionSettings!['jiuguan-reader'] = { systemPrompt: 'previous' };
  let shouldFail = false;
  const host = createReaderHost({
    getContext: () => fixture.context,
    store: nullStore,
    saveNativeSettings: async () => {
      if (shouldFail) throw new Error('sensitive internal failure');
    },
  });
  const settings = { ...host.getSettings(), analysisPrompt: '新的读卡提示词' };

  await host.saveSettings(settings);
  assert.equal((fixture.context.extensionSettings!['jiuguan-reader'] as ReaderSettings).analysisPrompt, '新的读卡提示词');

  const savedValue = fixture.context.extensionSettings!['jiuguan-reader'];
  shouldFail = true;
  await assert.rejects(host.saveSettings({ ...settings, analysisPrompt: '不应留下的设置' }), /没有确认读卡设置/u);
  assert.equal(fixture.context.extensionSettings!['jiuguan-reader'], savedValue);
});

function makeSavedReading(characterKey: string): SavedReading {
  return {
    schemaVersion: 1,
    characterKey,
    characterName: 'Asahi',
    fingerprint: 'fingerprint-1',
    analysis: '角色解读',
    chunkNotes: ['经历笔记'],
    sourceCount: 1,
    chunkCount: 1,
    sources: [{ id: '[S1]', label: '角色经历', text: '完整经历' }],
    worldbooks: ['主关联：Primary Book'],
    warnings: [],
    readAt: '2026-10-01T00:00:00.000Z',
    model: '测试模型',
    answers: [],
  };
}
