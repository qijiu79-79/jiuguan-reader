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

test('切换角色后迟到的回答不会写入新卡或覆盖旧卡', async () => {
  const fixture = setup();
  await fixture.controller.loadCurrent();
  let resolve!: (text: string) => void;
  fixture.host.generate = async () => new Promise<string>((done) => { resolve = done; });
  const job = fixture.controller.read();
  fixture.setKey('other.png');
  await fixture.controller.loadCurrent();
  resolve('迟到的解读');
  await job;
  assert.equal(fixture.controller.getState().document?.characterKey, 'other.png');
  assert.equal(fixture.controller.getState().record, null);
  assert.equal(fixture.getSaved()?.analysis, '旧解读 [S1]');
  assert.equal(fixture.counts().saveCount, 0);
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

test('设定变动后保留旧解读，但不混用旧来源进行追问', async () => {
  const fixture = setup({ ...previous(), fingerprint: 'old-fingerprint' });
  await fixture.controller.loadCurrent();
  await fixture.controller.question('现在的关系是什么？');
  assert.equal(fixture.counts().generationCount, 0);
  assert.match(fixture.controller.getState().error, /已变化/u);
  assert.equal(fixture.getSaved()?.analysis, '旧解读 [S1]');
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
