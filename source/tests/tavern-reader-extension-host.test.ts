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
    extensionSettings: { disabledExtensions: [] as string[], 'jiuguan-reader': { stream: false } },
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
  assert.equal(host.describeConnection({ mode: 'profile', profileId: 'profile-a' }), '专用读卡连接（profile-model）');
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

test('connection summary exposes complete current/profile model IDs and a reader-only override', () => {
  const fixture = createCharacterContext();
  const longModel = `provider/${'long-model-name-'.repeat(14)}2026`;
  fixture.setCurrentModel(longModel);
  fixture.connectionProfiles.push({ id: 'profile-a', name: '独立读卡', api: 'chat-profile', model: 'profile-model' });
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  assert.deepEqual(host.getConnectionInfo({ mode: 'current', profileId: '' }), { label: '酒馆当前连接', source: 'openai', model: longModel });
  assert.deepEqual(host.getConnectionInfo({ mode: 'profile', profileId: 'profile-a' }), { label: '独立读卡', source: 'custom', model: 'profile-model' });
  assert.equal(host.getConnectionInfo({ mode: 'profile', profileId: 'profile-a', model: '  reader-only  ' }).model, 'reader-only');
  assert.equal(host.describeConnection({ mode: 'current', profileId: '' }), `酒馆当前连接（${longModel}）`);
});

test('current and profile model/sampling overrides affect only reader requests, never host settings', async () => {
  for (const mode of ['current', 'profile'] as const) {
    const fixture = createCharacterContext();
    fixture.connectionProfiles.push({ id: 'profile-a', name: '独立读卡', api: 'chat-profile', model: 'profile-model', 'secret-id': 'mock-secret-id' });
    const originalSettings = JSON.stringify(fixture.context.chatCompletionSettings);
    const originalProfiles = JSON.stringify(fixture.connectionProfiles);
    let payload: Record<string, unknown> | undefined;
    fixture.context.ChatCompletionService!.processRequest = async (data) => {
      payload = data;
      return makeCompletionResponse('当前连接结果', 'stop');
    };
    fixture.context.ConnectionManagerRequestService!.sendRequest = async (_id, _messages, _tokens, _options, override) => {
      payload = override;
      return makeCompletionResponse('独立连接结果', 'stop');
    };
    const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
    const settings: ReaderSettings = {
      ...host.getSettings(),
      connection: { mode, profileId: mode === 'profile' ? 'profile-a' : '', model: 'reader-model' },
      generation: { inherit: false, temperature: 0.17, topP: 0.73, frequencyPenalty: 0.4, presencePenalty: -0.3 },
    };
    await host.generate([{ role: 'user', content: '虚构资料' }], settings, new AbortController().signal);
    assert.equal(payload?.model, 'reader-model');
    assert.equal(payload?.temperature, 0.17);
    assert.equal(payload?.top_p, 0.73);
    assert.equal(payload?.frequency_penalty, 0.4);
    assert.equal(payload?.presence_penalty, -0.3);
    assert.equal(JSON.stringify(fixture.context.chatCompletionSettings), originalSettings);
    assert.equal(JSON.stringify(fixture.connectionProfiles), originalProfiles);
    assert.equal(fixture.context.getChatCompletionModel!(), 'current-model-a');
  }
});

test('profile inheritance snapshots current sampling values without importing the profile preset or chat prompts', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({ id: 'profile-a', name: '独立读卡', api: 'chat-profile', model: 'profile-model' });
  const overrides: Record<string, unknown>[] = [];
  fixture.context.ConnectionManagerRequestService!.sendRequest = async (_id, messages, _tokens, options, data) => {
    overrides.push(data);
    assert.deepEqual(messages, [{ role: 'user', content: '资料' }]);
    assert.equal(options.includePreset, false);
    assert.equal(options.includeInstruct, false);
    return makeCompletionResponse('结果', 'stop');
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const settings: ReaderSettings = {
    ...host.getSettings(), connection: { mode: 'profile', profileId: 'profile-a' },
    generation: { inherit: true, temperature: 1.5, topP: 0.4, frequencyPenalty: -1, presencePenalty: 1 },
  };
  const signal = new AbortController().signal;
  await host.generate([{ role: 'user', content: '资料' }], settings, signal);
  fixture.context.chatCompletionSettings!.temp_openai = 0.9;
  await host.generate([{ role: 'user', content: '资料' }], settings, signal);
  for (const override of overrides) {
    assert.equal(override.temperature, 0.4);
    assert.equal(override.top_p, 0.85);
    assert.equal(override.frequency_penalty, 0.2);
    assert.equal(override.presence_penalty, 0);
    assert.equal(override.use_sysprompt, false);
  }
});

