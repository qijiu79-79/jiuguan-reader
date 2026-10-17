import assert from 'node:assert/strict';
import test from 'node:test';
import { ReaderController } from '../extensions/jiuguan-reader/src/controller.js';
import { defaultReaderSettings } from '../extensions/jiuguan-reader/src/settings.js';
import type { ReaderHost, ReadingDocument, ReadingMaterial, SavedReading } from '../extensions/jiuguan-reader/src/types.js';

const sources = [{ id: '[S1]', label: '角色设定与经历', text: 'Mira once worked as a lighthouse keeper.' }];
const documentFor = (key = 'mira.png', fingerprint = 'fingerprint-1'): ReadingDocument => ({
  characterKey: key, characterName: 'Mira', fingerprint, sources, worldbooks: [], warnings: [],
});
const previous = (): SavedReading => ({
  schemaVersion: 1, characterKey: 'mira.png', characterName: 'Mira', fingerprint: 'fingerprint-1',
  analysis: '旧解读 [S1]', chunkNotes: [], sourceCount: 1, chunkCount: 1, sources, worldbooks: [], warnings: [],
  readAt: '2026-10-01T00:00:00.000Z', model: '假模型', answers: [],
});

function setup(
  initial: SavedReading | null = previous(),
  buildDocument: (material: ReadingMaterial) => Promise<ReadingDocument> = async (material) => documentFor(material.characterKey),
) {
  let saved = initial;
  let key = 'mira.png';
  let materialError = '';
  let generationCount = 0;
  let saveCount = 0;
  let failSave = false;
  const host: ReaderHost = {
    getMaterial: async (): Promise<ReadingMaterial> => {
      if (materialError) throw new Error(materialError);
      return { characterKey: key, characterName: 'Mira', card: {}, worldbooks: [], warnings: [] };
    },
    getSettings: defaultReaderSettings,
    saveSettings: async () => {},
    getProfiles: () => [],
    getConnectionInfo: () => ({ label: '假连接', source: 'custom', model: '假模型' }),
    listModels: async () => ['假模型'],
    describeConnection: () => '假模型',
    generate: async () => { generationCount += 1; return '新解读 [S1]'; },
    store: {
      load: async (requested) => saved?.characterKey === requested ? structuredClone(saved) : null,
      save: async (record) => {
        saveCount += 1;
        if (failSave) throw new Error('模拟写入失败');
        saved = structuredClone(record);
      },
    },
  };
  const controller = new ReaderController(host, {
    buildDocument,
    analyze: async (_document, settings, generate, signal) => ({ text: await generate([], settings, signal), chunkNotes: [], chunkCount: 1 }),
    ask: async (_document, _saved, question, settings, generate, signal) => ({ text: `${question}：${await generate([], settings, signal)}`, chunkNotes: [], chunkCount: 1 }),
    now: () => '2026-10-01T01:00:00.000Z', uuid: () => 'answer-1',
  });
  return {
    controller,
    host,
    getSaved: () => saved,
    counts: () => ({ generationCount, saveCount }),
    setKey: (next: string) => { key = next; },
    failMaterial: (message: string) => { materialError = message; },
    failSave: (fail: boolean) => { failSave = fail; },
  };
}

test('打开卡片只读取已保存的解读，不调用模型；成功解读自动保存并可重开', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  assert.equal(fixture.controller.getState().record?.analysis, '旧解读 [S1]');
  assert.equal(fixture.counts().generationCount, 0);
  await fixture.controller.read();
  assert.equal(fixture.getSaved()?.analysis, '新解读 [S1]');
  assert.equal(fixture.controller.getState().unsaved, false);
  await fixture.controller.loadCurrent();
  assert.equal(fixture.counts().generationCount, 1);
  assert.equal(fixture.controller.getState().record?.analysis, '新解读 [S1]');
});

