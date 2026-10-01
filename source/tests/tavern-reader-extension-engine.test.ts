import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultReaderSettings } from '../extensions/jiuguan-reader/src/settings.js';
import { analyzeDocument, askDocument } from '../extensions/jiuguan-reader/src/reader-engine.js';
import type {
  GenerateReading,
  ReaderMessage,
  ReaderSettings,
  ReadingDocument,
  ReadingProgress,
  SavedReading,
} from '../extensions/jiuguan-reader/src/types.js';

test('analysis uses the exact configured system prompt and user prompt, then validates citations', async () => {
  const document = readingDocument([
    { id: '[S1]', label: '人物经历', text: 'Mina searched for her sister for years.' },
    { id: '[S2]', label: '世界书 · Old Promise', text: 'When Mina remembers the promise, she becomes quiet.' },
  ]);
  const settings = settingsFixture();
  settings.systemPrompt = '  用户定制的 system，原样保留。\n';
  settings.analysisPrompt = '\n用户定制的 analysis 提示词，保留首尾空格。  \n';
  const requests: ReaderMessage[][] = [];
  const generate: GenerateReading = async (messages) => {
    requests.push(messages.map((message) => ({ ...message })));
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    if (user.includes('<原文资料>')) return '人物经历有明确依据 [S1]；伪造引用 [S99]。';
    return '整体总结仍有依据 [S1]，错误编号 [S88]。';
  };

  const result = await analyzeDocument(document, settings, generate, new AbortController().signal);

  assert.equal(result.chunkCount, 1);
  assert.equal(result.chunkNotes.length, 1);
  assert.match(result.chunkNotes[0], /人物经历有明确依据 \[S1\]/u);
  assert.match(result.chunkNotes[0], /\[无对应原文来源\]/u);
  assert.match(result.text, /整体总结仍有依据 \[S1\]/u);
  assert.match(result.text, /\[无对应原文来源\]/u);
  assert.ok(requests.length >= 2, 'one reading call and one final synthesis call are expected');
  for (const messages of requests) {
    const systems = messages.filter((message) => message.role === 'system');
    assert.equal(systems.length, 1);
    assert.equal(systems[0].content, settings.systemPrompt);
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    assert.ok(user.startsWith(settings.analysisPrompt), 'analysis prompt must appear verbatim at the start of user content');
    assert.equal(messages.length, 2, 'no hidden system message may be added');
  }
});

test('long source text is read in full, then long chunk notes are combined through the hierarchy', async () => {
  const markers = Array.from({ length: 110 }, (_, index) => `SEGMENT_${String(index).padStart(3, '0')}`);
  const longText = markers.map((marker) => `${marker} ${'Mina remembers the old promise. '.repeat(18)}`).join('\n');
  const document = readingDocument([{ id: '[S1]', label: '超长人物经历', text: longText }]);
  const settings = settingsFixture(6_000);
  const requests: string[] = [];
  let reductionCalls = 0;
  let activeCalls = 0;
  let maximumConcurrentCalls = 0;
  const progress: ReadingProgress[] = [];
  const generate: GenerateReading = async (messages) => {
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    requests.push(user);
    activeCalls += 1;
    maximumConcurrentCalls = Math.max(maximumConcurrentCalls, activeCalls);
    await Promise.resolve();
    if (user.includes('<原文资料>')) {
      activeCalls -= 1;
      return `逐段经历依据 [S1]。${'人物经历细节。'.repeat(150)}`;
    }
    if (user.includes('<待合并分块笔记>')) {
      reductionCalls += 1;
      activeCalls -= 1;
      return `合并后的经历线索 [S1]（第 ${reductionCalls} 组）。`;
    }
    activeCalls -= 1;
    return '完整经历概览 [S1]。';
  };

  const result = await analyzeDocument(document, settings, generate, new AbortController().signal, (item) => progress.push(item));

  assert.ok(result.chunkCount > 1, `expected several chunks, got ${result.chunkCount}`);
  assert.equal(result.chunkNotes.length, result.chunkCount);
  assert.ok(result.chunkNotes.every((note) => note.includes('[S1]')));
  assert.ok(reductionCalls > 0, 'oversized notes should go through hierarchical combining');
  assert.equal(maximumConcurrentCalls, 1, 'requests must stay sequential while the host API connection is in use');
  assert.match(result.text, /完整经历概览 \[S1\]/u);
  for (const marker of markers) {
    assert.ok(requests.some((request) => request.includes(marker)), `raw source marker ${marker} was not sent`);
  }
  const finalReadProgress = progress.filter((item) => item.phase === 'reading').at(-1);
  assert.equal(finalReadProgress?.completed, result.chunkCount);
  assert.equal(finalReadProgress?.total, result.chunkCount);
  assert.equal(finalReadProgress?.sourceCount, 1, 'a source counts as covered only after its last range is read');
  assert.ok(progress.some((item) => item.phase === 'combining'));
});