test('an explicit reader model can generate with an empty native model, but a profile never borrows the current model', async () => {
  const fixture = createCharacterContext();
  fixture.setCurrentModel('');
  fixture.connectionProfiles.push({ id: 'profile-a', name: '还未选模型', api: 'chat-profile' });
  const payloads: Record<string, unknown>[] = [];
  fixture.context.ChatCompletionService!.processRequest = async (payload) => {
    payloads.push(payload);
    return makeCompletionResponse('结果', 'stop');
  };
  fixture.context.ConnectionManagerRequestService!.sendRequest = async (_id, _messages, _tokens, _options, payload) => {
    payloads.push(payload);
    return makeCompletionResponse('结果', 'stop');
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  await host.generate([{ role: 'user', content: '资料' }], {
    ...host.getSettings(), connection: { mode: 'current', profileId: '', model: 'reader-only' },
  }, new AbortController().signal);
  await assert.rejects(host.generate([{ role: 'user', content: '资料' }], {
    ...host.getSettings(), connection: { mode: 'profile', profileId: 'profile-a' },
  }, new AbortController().signal), /独立连接还没有模型/u);
  await host.generate([{ role: 'user', content: '资料' }], {
    ...host.getSettings(), connection: { mode: 'profile', profileId: 'profile-a', model: 'reader-only' },
  }, new AbortController().signal);
  assert.equal(payloads.length, 2);
  assert.equal(payloads.every((payload) => payload.model === 'reader-only'), true);
});

test('changing reader-only model within the same multi-part job stops before the next request', async () => {
  const fixture = createCharacterContext();
  let calls = 0;
  fixture.context.ChatCompletionService!.processRequest = async () => {
    calls += 1;
    return makeCompletionResponse('结果', 'stop');
  };
  const host = createReaderHost({ getContext: () => fixture.context, store: nullStore });
  const settings = { ...host.getSettings(), connection: { mode: 'current' as const, profileId: '', model: 'reader-a' } };
  const signal = new AbortController().signal;
  await host.generate([{ role: 'user', content: '第一段' }], settings, signal);
  await assert.rejects(host.generate([{ role: 'user', content: '第二段' }], {
    ...settings, connection: { ...settings.connection, model: 'reader-b' },
  }, signal), /连接选择发生变化/u);
  assert.equal(calls, 1);
});

test('current model listing uses only the native status route, permits no selected model, and never sends card data', async () => {
  const fixture = createCharacterContext();
  fixture.setCurrentModel('');
  Object.assign(fixture.context.chatCompletionSettings!, {
    chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:12345/v1',
    custom_include_headers: '', secret_id: 'mock-current-secret', proxy_password: 'mock-unused-password',
  });
  fixture.context.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'mock-csrf' });
  let calls = 0;
  const originalSettings = JSON.stringify(fixture.context.chatCompletionSettings);
  const host = createReaderHost({
    getContext: () => fixture.context, store: nullStore,
    fetcher: async (url, init) => {
      calls += 1;
      assert.equal(url, '/api/backends/chat-completions/status');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.cache, 'no-cache');
      assert.ok(init?.signal instanceof AbortSignal);
      assert.deepEqual(init?.headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': 'mock-csrf' });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:12345/v1',
        custom_include_headers: '', reverse_proxy: '', secret_id: 'mock-current-secret',
      });
      return Response.json({ data: [{ id: ' zulu ' }, { id: 'alpha' }, { id: 'alpha' }, { id: '' }, { id: 3 }, null] });
    },
  });
  assert.deepEqual(await host.listModels({ mode: 'current', profileId: '' }), ['alpha', 'zulu']);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(fixture.context.chatCompletionSettings), originalSettings);
});