test('快捷和自由追问保存为问答，不覆盖概览', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  await fixture.controller.question('角色经历过什么？');
  assert.equal(fixture.getSaved()?.analysis, '旧解读 [S1]');
  assert.equal(fixture.getSaved()?.answers[0].question, '角色经历过什么？');
  assert.equal(fixture.getSaved()?.answers[0].model, '假模型');
  assert.equal(fixture.controller.getState().unsaved, false);
});

test('持久独立Key只用于连接，不进入保存的解读、追问和来源快照', async () => {
  const fixture = setup();
  const fakeKey = 'fictional-persistent-reader-key';
  fixture.host.getSettings = () => ({ ...defaultReaderSettings(), customApiKeys: { 'https://fictional.example.test/v1': fakeKey } });
  await fixture.controller.loadCurrent();
  await fixture.controller.read();
  await fixture.controller.question('玩家与角色的关系？');
  assert.equal(fixture.counts().saveCount, 2);
  assert.equal(JSON.stringify(fixture.getSaved()).includes(fakeKey), false);
});

test('流式部分回答只是预览，失败或停止时不保存，也不覆盖旧解读', async () => {
  for (const cancel of [false, true]) {
    const fixture = setup();
    const controller = new ReaderController(fixture.host, { buildDocument: async () => documentFor() });
    const previews: string[] = [];
    controller.subscribe((state) => { if (state.progress?.preview) previews.push(state.progress.preview); });
    fixture.host.generate = async (_messages, _settings, signal, onText) => {
      onText?.('尚未完成的部分回答');
      if (cancel) { controller.cancel(); signal.throwIfAborted(); }
      throw new Error('模拟流中断');
    };
    await controller.loadCurrent();
    await controller.question('人物关系？');
    assert.deepEqual(previews, ['尚未完成的部分回答']);
    assert.equal(fixture.counts().saveCount, 0);
    assert.equal(controller.getState().record?.analysis, '旧解读 [S1]');
    assert.equal(controller.getState().record?.answers.length, 0);
    assert.equal(controller.getState().progress, null);
    assert.equal(controller.getState().busy, false);
  }
});

test('重新解读失败或取消保留旧结果，不写入存储', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  fixture.host.generate = async () => { throw new Error('模型不可用'); };
  await fixture.controller.read();
  assert.equal(fixture.getSaved()?.analysis, '旧解读 [S1]');
  assert.equal(fixture.counts().saveCount, 0);
  assert.match(fixture.controller.getState().error, /模型不可用/u);
  fixture.host.generate = async (_messages, _settings, signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const job = fixture.controller.read();
  fixture.controller.cancel();
  await job;
  assert.equal(fixture.getSaved()?.analysis, '旧解读 [S1]');
  assert.equal(fixture.counts().saveCount, 0);
  assert.equal(fixture.controller.getState().busy, false);
});

test('切换角色和重开面板不取消后台解读，完成后只保存任务原卡', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  let resolve!: (text: string) => void;
  let jobSignal!: AbortSignal;
  fixture.host.generate = async (_messages, _settings, signal) => {
    jobSignal = signal;
    return new Promise<string>((done) => { resolve = done; });
  };
  const results: unknown[] = [];
  fixture.controller.subscribeJobs((result) => results.push(result));
  const job = fixture.controller.read();
  fixture.setKey('other.png');
  await fixture.controller.loadCurrent();
  assert.equal(jobSignal.aborted, false);
  assert.equal(fixture.controller.getState().document?.characterKey, 'mira.png');
  assert.equal(fixture.controller.getState().busy, true);
  resolve('迟到的解读');
  await job;
  assert.equal(fixture.getSaved()?.characterKey, 'mira.png');
  assert.equal(fixture.getSaved()?.analysis, '迟到的解读');
  assert.equal(fixture.counts().saveCount, 1);
  assert.deepEqual(results, [{ kind: 'read', characterKey: 'mira.png', characterName: 'Mira', outcome: 'saved' }]);
  await fixture.controller.loadCurrent();
  assert.equal(fixture.controller.getState().document?.characterKey, 'other.png');
  assert.equal(fixture.controller.getState().record, null);
  assert.equal(fixture.getSaved()?.analysis, '迟到的解读');
  assert.equal(fixture.counts().saveCount, 1);
});