test('follow-up scans raw original sources instead of relying only on the saved summary', async () => {
  const markers = Array.from({ length: 80 }, (_, index) => `RAW_FACT_${String(index).padStart(3, '0')}`);
  const longText = markers.map((marker) => `${marker} ${'The character remembers a difficult journey. '.repeat(14)}`).join('\n');
  const document = readingDocument([{ id: '[S1]', label: '完整角色设定', text: longText }]);
  const settings = settingsFixture(5_500);
  const saved = savedReading(document);
  const userCalls: string[] = [];
  const progress: ReadingProgress[] = [];
  const generate: GenerateReading = async (messages) => {
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    userCalls.push(user);
    if (user.includes('<原文资料>')) return '这一段的原文经历 [S1]。';
    return '追问答案由原文核对得出 [S1]。';
  };

  const result = await askDocument(
    document,
    saved,
    '这个角色有哪些重要经历？',
    settings,
    generate,
    new AbortController().signal,
    (item) => progress.push(item),
  );

  assert.ok(result.chunkCount > 1);
  assert.equal(result.chunkNotes.length, result.chunkCount);
  assert.match(result.text, /追问答案由原文核对得出 \[S1\]/u);
  for (const marker of markers) {
    assert.ok(userCalls.some((request) => request.includes(marker)), `follow-up did not inspect raw source marker ${marker}`);
  }
  assert.ok(userCalls.some((request) => request.includes('只依赖已保存的摘要')));
  assert.equal(progress.filter((item) => item.phase === 'reading').at(-1)?.sourceCount, 1);
});

test('an empty model result is an explicit error and a cancelled read stops before calling the model', async () => {
  const document = readingDocument([{ id: '[S1]', label: '人物经历', text: 'A complete source.' }]);
  const settings = settingsFixture();
  let calls = 0;
  const empty: GenerateReading = async () => { calls += 1; return ' \n '; };
  await assert.rejects(
    analyzeDocument(document, settings, empty, new AbortController().signal),
    /第 1 个资料分块没有返回内容/u,
  );
  assert.equal(calls, 1);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    analyzeDocument(document, settings, async () => { calls += 1; return 'should not run'; }, controller.signal),
    (error: Error) => error.name === 'AbortError' && /取消/u.test(error.message),
  );
  assert.equal(calls, 1, 'pre-cancelled work must not reach the model');
});

test('cancellation during a model call stops before the next chunk', async () => {
  const document = readingDocument([{ id: '[S1]', label: '长资料', text: `${'A complete source line.\n'.repeat(4_000)}` }]);
  const settings = settingsFixture(5_000);
  const controller = new AbortController();
  let calls = 0;
  const generate: GenerateReading = async () => {
    calls += 1;
    controller.abort();
    return '完成了当前分块 [S1]。';
  };

  await assert.rejects(
    analyzeDocument(document, settings, generate, controller.signal),
    (error: Error) => error.name === 'AbortError',
  );
  assert.equal(calls, 1);
});