test('profile model listing uses its bound endpoint and secret ID, including the no-secret sentinel', async () => {
  for (const secretId of ['mock-profile-secret', undefined]) {
    const fixture = createCharacterContext();
    fixture.connectionProfiles.push({
      id: 'profile-a', name: '独立连接', api: 'chat-profile', 'api-url': 'http://127.0.0.1:12346/v1',
      ...(secretId ? { 'secret-id': secretId } : {}),
    });
    fixture.context.chatCompletionSettings!.secret_id = 'mock-chat-secret-do-not-use';
    const host = createReaderHost({
      getContext: () => fixture.context, store: nullStore,
      fetcher: async (url, init) => {
        assert.equal(url, '/api/backends/chat-completions/status');
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.custom_url, 'http://127.0.0.1:12346/v1');
        assert.equal(payload.chat_completion_source, 'custom');
        assert.equal(payload.secret_id, secretId ?? 'jiuguan-reader:no-profile-secret');
        assert.equal('messages' in payload, false);
        assert.equal('model' in payload, false);
        assert.equal('proxy_password' in payload, false);
        return Response.json({ data: [{ id: 'profile-listed-model' }] });
      },
    });
    assert.deepEqual(await host.listModels({ mode: 'profile', profileId: 'profile-a' }), ['profile-listed-model']);
  }
});

test('current Custom model listing follows native header macro substitution and keeps original settings intact', async () => {
  const fixture = createCharacterContext();
  Object.assign(fixture.context.chatCompletionSettings!, { chat_completion_source: 'custom', custom_include_headers: 'X-Reader: {{fictional_header}}' });
  let substitutions = 0;
  fixture.context.substituteParams = (text) => {
    substitutions += 1;
    assert.equal(text, 'X-Reader: {{fictional_header}}');
    return 'X-Reader: mock-header-value';
  };
  const host = createReaderHost({
    getContext: () => fixture.context, store: nullStore,
    fetcher: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).custom_include_headers, 'X-Reader: mock-header-value');
      return Response.json({ data: [{ id: 'listed-model' }] });
    },
  });
  assert.deepEqual(await host.listModels({ mode: 'current', profileId: '' }), ['listed-model']);
  assert.equal(substitutions, 1);
  assert.equal(fixture.context.chatCompletionSettings!.custom_include_headers, 'X-Reader: {{fictional_header}}');

  delete fixture.context.substituteParams;
  await assert.rejects(host.listModels({ mode: 'current', profileId: '' }), /没有发送未替换的请求头/u);
});

test('profile with a reverse proxy gives a safe manual-model hint without borrowing the current proxy password', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({ id: 'profile-a', name: '代理连接', api: 'chat-profile', model: 'profile-model', proxy: 'mock-proxy' });
  fixture.context.chatCompletionSettings!.proxy_password = 'mock-current-password';
  let calls = 0;
  const host = createReaderHost({
    getContext: () => fixture.context, store: nullStore,
    getProfileProxyEndpoint: () => 'https://mock-proxy.example/v1',
    fetcher: async () => { calls += 1; return Response.json({ data: [] }); },
  });
  await assert.rejects(host.listModels({ mode: 'profile', profileId: 'profile-a' }), /反向代理.*手动填写模型 ID/u);
  assert.equal(calls, 0);
});

test('native named None proxy with an empty URL still allows an independent model list without a proxy password', async () => {
  const fixture = createCharacterContext();
  fixture.connectionProfiles.push({ id: 'profile-a', name: '没有实际代理', api: 'chat-profile', model: 'profile-model', proxy: 'None' });
  fixture.context.chatCompletionSettings!.proxy_password = 'mock-current-password';
  const host = createReaderHost({
    getContext: () => fixture.context, store: nullStore,
    getProfileProxyEndpoint: (name) => { assert.equal(name, 'None'); return ''; },
    fetcher: async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal('proxy_password' in payload, false);
      assert.equal('reverse_proxy' in payload, false);
      return Response.json({ data: [{ id: 'profile-model' }] });
    },
  });
  assert.deepEqual(await host.listModels({ mode: 'profile', profileId: 'profile-a' }), ['profile-model']);
});

