import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ANALYSIS_PROMPT, defaultReaderSettings, normalizeReaderSettings } from '../extensions/jiuguan-reader/src/settings.js';

test('默认提示重点包括人物经历与世界书状态，并明确不读开场白和作者注释', () => {
  assert.match(DEFAULT_ANALYSIS_PROMPT, /重要经历/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /怎样影响/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /不解读开场白/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /作者注释、标签、版本/u);
  assert.match(DEFAULT_ANALYSIS_PROMPT, /禁用/u);
  assert.equal(defaultReaderSettings().connection.mode, 'current');
});

test('用户提示词包括空白和换行均保留原样，空系统提示词也不补写', () => {
  const settings = normalizeReaderSettings({ systemPrompt: '  我自己的系统提示词\n', analysisPrompt: '\n只讲经历\n' });
  assert.equal(settings.systemPrompt, '  我自己的系统提示词\n');
  assert.equal(settings.analysisPrompt, '\n只讲经历\n');
  assert.equal(normalizeReaderSettings({ systemPrompt: '' }).systemPrompt, '');
});

test('独立连接只保存配置ID，没有API密钥字段，快捷问题可修改和去重', () => {
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

test('非法数值恢复默认，默认快捷问题不共享可变数组', () => {
  const defaults = defaultReaderSettings();
  const settings = normalizeReaderSettings({ contextChars: -1, maxOutputTokens: 1.5 });
  assert.equal(settings.contextChars, defaults.contextChars);
  assert.equal(settings.maxOutputTokens, defaults.maxOutputTokens);
  defaults.quickQuestions.push('额外问题');
  assert.notDeepEqual(defaults.quickQuestions, defaultReaderSettings().quickQuestions);
});
