import assert from 'node:assert/strict';
import test from 'node:test';
import { readCompletionResponse } from '../extensions/jiuguan-reader/src/completion-stream.js';
import { createReaderHost } from '../extensions/jiuguan-reader/src/host.js';
import { defaultReaderSettings } from '../extensions/jiuguan-reader/src/settings.js';
import { analyzeDocument, askDocument } from '../extensions/jiuguan-reader/src/reader-engine.js';
import type { ReaderHost, ReadingDocument, ReadingProgress, SavedReading } from '../extensions/jiuguan-reader/src/types.js';

const store: ReaderHost['store'] = { load: async () => null, save: async () => {} };
const messages = [{ role: 'user' as const, content: '虚构设定 [S1]' }];
const connection = { mode: 'custom' as const, profileId: '', baseUrl: 'https://fictional.example.test/v1', model: 'fake-model' };

function sse(events: unknown[], done = true, packetSize = 5, contentType: string | null = 'text/event-stream'): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : ''));
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += packetSize) controller.enqueue(bytes.slice(index, index + packetSize));
    controller.close();
  } }), { headers: contentType ? { 'Content-Type': contentType } : {} });
}
function delta(content: string, finish?: string): unknown {
  return { choices: [{ index: 0, delta: { content, reasoning_content: '不显示思考内容' }, finish_reason: finish ?? null }] };
}

test('流式解析跨包UTF-8、CRLF、正文增量与结束原因，不输出思考', async () => {
  const previews: string[] = [];
  const response = await readCompletionResponse(sse([delta('角色是'), delta('灯塔看守。'), delta('', 'stop')]), new AbortController().signal, (text) => previews.push(text));
  assert.deepEqual(previews, ['角色是', '角色是灯塔看守。']);
  assert.deepEqual(response, { choices: [{ message: { content: '角色是灯塔看守。' }, finish_reason: 'stop' }] });
});

test('宿主省略流式Content-Type仍逐步解析，忽略stream的无标记JSON也可读取', async () => {
  for (const contentType of [null, 'text/plain'] as const) {
    const previews: string[] = [];
    const response = await readCompletionResponse(sse([delta('逐步'), delta('显示'), delta('', 'stop')], true, 1, contentType), new AbortController().signal, (text) => previews.push(text));
    assert.deepEqual(previews, ['逐步', '逐步显示']);
    assert.deepEqual(response, { choices: [{ message: { content: '逐步显示' }, finish_reason: 'stop' }] });
  }
  const data = { choices: [{ message: { content: '完整JSON正文' }, finish_reason: 'stop' }] };
  assert.deepEqual(await readCompletionResponse(new Response(JSON.stringify(data)), new AbortController().signal), data);
});

test('Claude和Gemini正文及结束原因可解析，排除思考片段', async () => {
  const claude = await readCompletionResponse(sse([
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '隐藏思考' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '角色介绍' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]), new AbortController().signal);
  assert.deepEqual(claude, { choices: [{ message: { content: '角色介绍' }, finish_reason: 'end_turn' }] });
  const gemini = await readCompletionResponse(sse([{ candidates: [{ content: { parts: [{ thought: true, text: '隐藏思考' }, { text: '角色经历' }] }, finishReason: 'STOP' }] }]), new AbortController().signal);
  assert.deepEqual(gemini, { choices: [{ message: { content: '角色经历' }, finish_reason: 'STOP' }] });
});

test('流式独立请求逐步显示、使用自己的Key和模型，结束才返回完整正文', async () => {
  let payload: Record<string, unknown> | undefined;
  const context = { extensionSettings: {}, mainApi: 'textgenerationwebui' };
  const host = createReaderHost({ getContext: () => context, store, saveNativeSettings: async () => {}, fetcher: async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return sse([delta('旧同事'), delta('重逢。 [S1]'), delta('', 'stop')], true, 5, null);
  } });
  const settings = { ...defaultReaderSettings(), connection };
  await host.saveSettings(settings, 'fictional-key');
  const previews: string[] = [];
  assert.equal(await host.generate(messages, settings, new AbortController().signal, (text) => previews.push(text)), '旧同事重逢。 [S1]');
  assert.equal(payload?.stream, true);
  assert.equal(payload?.proxy_password, 'fictional-key');
  assert.equal(payload?.model, 'fake-model');
  assert.deepEqual(previews, ['旧同事', '旧同事重逢。 [S1]']);
});