test('model list rejects a changed current endpoint or profile before accepting the late result', async () => {
  for (const mode of ['current', 'profile'] as const) {
    const fixture = createCharacterContext();
    fixture.connectionProfiles.push({ id: 'profile-a', name: '独立连接', api: 'chat-profile', model: 'profile-model' });
    const host = createReaderHost({
      getContext: () => fixture.context, store: nullStore,
      fetcher: async () => {
        if (mode === 'current') fixture.context.chatCompletionSettings!.custom_url = 'https://other.example/v1';
        else fixture.connectionProfiles[0].model = 'changed-profile-model';
        return Response.json({ data: [{ id: 'late-model' }] });
      },
    });
    await assert.rejects(host.listModels({ mode, profileId: mode === 'profile' ? 'profile-a' : '' }), /发生变化/u);
  }
});

test('model list rejects unsupported/invalid connections, empty or malformed lists and safely redacts fetch failures', async () => {
  const fixture = createCharacterContext();
  let calls = 0;
  const dependencies: ReaderHostDependencies = { getContext: () => fixture.context, store: nullStore };
  const invalidHost = createReaderHost({ ...dependencies, fetcher: async () => { calls += 1; return Response.json({ data: [] }); } });
  await assert.rejects(invalidHost.listModels({ mode: 'profile', profileId: 'missing' }), /所选档案不可用/u);
  fixture.context.mainApi = 'textgenerationwebui';
  await assert.rejects(invalidHost.listModels({ mode: 'current', profileId: '' }), /仅支持酒馆 Chat Completion/u);
  assert.equal(calls, 0);
  fixture.context.mainApi = 'openai';
  for (const data of [{ data: [] }, { error: { message: 'fake-secret' }, data: [{ id: 'unused' }] }, { data: ['wrong-shape'] }]) {
    const host = createReaderHost({ ...dependencies, fetcher: async () => Response.json(data) });
    await assert.rejects(host.listModels({ mode: 'current', profileId: '' }), /没有返回可选模型列表/u);
  }
  const httpHost = createReaderHost({ ...dependencies, fetcher: async () => new Response('fake-key-response', { status: 401 }) });
  await assert.rejects(httpHost.listModels({ mode: 'current', profileId: '' }), /HTTP 401/u);
  const failureHost = createReaderHost({ ...dependencies, fetcher: async () => { throw new Error('sk-fake-secret https://mock.example?api_key=fake'); } });
  await assert.rejects(failureHost.listModels({ mode: 'current', profileId: '' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /无法拉取模型列表/u);
    assert.doesNotMatch(error.message, /sk-fake-secret|mock\.example|api_key/u);
    return true;
  });
});

test('cancelled model list rejects even if the fetch dependency ignores AbortSignal, and discards its late result', async () => {
  const fixture = createCharacterContext();
  let started!: () => void;
  let finish!: (response: Response) => void;
  const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
  const host = createReaderHost({
    getContext: () => fixture.context, store: nullStore,
    fetcher: () => new Promise<Response>((resolve) => { finish = resolve; started(); }),
  });
  const abort = new AbortController();
  const request = host.listModels({ mode: 'current', profileId: '' }, abort.signal);
  await fetchStarted;
  abort.abort();
  await assert.rejects(request, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  finish(Response.json({ data: [{ id: 'late-model' }] }));
});

test('cancelled model JSON parsing rejects safely, and already-aborted listing never sends a request', async () => {
  const fixture = createCharacterContext();
  let started!: () => void;
  let finish!: (data: unknown) => void;
  let calls = 0;
  const jsonStarted = new Promise<void>((resolve) => { started = resolve; });
  const response = new Response('');
  response.json = () => new Promise<unknown>((resolve) => { finish = resolve; started(); });
  const host = createReaderHost({
    getContext: () => fixture.context, store: nullStore,
    fetcher: async () => { calls += 1; return response; },
  });
  const abort = new AbortController();
  const request = host.listModels({ mode: 'current', profileId: '' }, abort.signal);
  await jsonStarted;
  abort.abort();
  await assert.rejects(request, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  finish({ data: [{ id: 'late-model' }] });
  await assert.rejects(host.listModels({ mode: 'current', profileId: '' }, abort.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('model list times out without waiting for a dependency that ignores cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = createCharacterContext();
  let started!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
  const host = createReaderHost({
    getContext: () => fixture.context, store: nullStore,
    fetcher: () => { started(); return new Promise<Response>(() => {}); },
  });
  const request = host.listModels({ mode: 'current', profileId: '' });
  await fetchStarted;
  t.mock.timers.tick(20_000);
  await assert.rejects(request, /拉取模型超时/u);
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