test('追问在后台继续，重复加载不重发请求，保存结束后仅通知一次', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  let finish!: (text: string) => void;
  let requests = 0;
  fixture.host.generate = async () => {
    requests += 1;
    return new Promise<string>((resolve) => { finish = resolve; });
  };
  let finishSave!: () => void;
  const originalSave = fixture.host.store.save;
  fixture.host.store.save = async (record) => {
    await new Promise<void>((resolve) => { finishSave = resolve; });
    await originalSave(record);
  };
  const results: unknown[] = [];
  fixture.controller.subscribeJobs((result) => results.push(result));
  const job = fixture.controller.question('人物关系？');
  await fixture.controller.loadCurrent();
  await fixture.controller.loadCurrent();
  await fixture.controller.question('重复提问？');
  assert.equal(requests, 1);
  finish('后台回答 [S1]');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(results, [], '存储尚未成功时不能通知已保存');
  await fixture.controller.loadCurrent();
  assert.equal(fixture.controller.getState().busy, true);
  finishSave();
  await job;
  assert.equal(fixture.getSaved()?.answers.length, 1);
  assert.match(fixture.getSaved()!.answers[0].answer, /后台回答/u);
  assert.deepEqual(results, [{ kind: 'question', characterKey: 'mira.png', characterName: 'Mira', outcome: 'saved' }]);
});

test('后台保存失败保留原卡未保存结果，通知不谎报成功，重开和切卡不覆盖', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  fixture.failSave(true);
  const results: unknown[] = [];
  fixture.controller.subscribeJobs((result) => results.push(result));
  await fixture.controller.read();
  fixture.setKey('other.png');
  await fixture.controller.loadCurrent();
  assert.equal(fixture.controller.getState().document?.characterKey, 'mira.png');
  assert.equal(fixture.controller.getState().record?.analysis, '新解读 [S1]');
  assert.equal(fixture.controller.getState().unsaved, true);
  assert.deepEqual(results, [{ kind: 'read', characterKey: 'mira.png', characterName: 'Mira', outcome: 'unsaved' }]);
  fixture.failSave(false);
  await fixture.controller.save();
  assert.equal(fixture.getSaved()?.characterKey, 'mira.png');
});

test('只有主动停止才取消后台生成，不发完成通知；生成失败通知但不改旧记录', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  const results: unknown[] = [];
  const unsubscribe = fixture.controller.subscribeJobs((result) => results.push(result));
  fixture.host.generate = async (_messages, _settings, signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const job = fixture.controller.question('后台问题？');
  await fixture.controller.loadCurrent();
  fixture.controller.cancel();
  await job;
  assert.deepEqual(results, []);
  assert.equal(fixture.counts().saveCount, 0);
  fixture.host.generate = async () => { throw new Error('假接口失败'); };
  await fixture.controller.read();
  assert.deepEqual(results, [{ kind: 'read', characterKey: 'mira.png', characterName: 'Mira', outcome: 'failed' }]);
  assert.equal(fixture.getSaved()?.analysis, '旧解读 [S1]');
  unsubscribe();
  await fixture.controller.read();
  assert.equal(results.length, 1);
});

test('保存失败明确标为未保存，可重试；不得用新任务覆盖未保存结果', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  fixture.failSave(true);
  await fixture.controller.read();
  assert.equal(fixture.getSaved()?.analysis, '旧解读 [S1]');
  assert.equal(fixture.controller.getState().record?.analysis, '新解读 [S1]');
  assert.equal(fixture.controller.getState().unsaved, true);
  assert.match(fixture.controller.getState().error, /保存失败/u);
  await fixture.controller.read();
  assert.equal(fixture.counts().generationCount, 1);
  fixture.failSave(false);
  await fixture.controller.save();
  assert.equal(fixture.getSaved()?.analysis, '新解读 [S1]');
  assert.equal(fixture.controller.getState().unsaved, false);
});