test('当前与档案流式经过宿主原始接口，不带聊天记录、预设或其他连接密钥', async () => {
  for (const mode of ['current', 'profile'] as const) {
    let payload: Record<string, unknown> | undefined;
    const host = createReaderHost({ store, getContext: () => ({
      extensionSettings: {}, mainApi: 'openai', getChatCompletionModel: () => 'chat-model',
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'fictional-csrf' }),
      chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'https://chat.example.test/v1', secret_id: 'fictional-chat-secret', temp_openai: 0.2 },
      CONNECT_API_MAP: { profile: { selected: 'openai', source: 'custom' } },
      ConnectionManagerRequestService: { getSupportedProfiles: () => [{ id: 'separate', name: '独立档案', api: 'profile', model: 'profile-model', 'api-url': 'https://profile.example.test/v1', 'secret-id': 'fictional-profile-secret' }] },
    }), fetcher: async (url, init) => {
      assert.equal(url, '/api/backends/chat-completions/generate');
      assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), 'fictional-csrf');
      payload = JSON.parse(String(init?.body));
      return sse([delta('结果'), delta('', 'stop')], true, 5, null);
    } });
    const settings = { ...defaultReaderSettings(), connection: { mode, profileId: 'separate' } };
    assert.equal(await host.generate(messages, settings, new AbortController().signal), '结果');
    assert.deepEqual(payload?.messages, messages);
    assert.equal(payload?.stream, true);
    assert.equal(payload?.secret_id, mode === 'current' ? 'fictional-chat-secret' : 'fictional-profile-secret');
    assert.equal(payload?.custom_url, mode === 'current' ? 'https://chat.example.test/v1' : 'https://profile.example.test/v1');
    assert.equal(payload?.use_sysprompt, false);
  }
});

test('长度截断、流式错误、缺少结束原因均不当作成功，不自动重试', async () => {
  for (const [events, message] of [
    [[delta('未完', 'length')], /输出上限/u],
    [[delta('未完')], /结束原因/u],
    [[delta('部分'), { error: { message: 'invalid key fictional-key at https://private.example.test' } }], /invalid key/u],
  ] as const) {
    let calls = 0;
    const context = { extensionSettings: {} };
    const host = createReaderHost({ getContext: () => context, store, saveNativeSettings: async () => {}, fetcher: async () => { calls += 1; return sse([...events]); } });
    const settings = { ...defaultReaderSettings(), connection };
    await host.saveSettings(settings, 'fictional-key');
    await assert.rejects(host.generate(messages, settings, new AbortController().signal), (error: Error) => {
      assert.match(error.message, message);
      assert.equal(error.message.includes('fictional-key'), false);
      assert.equal(error.message.includes('https://private'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('取消等待中的流可立即结束，不保存部分结果', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const pending = readCompletionResponse(response, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('接口忽略stream返回JSON仍能完成，不重试；档案代理只用自身Key且中途变更会停止', async () => {
  let proxyKey = 'fictional-profile-proxy-key';
  let calls = 0;
  const host = createReaderHost({ store, getContext: () => ({
    extensionSettings: {}, CONNECT_API_MAP: { profile: { selected: 'openai', source: 'openai' } },
    ConnectionManagerRequestService: { getSupportedProfiles: () => [{ id: 'profile', name: '档案', api: 'profile', model: 'fake', proxy: 'separate' }] },
  }), getProfileProxyEndpoint: () => 'https://separate.example.test/v1', getProfileProxyPassword: () => proxyKey,
  fetcher: async (_url, init) => {
    calls += 1;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.proxy_password, 'fictional-profile-proxy-key');
    assert.equal(payload.reverse_proxy, 'https://separate.example.test/v1');
    return Response.json({ choices: [{ message: { content: '完成正文' }, finish_reason: 'stop' }] });
  } });
  const settings = { ...defaultReaderSettings(), connection: { mode: 'profile' as const, profileId: 'profile' } };
  const signal = new AbortController().signal;
  assert.equal(await host.generate(messages, settings, signal), '完成正文');
  assert.equal(calls, 1);
  proxyKey = 'fictional-changed';
  await assert.rejects(host.generate(messages, settings, signal), /代理 Key.*变化/u);
  assert.equal(calls, 1);
});

test('小卡追问一次直接查原文，流式预览传入进度，最终引用仍验证', async () => {
  const document: ReadingDocument = { characterKey: 'fake', characterName: 'Mara', fingerprint: 'same', worldbooks: [], warnings: [], sources: [{ id: '[S1]', label: '人物', text: 'Mara and the player are former colleagues.' }] };
  const saved: SavedReading = { schemaVersion: 1, characterKey: 'fake', characterName: 'Mara', fingerprint: 'same', analysis: '旧解读', chunkNotes: [], sourceCount: 1, chunkCount: 1, sources: document.sources, worldbooks: [], warnings: [], readAt: '2026-10-01T00:00:00Z', model: 'fake', answers: [] };
  const progress: ReadingProgress[] = [];
  let calls = 0;
  const generate: ReaderHost['generate'] = async (input, _settings, _signal, onText) => {
    calls += 1;
    assert.match(input[1].content, /former colleagues/u);
    onText?.('旧同事');
    onText?.('旧同事 [S1]');
    return '旧同事 [S1]';
  };
  assert.equal((await askDocument(document, saved, '人物关系？', defaultReaderSettings(), generate, new AbortController().signal, (item) => progress.push(item))).text, '旧同事 [S1]');
  assert.equal(calls, 1);
  assert.deepEqual(progress.filter((item) => item.preview).map((item) => item.preview), ['旧同事', '旧同事 [S1]']);
  assert.equal((await analyzeDocument(document, defaultReaderSettings(), generate, new AbortController().signal)).chunkCount, 1);
  assert.equal(calls, 2);
});