test('a follow-up refuses stale saved readings before any model request', async () => {
  const document = readingDocument([{ id: '[S1]', label: '人物经历', text: 'A complete source.' }]);
  const saved = savedReading(document);
  saved.fingerprint = 'stale-fingerprint';
  let calls = 0;

  await assert.rejects(
    askDocument(document, saved, '问一个问题', settingsFixture(), async () => { calls += 1; return '不应调用'; }, new AbortController().signal),
    /已变化；请先重新读卡/u,
  );
  assert.equal(calls, 0);
});

test('缺失世界书与排除范围告知模型和汇总，不把缺失资料说成已读完', async () => {
  const document = readingDocument([{ id: '[S1]', label: '人物经历', text: 'A complete character history.' }]);
  document.warnings = ['角色关联世界书「缺失测试书」无法读取；本次内容可能不完整。'];
  const calls: ReaderMessage[][] = [];
  const generate: GenerateReading = async (messages) => { calls.push(messages); return '只基于现有资料 [S1]。'; };
  await analyzeDocument(document, settingsFixture(), generate, new AbortController().signal);
  await askDocument(document, savedReading(document), '角色经历过什么？', settingsFixture(), generate, new AbortController().signal);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    const user = call.find((message) => message.role === 'user')?.content ?? '';
    assert.match(user, /缺失测试书.*无法读取/u);
    assert.match(user, /不把未取得的世界书/u);
    assert.equal(call.filter((message) => message.role === 'system').length, 1);
  }
});

test('大量短世界书条目按实际分隔符计入预算，各条正文仍完整发送', async () => {
  const settings = settingsFixture(5_000);
  for (let size = 80; size <= 100; size += 1) {
    const sources = Array.from({ length: 70 }, (_, index) => ({
      id: `[S${index + 1}]`, label: `世界书 · 条目 ${index + 1}`,
      text: `UNIQUE_${index}_START ${'X'.repeat(size)} UNIQUE_${index}_END`, note: '条件触发',
    }));
    const requests: string[] = [];
    await analyzeDocument(readingDocument(sources), settings, async (messages) => {
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      assert.ok(user.length + settings.systemPrompt.length + 512 + 256 <= settings.contextChars, '分隔符不能偷偷挤占预算');
      requests.push(user);
      return '全部按原文读取。';
    }, new AbortController().signal);
    for (let index = 0; index < sources.length; index += 1) {
      assert.ok(requests.some((request) => request.includes(sources[index].text)), `条目 ${index} 没有完整发送`);
    }
  }
});

function readingDocument(sources: ReadingDocument['sources']): ReadingDocument {
  return {
    characterKey: 'character:test',
    characterName: 'Test Character',
    fingerprint: 'a'.repeat(64),
    sources,
    worldbooks: [],
    warnings: [],
  };
}

function settingsFixture(contextChars = 24_000): ReaderSettings {
  const defaults = defaultReaderSettings();
  return {
    ...defaults,
    systemPrompt: 'System prompt from the user.',
    analysisPrompt: 'Review important history and how it shaped the character.',
    contextChars,
    maxOutputTokens: 256,
  };
}

function savedReading(document: ReadingDocument): SavedReading {
  return {
    schemaVersion: 1,
    characterKey: document.characterKey,
    characterName: document.characterName,
    fingerprint: document.fingerprint,
    analysis: 'A saved overview that is not a substitute for the original sources.',
    chunkNotes: ['Saved note with no raw-text detail.'],
    sourceCount: document.sources.length,
    chunkCount: 1,
    sources: document.sources,
    worldbooks: document.worldbooks,
    warnings: document.warnings,
    readAt: new Date(0).toISOString(),
    model: 'fake-model',
    answers: [],
  };
}