test('设定变动后仍可追问保存的完整原文，不混用当前资料或改写旧解读', async () => {
  const saved = {
    ...previous(), fingerprint: 'old-fingerprint', sourceCount: 2,
    sources: [
      { id: '[S1]', label: '旧角色设定', text: 'SAVED_CHARACTER_ONLY: Mira once kept the lighthouse.' },
      { id: '[S2]', label: '旧世界书', text: 'SAVED_WORLDBOOK_ONLY: Her sister tends the lamp.' },
    ],
    worldbooks: ['已保存的世界书'], warnings: ['已保存的读取范围提示'],
  };
  const current = {
    ...documentFor('mira.png', 'current-fingerprint'),
    sources: [{ id: '[S1]', label: '新角色设定', text: 'CURRENT_CHARACTER_ONLY: Mira moved to the desert.' }],
    worldbooks: ['当前世界书'], warnings: ['当前读取范围提示'],
  };
  const fixture = setup(saved);
  const requests: string[] = [];
  fixture.host.generate = async (messages) => {
    requests.push(messages.find((message) => message.role === 'user')?.content ?? '');
    return '她的姐姐照看灯塔 [S2]。';
  };
  const controller = new ReaderController(fixture.host, { buildDocument: async () => current, uuid: () => 'saved-source-answer' });
  await controller.loadCurrent();
  assert.equal(requests.length, 0, '打开旧解读不自动重读或改写存储');
  assert.equal(fixture.counts().saveCount, 0);
  for (const question of ['人物关系？', '她的姐姐做什么？']) {
    await controller.question(question);
    await controller.loadCurrent();
  }
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(request, /SAVED_CHARACTER_ONLY/u);
    assert.match(request, /SAVED_WORLDBOOK_ONLY/u);
    assert.match(request, /已保存的读取范围提示/u);
    assert.doesNotMatch(request, /CURRENT_CHARACTER_ONLY|当前世界书|当前读取范围提示/u);
  }
  const result = fixture.getSaved()!;
  assert.deepEqual({ ...result, answers: [] }, saved);
  assert.deepEqual(result.answers.map((answer) => answer.question), ['人物关系？', '她的姐姐做什么？']);
  assert.ok(result.answers.every((answer) => answer.answer.includes('[S2]')));
  assert.equal(controller.getState().document?.fingerprint, 'current-fingerprint');
  assert.equal(controller.getState().unsaved, false);

  await controller.read();
  assert.match(requests.at(-1)!, /CURRENT_CHARACTER_ONLY/u);
  assert.doesNotMatch(requests.at(-1)!, /SAVED_CHARACTER_ONLY|SAVED_WORLDBOOK_ONLY/u);
  assert.equal(fixture.getSaved()?.fingerprint, current.fingerprint);
  assert.deepEqual(fixture.getSaved()?.sources, current.sources);
  assert.deepEqual(fixture.getSaved()?.answers, [], '只有主动重新解读才替换旧概览与追问');
});

test('旧解读缺少完整原文时不借用新版资料追问，明确提示重新解读', async () => {
  for (const sources of [[], previous().sources.slice(0, 1)]) {
    const fixture = setup({ ...previous(), fingerprint: 'old-fingerprint', sourceCount: 2, sources });
    await fixture.controller.loadCurrent();
    await fixture.controller.question('人物关系？');
    assert.deepEqual(fixture.counts(), { generationCount: 0, saveCount: 0 });
    assert.match(fixture.controller.getState().error, /缺少完整原文.*重新解读/u);
    assert.equal(fixture.getSaved()?.analysis, '旧解读 [S1]');
  }
});

