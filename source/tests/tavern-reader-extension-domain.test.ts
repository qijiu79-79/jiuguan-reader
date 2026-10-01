import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { buildReadingDocument } from '../extensions/jiuguan-reader/src/source-domain.js';
import type { ReadingMaterial } from '../extensions/jiuguan-reader/src/types.js';

test('HTTP-compatible hashing preserves readable-material fingerprints and stale detection', async () => {
  const material: ReadingMaterial = {
    characterKey: '手机🌟.png', characterName: '虚构角色',
    card: { data: { name: '虚构角色', description: '她曾在海岸救援队工作，后来守护灯塔。🌊' } },
    worldbooks: [{ name: '灯塔规则', binding: 'primary', data: { entries: [{ keys: ['lamp'], content: '日落后灯必须点亮。' }] } }],
    warnings: [],
  };
  const hashDependencies = {
    subtleCrypto: null,
    loadHostSha256: async () => (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  };
  const native = await buildReadingDocument(material, { subtleCrypto: webcrypto.subtle });
  const http = await buildReadingDocument(material, hashDependencies);
  assert.equal(http.fingerprint, native.fingerprint);
  assert.deepEqual(http.sources, native.sources);

  const changed = structuredClone(material);
  changed.worldbooks[0].data.entries = [{ keys: ['lamp'], content: '灯只能在风暴时点亮。' }];
  assert.notEqual((await buildReadingDocument(changed, hashDependencies)).fingerprint, native.fingerprint);
});

test('reading document strips opening aliases and non-prompt metadata from a clone', async () => {
  const material: ReadingMaterial = {
    characterKey: 'character:mina',
    characterName: 'Mina',
    card: {
      name: 'Mina',
      creator_notes: 'ROOT_CREATOR_NOTES_SECRET',
      creatorcomment: 'ROOT_CREATORCOMMENT_SECRET',
      creator_comment: 'ROOT_CREATOR_COMMENT_SECRET',
      tags: ['ROOT_TAGS_SECRET'],
      first_mes: 'ROOT_FIRST_SNAIL',
      firstMessage: 'ROOT_FIRST_CAMEL',
      first_message: 'ROOT_FIRST_LEGACY',
      firstMes: 'ROOT_FIRST_SHORT',
      alternate_greetings: ['ROOT_ALT_SNAIL'],
      alternateGreetings: ['ROOT_ALT_CAMEL'],
      group_only_greetings: ['ROOT_GROUP_SNAIL'],
      groupOnlyGreetings: ['ROOT_GROUP_CAMEL'],
      data: {
        name: 'Mina',
        creator_notes: 'DATA_CREATOR_NOTES_SECRET',
        creatorcomment: 'DATA_CREATORCOMMENT_SECRET',
        creator_comment: 'DATA_CREATOR_COMMENT_SECRET',
        tags: ['DATA_TAGS_SECRET'],
        description: 'Mina spent years searching for her missing sister.',
        personality: 'Quiet, observant, and stubborn.',
        scenario: 'The player arrives at the archive after closing.',
        first_mes: 'DATA_FIRST_SNAIL',
        firstMessage: 'DATA_FIRST_CAMEL',
        first_message: 'DATA_FIRST_LEGACY',
        firstMes: 'DATA_FIRST_SHORT',
        alternate_greetings: ['DATA_ALT_SNAIL'],
        alternateGreetings: ['DATA_ALT_CAMEL'],
        group_only_greetings: ['DATA_GROUP_SNAIL'],
        groupOnlyGreetings: ['DATA_GROUP_CAMEL'],
        mes_example: 'Mina remembers making a promise long ago.',
        character_book: {
          entries: [{
            uid: 1,
            name: 'The Missing Sister',
            comment: 'WORLD_ENTRY_COMMENT_SECRET',
            title: 'WORLD_ENTRY_TITLE_SECRET',
            enabled: true,
            keys: ['sister'],
            content: 'The sister is alive, but Mina does not know where she is.',
          }],
        },
      },
      world_info: { ignored: true },
    },
    worldbooks: [],
    warnings: [],
  };
  const originalCard = structuredClone(material.card);

  const document = await buildReadingDocument(material);
  const allReadableText = document.sources.map((source) => `${source.label}\n${source.text}`).join('\n');

  assert.deepEqual(material.card, originalCard, 'the original Tavern card must never be changed');
  assert.match(allReadableText, /Mina spent years searching/u);
  assert.match(allReadableText, /The player arrives at the archive/u);
  assert.match(allReadableText, /making a promise long ago/u);
  assert.match(allReadableText, /The sister is alive/u);
  assert.doesNotMatch(allReadableText, /ROOT_CREATOR|ROOT_TAGS|DATA_CREATOR|DATA_TAGS|WORLD_ENTRY_COMMENT|WORLD_ENTRY_TITLE|The Missing Sister/u);
  assert.doesNotMatch(allReadableText, /ROOT_(?:FIRST|ALT|GROUP)|DATA_(?:FIRST|ALT|GROUP)/u);
  assert.ok(document.sources.every((source) => !source.label.includes('开场白')));
  assert.deepEqual(document.sources.map((source) => source.id), document.sources.map((_, index) => `[S${index + 1}]`));
  assert.ok(document.warnings.some((warning) => warning.includes('全局世界书和聊天世界书')));
});

test('only explicitly associated worldbooks are merged; duplicate embedded entries prefer the live binding state', async () => {
  const material: ReadingMaterial = {
    characterKey: 'character:mina',
    characterName: 'Mina',
    card: {
      spec: 'chara_card_v3',
      data: {
        name: 'Mina',
        description: 'A librarian with an important past.',
        character_book: {
          entries: [{
            uid: 'same-entry',
            name: 'The Missing Sister',
            comment: 'EMBEDDED_COMMENT_SECRET',
            title: 'EMBEDDED_TITLE_SECRET',
            enabled: true,
            keys: ['sister', 'letter'],
            content: 'The sister is alive, but Mina does not know where she is.',
          }],
        },
      },
    },
    worldbooks: [
      {
        name: 'Mina Main Lore',
        binding: 'primary',
        data: {
          entries: [{
            uid: 'same-entry',
            name: 'The Missing Sister',
            comment: 'EXTERNAL_COMMENT_SECRET',
            title: 'EXTERNAL_TITLE_SECRET',
            enabled: false,
            keys: ['sister', 'letter'],
            content: 'The sister is alive, but Mina does not know where she is.',
          }],
        },
      },
      {
        name: 'Mina Extra Lore',
        binding: 'extra',
        data: {
          entries: [{
            uid: 'extra-entry',
            name: 'The Old Promise',
            enabled: true,
            selective: true,
            keys: ['promise'],
            content: 'When Mina remembers the promise, she becomes unusually quiet.',
          }],
        },
      },
    ],
    warnings: [],
  };

  const document = await buildReadingDocument(material);
  const books = document.sources.filter((source) => source.label.startsWith('世界书 · '));
  const sisterEntries = books.filter((source) => source.text.includes('The sister is alive'));
  const promiseEntry = books.find((source) => source.text.includes('When Mina remembers the promise'));

  assert.deepEqual(document.worldbooks, ['主关联：Mina Main Lore', '额外关联：Mina Extra Lore']);
  assert.equal(sisterEntries.length, 1, 'the embedded/external copy should appear once');
  assert.match(sisterEntries[0].text, /启用状态：已禁用/u, 'the current linked book state takes precedence');
  assert.doesNotMatch(`${sisterEntries[0].label}\n${sisterEntries[0].text}`, /The Missing Sister|(?:EMBEDDED|EXTERNAL)_(?:COMMENT|TITLE)_SECRET/u);
  assert.match(sisterEntries[0].label, /世界书 · 条目 1（主关联世界书：Mina Main Lore）/u);
  assert.match(sisterEntries[0].text, /主关键词：[\s\S]*sister/u);
  assert.match(sisterEntries[0].note ?? '', /重复内容已合并/u);
  assert.match(sisterEntries[0].text, /主关联世界书「Mina Main Lore」/u);
  assert.match(promiseEntry?.text ?? '', /条件或关键词触发/u);
  assert.match(promiseEntry?.text ?? '', /promise/u);
  assert.match(promiseEntry?.text ?? '', /Mina Extra Lore/u);
  assert.ok(books.every((source) => source.id.startsWith('[S')));
  assert.ok(!document.sources.some((source) => source.text.includes('global')));
});

test('SillyTavern AND and NOT secondary-key logic stays readable and prevents false deduplication', async () => {
  const material: ReadingMaterial = {
    characterKey: 'character:logic',
    characterName: 'Logic',
    card: { data: { name: 'Logic', description: 'A test card.' } },
    worldbooks: [{
      name: 'Logic Rules',
      binding: 'primary',
      data: {
        entries: [
          {
            uid: 'and-any', name: 'Same Rule', keys: ['door'], secondary_keys: ['silver', 'red'],
            selective: true, selectiveLogic: 0, content: 'The door is locked.',
          },
          {
            uid: 'not-all', name: 'Same Rule', keys: ['door'], secondary_keys: ['silver', 'red'],
            selective: true, selectiveLogic: 1, content: 'The door is locked.',
          },
          {
            uid: 'not-any', name: 'Same Rule', keys: ['door'], secondary_keys: ['silver', 'red'],
            selective: true, selectiveLogic: 2, content: 'The door is locked.',
          },
          {
            uid: 'and-all', name: 'Same Rule', keys: ['door'], secondary_keys: ['silver', 'red'],
            selective: true, selectiveLogic: 3, content: 'The door is locked.',
          },
        ],
      },
    }],
    warnings: [],
  };

  const document = await buildReadingDocument(material);
  const rules = document.sources.filter((source) => source.text.includes('正文：\nThe door is locked.'));

  assert.equal(rules.length, 4, 'different secondary-key conditions must remain separate');
  assert.ok(rules.some((source) => source.text.includes('次关键词逻辑 selectiveLogic：AND_ANY（原值 0）')));
  assert.ok(rules.some((source) => source.text.includes('次关键词逻辑 selectiveLogic：NOT_ALL（原值 1）')));
  assert.ok(rules.some((source) => source.text.includes('次关键词逻辑 selectiveLogic：NOT_ANY（原值 2）')));
  assert.ok(rules.some((source) => source.text.includes('次关键词逻辑 selectiveLogic：AND_ALL（原值 3）')));
  assert.ok(rules.some((source) => source.text.includes('至少一个次关键词不命中')));
  assert.ok(rules.some((source) => source.text.includes('所有次关键词都不命中')));
  assert.ok(rules.some((source) => source.text.includes('至少一个次关键词也要命中')));
  assert.ok(rules.some((source) => source.text.includes('所有次关键词都要命中')));
});

test('SillyTavern 1.19.0 probability, recursion, and character filters remain visible', async () => {
  const material: ReadingMaterial = {
    characterKey: 'character:raw-config',
    characterName: 'Raw Config',
    card: { data: { name: 'Raw Config', description: 'A test card.' } },
    worldbooks: [{
      name: 'Configured Rules',
      binding: 'primary',
      data: {
        entries: [{
          uid: 'configured-rule', name: 'Configured Rule', keys: ['dragon'], secondary_keys: ['moon'],
          selective: true, selectiveLogic: 1, content: 'The dragon sleeps.',
          character_filter: { names: ['mina'], tags: ['night'], isExclude: true },
          extensions: {
            probability: 42, useProbability: true, sticky: 2, cooldown: 3, delay: 4,
            exclude_recursion: true, prevent_recursion: true, delay_until_recursion: 2,
            case_sensitive: true, match_whole_words: true, scan_depth: 5,
            match_character_description: true, triggers: ['normal'],
          },
        }],
      },
    }],
    warnings: [],
  };

  const document = await buildReadingDocument(material);
  const rule = document.sources.find((source) => source.text.includes('正文：\nThe dragon sleeps.'));

  assert.ok(rule);
  assert.match(rule.text, /probability=42/u);
  assert.match(rule.text, /sticky=2；cooldown=3；delay=4/u);
  assert.match(rule.text, /excludeRecursion=是（true）/u);
  assert.match(rule.text, /preventRecursion=是（true）/u);
  assert.match(rule.text, /delayUntilRecursion=2/u);
  assert.match(rule.text, /caseSensitive=是（true）/u);
  assert.match(rule.text, /matchWholeWords=是（true）/u);
  assert.match(rule.text, /scanDepth：5/u);
  assert.match(rule.text, /排除角色名 \[mina\]，标签 \[night\]/u);
  assert.match(rule.text, /matchCharacterDescription=是（true）/u);
  assert.match(rule.text, /生成类型筛选 triggers：normal/u);
});

test('same primary/extra-book entry with different enabled states is not collapsed', async () => {
  const sharedEntry = {
    uid: 'same-rule', name: 'Shared Rule', keys: ['key'], content: 'The key is hidden.',
  };
  const material: ReadingMaterial = {
    characterKey: 'character:bindings',
    characterName: 'Bindings',
    card: { data: { name: 'Bindings', description: 'A test card.' } },
    worldbooks: [
      { name: 'Main Rules', binding: 'primary', data: { entries: [{ ...sharedEntry, enabled: true }] } },
      { name: 'Extra Rules', binding: 'extra', data: { entries: [{ ...sharedEntry, enabled: false }] } },
    ],
    warnings: [],
  };

  const document = await buildReadingDocument(material);
  const rules = document.sources.filter((source) => source.text.includes('正文：\nThe key is hidden.'));

  assert.equal(rules.length, 2, 'different live binding states need separate explanations');
  assert.ok(rules.some((source) => source.text.includes('启用状态：条件或关键词触发')));
  assert.ok(rules.some((source) => source.text.includes('启用状态：已禁用')));
  assert.ok(rules.some((source) => source.text.includes('主关联世界书「Main Rules」')));
  assert.ok(rules.some((source) => source.text.includes('额外关联世界书「Extra Rules」')));
});

test('worldbook deduplication preserves exact keyword casing and body text', async () => {
  const material: ReadingMaterial = {
    characterKey: 'character:exact',
    characterName: 'Exact',
    card: { data: { name: 'Exact', description: 'A test card.' } },
    worldbooks: [{
      name: 'Exact Rules',
      binding: 'primary',
      data: {
        entries: [
          { uid: 1, name: 'Case Rule', keys: ['Key'], content: 'Body with Case.', extensions: { case_sensitive: true } },
          { uid: 2, name: 'Case Rule', keys: ['key'], content: 'Body with Case.', extensions: { case_sensitive: true } },
          { uid: 3, name: 'Case Rule', keys: ['Key'], content: 'Body with case.', extensions: { case_sensitive: true } },
          { uid: 4, name: 'Case Rule', keys: ['Key'], content: 'Body  with Case.', extensions: { case_sensitive: true } },
          { uid: 5, name: 'Case Rule', keys: ['/[A-Z]+/'], content: 'Body with Case.', extensions: { case_sensitive: true } },
          { uid: 6, name: 'Case Rule', keys: ['/[a-z]+/'], content: 'Body with Case.', extensions: { case_sensitive: true } },
        ],
      },
    }],
    warnings: [],
  };

  const document = await buildReadingDocument(material);
  const rules = document.sources.filter((source) => source.label.startsWith('世界书 · 条目'));

  assert.equal(rules.length, 6, 'casing and whitespace differences in keys or body are meaningful source differences');
  assert.ok(rules.some((source) => source.text.includes('主关键词：\n- Key')));
  assert.ok(rules.some((source) => source.text.includes('主关键词：\n- key')));
  assert.ok(rules.some((source) => source.text.includes('主关键词：\n- /[A-Z]+/')));
  assert.ok(rules.some((source) => source.text.includes('主关键词：\n- /[a-z]+/')));
  assert.ok(rules.some((source) => source.text.includes('正文：\nBody  with Case.')));
});

test('fingerprint follows readable material but ignores greetings and non-prompt metadata', async () => {
  const base: ReadingMaterial = {
    characterKey: 'character:mina',
    characterName: 'Mina',
    card: {
      creator_notes: 'Initial root creator notes.',
      tags: ['root-tag-a'],
      data: {
        name: 'Mina', description: 'She remembers the old city.', first_mes: 'A greeting.',
        creator_notes: 'Initial data creator notes.', tags: ['data-tag-a'],
      },
    },
    worldbooks: [{
      name: 'Mina Lore',
      binding: 'primary',
      data: { entries: [{
        name: 'Old City', comment: 'Initial worldbook author note.', title: 'Initial title',
        keys: ['city'], content: 'The city was built beside the river.',
      }] },
    }],
    warnings: [],
  };

  const first = await buildReadingDocument(base);
  const changedGreeting = structuredClone(base);
  changedGreeting.card.data = { ...changedGreeting.card.data as Record<string, unknown>, first_mes: 'A different greeting.' };
  const sameReadableSurface = await buildReadingDocument(changedGreeting);
  const changedMetadata = structuredClone(base);
  changedMetadata.card.creator_notes = 'Different root creator notes.';
  changedMetadata.card.tags = ['root-tag-b'];
  changedMetadata.card.data = {
    ...changedMetadata.card.data as Record<string, unknown>,
    creator_notes: 'Different data creator notes.',
    tags: ['data-tag-b'],
  };
  changedMetadata.worldbooks[0].data.entries = [{
    name: 'Different entry name', comment: 'Different worldbook author note.', title: 'Different title',
    keys: ['city'], content: 'The city was built beside the river.',
  }];
  const sameMetadataFreeSurface = await buildReadingDocument(changedMetadata);
  const changedContent = structuredClone(base);
  changedContent.worldbooks[0].data.entries = [{ name: 'Old City', keys: ['city'], content: 'The city was built beside the mountain.' }];
  const changedWorldbook = await buildReadingDocument(changedContent);
  const changedBinding = structuredClone(base);
  changedBinding.worldbooks[0].binding = 'extra';
  const changedScope = await buildReadingDocument(changedBinding);
  const missingWorldbookWarning = '角色关联世界书「Missing Lore」无法读取；本次内容可能不完整。';
  const changedWarning = structuredClone(base);
  changedWarning.warnings = [missingWorldbookWarning];
  const changedCompleteness = await buildReadingDocument(changedWarning);
  const repeatedWarning = structuredClone(base);
  repeatedWarning.warnings = [missingWorldbookWarning, missingWorldbookWarning];
  const sameDeduplicatedWarning = await buildReadingDocument(repeatedWarning);

  assert.equal(first.fingerprint, sameReadableSurface.fingerprint);
  assert.equal(first.fingerprint, sameMetadataFreeSurface.fingerprint);
  assert.notEqual(first.fingerprint, changedWorldbook.fingerprint);
  assert.notEqual(first.fingerprint, changedScope.fingerprint);
  assert.deepEqual(first.sources, changedCompleteness.sources, 'a scope warning must not alter the readable source set');
  assert.notEqual(first.fingerprint, changedCompleteness.fingerprint, 'a missing-source warning changes the scope fingerprint');
  assert.equal(changedCompleteness.fingerprint, sameDeduplicatedWarning.fingerprint, 'duplicate warnings are deduplicated before fingerprinting');
  assert.match(first.fingerprint, /^[a-f\d]{64}$/u);
});

test('fingerprint changes when a worldbook trigger condition changes', async () => {
  const base: ReadingMaterial = {
    characterKey: 'character:logic-fingerprint',
    characterName: 'Logic Fingerprint',
    card: { data: { name: 'Logic Fingerprint', description: 'A test card.' } },
    worldbooks: [{
      name: 'Logic Rules',
      binding: 'primary',
      data: {
        entries: [{
          uid: 'door-rule', name: 'Door Rule', keys: ['door'], secondary_keys: ['open', 'broken'],
          selective: true, selectiveLogic: 0, content: 'The door may open.',
        }],
      },
    }],
    warnings: [],
  };
  const changed = structuredClone(base);
  const changedWorldbook = changed.worldbooks[0].data;
  changedWorldbook.entries = [{
    uid: 'door-rule', name: 'Door Rule', keys: ['door'], secondary_keys: ['open', 'broken'],
    selective: true, selectiveLogic: 2, content: 'The door may open.',
  }];

  const originalDocument = await buildReadingDocument(base);
  const changedDocument = await buildReadingDocument(changed);

  assert.notEqual(originalDocument.fingerprint, changedDocument.fingerprint);
  assert.match(originalDocument.sources.find((source) => source.text.includes('正文：\nThe door may open.'))?.text ?? '', /AND_ANY/u);
  assert.match(changedDocument.sources.find((source) => source.text.includes('正文：\nThe door may open.'))?.text ?? '', /NOT_ANY/u);
});

test('unrecognized associated-worldbook metadata is not recursively treated as lore text', async () => {
  const material: ReadingMaterial = {
    characterKey: 'character:sample',
    characterName: 'Sample',
    card: { data: { name: 'Sample', description: 'A test card.' } },
    worldbooks: [{
      name: 'Odd Format',
      binding: 'primary',
      data: { extensions: { script: 'DO_NOT_READ_OR_RUN' }, randomMetadata: 'DO_NOT_READ_EITHER' },
    }],
    warnings: [],
  };

  const document = await buildReadingDocument(material);
  const text = document.sources.map((source) => source.text).join('\n');

  assert.doesNotMatch(text, /DO_NOT_READ/u);
  assert.ok(document.warnings.some((warning) => warning.includes('没有可识别的条目结构')));
});
