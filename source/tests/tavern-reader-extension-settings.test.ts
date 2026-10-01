import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ANALYSIS_PROMPT, LEGACY_ANALYSIS_PROMPT, defaultReaderSettings, normalizeReaderSettings } from '../extensions/jiuguan-reader/src/settings.js';

test('默认介绍500字以内，只讲设定经历和玩家关系，不推荐玩法；默认流式', () => {
  assert.match(DEFAULT_ANALYSIS_PROMPT, /500 字以内/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /关键经历/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /玩家和人物的关系/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /不要分析主要矛盾/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /不解读开场白/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /作者注释、标签、版本/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /禁用/u);
  assert.equal(defaultReaderSettings().connection.mode, 'current');
  assert.equal(defaultReaderSettings().stream, true);
});

test('只迁移旧版原封不动的默认提示词，不覆盖用户改过的提示；流式开关可保存', () => {
  assert.equal(normalizeReaderSettings({ analysisPrompt: LEGACY_ANALYSIS_PROMPT }).analysisPrompt, DEFAULT_ANALYSIS_PROMPT);
  assert.equal(normalizeReaderSettings({ analysisPrompt: `${LEGACY_ANALYSIS_PROMPT}\n我的补充` }).analysisPrompt, `${LEGACY_ANALYSIS_PROMPT}\n我的补充`);
  assert.equal(normalizeReaderSettings({ stream: false }).stream, false);
  assert.equal(normalizeReaderSettings({}).stream, true);
});

test('用户提示词包括空白和换行均保留原样，空系统提示词也不补写', () => {
  const settings = normalizeReaderSettings({ systemPrompt: '  我自己的系统提示词\n', analysisPrompt: '\n只讲经历\n' });
  assert.equal(settings.systemPrompt, '  我自己的系统提示词\n');
  assert.equal(settings.analysisPrompt, '\n只讲经历\n');
  assert.equal(normalizeReaderSettings({ systemPrompt: '' }).systemPrompt, '');
});

test('连接档案只保存配置ID，不采纳乱放的API密钥字段，快捷问题可修改和去重', () => {
  const settings = normalizeReaderSettings({
    apiKey: 'fake-key-do-not-store', connection: { mode: 'profile', profileId: 'fictional-profile', apiKey: 'fake' },
    quickQuestions: [' 经历？ ', '经历？', '', 4, '关系？'], contextChars: 96000, maxOutputTokens: 12000,
  });
  assert.deepEqual(settings.connection, { mode: 'profile', profileId: 'fictional-profile' });
  assert.deepEqual(settings.quickQuestions, ['经历？', '关系？']);
  assert.equal(settings.contextChars, 96000);
  assert.equal(settings.maxOutputTokens, 12000);
  assert.equal('apiKey' in settings, false);
});

test('独立Key按规范化地址保存，忽略非法地址和换行，新对象不共享字典', () => {
  const input = { customApiKeys: {
    ' https://fictional.example.test/v1/chat/completions ': ' fictional-key ',
    'https://second.example.test': 'fictional-second',
    'https://bad.example.test?key=fake': 'fictional-invalid',
    'file:///private/fake': 'fictional-invalid',
    'https://empty.example.test': ' ',
    'https://newline.example.test': 'fictional\ninvalid',
  } };
  const settings = normalizeReaderSettings(input);
  assert.deepEqual(settings.customApiKeys, {
    'https://fictional.example.test/v1': 'fictional-key',
    'https://second.example.test/v1': 'fictional-second',
  });
  settings.customApiKeys!['https://fictional.example.test/v1'] = 'changed';
  assert.equal(normalizeReaderSettings(input).customApiKeys?.['https://fictional.example.test/v1'], 'fictional-key');
});

test('非法数值恢复默认，默认快捷问题不共享可变数组', () => {
  const defaults = defaultReaderSettings();
  const settings = normalizeReaderSettings({ contextChars: -1, maxOutputTokens: 1.5 });
  assert.equal(settings.contextChars, defaults.contextChars);
  assert.equal(settings.maxOutputTokens, defaults.maxOutputTokens);
  defaults.quickQuestions.push('额外问题');
  assert.notDeepEqual(defaults.quickQuestions, defaultReaderSettings().quickQuestions);
});

test('旧版设置升级后仍继承酒馆模型和参数，新参数对象不共享引用', () => {
  const old = normalizeReaderSettings({ connection: { mode: 'profile', profileId: 'old-profile' }, analysisPrompt: '旧提示词' });
  assert.deepEqual(old.connection, { mode: 'profile', profileId: 'old-profile' });
  assert.deepEqual(old.generation, { inherit: true, temperature: 0.7, topP: 1, frequencyPenalty: 0, presencePenalty: 0 });
  assert.equal(old.analysisPrompt, '旧提示词');
  old.generation.temperature = 1.5;
  assert.equal(defaultReaderSettings().generation.temperature, 0.7);
});

test('完整模型 ID 和独立生成参数可保存，但额外密钥字段不进入设置', () => {
  const model = `fictional-provider/${'very-long-model-'.repeat(12)}2026`;
  const settings = normalizeReaderSettings({
    connection: { mode: 'current', profileId: '', model: `  ${model}  `, apiKey: 'fake-do-not-store' },
    generation: { inherit: false, temperature: 0.15, topP: 0.8, frequencyPenalty: 0.3, presencePenalty: -0.4, apiKey: 'fake' },
    apiKey: 'fake',
  });
  assert.equal(settings.connection.model, model);
  assert.deepEqual(settings.generation, { inherit: false, temperature: 0.15, topP: 0.8, frequencyPenalty: 0.3, presencePenalty: -0.4 });
  assert.equal(JSON.stringify(settings).includes('fake'), false);
  assert.equal('model' in normalizeReaderSettings({ connection: { model: '  ' } }).connection, false);
});

test('生成参数接受完整边界和小数，非法或非有限值恢复默认', () => {
  for (const generation of [
    { inherit: false, temperature: 0, topP: 0, frequencyPenalty: -2, presencePenalty: 2 },
    { inherit: false, temperature: 2, topP: 1, frequencyPenalty: 2, presencePenalty: -2 },
  ]) assert.deepEqual(normalizeReaderSettings({ generation }).generation, generation);

  for (const generation of [
    { temperature: -0.1, topP: 1.1, frequencyPenalty: -2.1, presencePenalty: 2.1 },
    { temperature: Infinity, topP: NaN, frequencyPenalty: '0.3', presencePenalty: null },
  ]) assert.deepEqual(normalizeReaderSettings({ generation }).generation, defaultReaderSettings().generation);
});