test('旧原文追问失败或停止时保留已有解读、来源和回答', async () => {
  for (const cancel of [false, true]) {
    const saved = { ...previous(), fingerprint: 'old-fingerprint' };
    const fixture = setup(saved);
    await fixture.controller.loadCurrent();
    fixture.host.generate = async (_messages, _settings, signal) => {
      if (cancel) { fixture.controller.cancel(); signal.throwIfAborted(); }
      throw new Error('模拟旧原文追问失败');
    };
    await fixture.controller.question('人物关系？');
    assert.deepEqual(fixture.getSaved(), saved);
    assert.equal(fixture.counts().saveCount, 0);
    assert.deepEqual(fixture.controller.getState().record, saved);
    assert.equal(fixture.controller.getState().busy, false);
  }
});

test('当前资料与已存记录不是同一角色时不追问或保存', async () => {
  const fixture = setup();
  fixture.host.store.load = async () => ({ ...previous(), characterKey: 'other.png' });
  await fixture.controller.loadCurrent();
  await fixture.controller.question('人物关系？');
  assert.deepEqual(fixture.counts(), { generationCount: 0, saveCount: 0 });
  assert.match(fixture.controller.getState().error, /不是同一角色/u);
});

test('模型名称按任务开始时记录，不将生成途中切换的新模型记为本次来源', async () => {
  const fixture = setup();
  let model = '开始时的模型';
  fixture.host.describeConnection = () => model;
  fixture.host.generate = async () => {
    model = '之后切换的模型';
    return '新解读 [S1]';
  };
  await fixture.controller.loadCurrent();
  await fixture.controller.read();
  assert.equal(fixture.getSaved()?.model, '开始时的模型');
  model = '追问开始时的模型';
  await fixture.controller.question('有哪些经历？');
  assert.equal(fixture.getSaved()?.answers[0].model, '追问开始时的模型');
});

test('旧记录读取失败仍保留可读资料和同卡已显示结果，不自动调用模型或改保存文件', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  fixture.host.store.load = async () => { throw new Error('模拟连接失败'); };
  await fixture.controller.loadCurrent();
  assert.equal(fixture.controller.getState().record?.analysis, '旧解读 [S1]');
  assert.equal(fixture.controller.getState().document?.characterKey, 'mira.png');
  assert.match(fixture.controller.getState().error, /读取失败/u);
  fixture.setKey('other.png');
  await fixture.controller.loadCurrent();
  assert.equal(fixture.controller.getState().record, null, '不能把上一张卡的结果当作新卡记录');
  assert.equal(fixture.controller.getState().document?.characterKey, 'other.png');
  assert.equal(fixture.counts().generationCount, 0);
  assert.equal(fixture.counts().saveCount, 0);
});

test('切卡后取卡或构建文档失败时只保留旧记录，禁用读卡和追问且不自动请求或保存', async (t) => {
  for (const failure of ['取卡失败', '构建文档失败'] as const) {
    await t.test(failure, async () => {
      let failBuild = false;
      const fixture = setup(previous(), async (material) => {
        if (failBuild) throw new Error('模拟建档失败');
        return documentFor(material.characterKey);
      });
      await fixture.controller.loadCurrent();
      fixture.setKey('other.png');
      if (failure === '取卡失败') fixture.failMaterial('模拟取卡失败');
      else failBuild = true;

      await fixture.controller.loadCurrent();

      const state = fixture.controller.getState();
      assert.equal(state.document, null, '失败后不能把此前角色的 document 当作当前资料');
      assert.equal(state.record?.characterKey, 'mira.png');
      assert.equal(state.record?.characterName, 'Mira');
      assert.equal(state.record?.analysis, '旧解读 [S1]');
      assert.match(state.status, /此前「Mira」的已保存解读仍保留/u);
      assert.match(state.status, /当前资料未取得/u);
      assert.match(state.status, /没有调用 AI/u);
      assert.match(state.error, /模拟取卡失败|模拟建档失败/u);

      await fixture.controller.read();
      await fixture.controller.question('旧记录是不是新角色的设定？');
      assert.deepEqual(fixture.counts(), { generationCount: 0, saveCount: 0 });
      assert.equal(fixture.controller.getState().document, null);
      assert.equal(fixture.controller.getState().record?.characterKey, 'mira.png');
    });
  }
});
