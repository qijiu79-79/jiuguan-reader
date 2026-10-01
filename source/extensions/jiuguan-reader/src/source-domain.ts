import { buildReaderSources } from '../../../server/tavern/reader-domain.js';
import type { Material, ReaderSource } from '../../../config/tavern-types.js';
import { sha256Hex, type HashDependencies } from './browser-compat.js';
import type { ReadingDocument, ReadingMaterial } from './types.js';

const GREETING_FIELDS = new Set([
  'first_mes', 'firstmessage', 'first_message', 'firstmes',
  'alternate_greetings', 'alternategreetings', 'alternate_greeting', 'alternategreeting',
  'group_only_greetings', 'grouponlygreetings', 'group_only_greeting', 'grouponlygreeting',
]);

const EXCLUDED_CARD_METADATA_FIELDS = new Set(['creatornotes', 'creatorcomment', 'tags']);
const WORLDBOOK_ROOT_FIELDS = ['entries', 'lorebook', 'worldbook', 'data'] as const;

interface WorldbookSource {
  source: ReaderSource;
  origin: string;
  rank: number;
  enabled: boolean;
}

interface MergedWorldbookSource extends WorldbookSource {
  origins: string[];
}

/**
 * Build the exact reading surface for the extension. The card is cloned before
 * greeting fields are removed, and only explicitly linked character worldbooks
 * are considered; global and chat-scoped books are deliberately out of scope.
 */
export async function buildReadingDocument(material: ReadingMaterial, hashDependencies: HashDependencies = {}): Promise<ReadingDocument> {
  if (!material.characterKey.trim()) throw new Error('当前角色没有稳定标识，无法保存独立读卡记录。');

  const card = cloneRecord(material.card);
  stripGreetingFields(card);
  stripCardMetadataFields(card);
  const data = asRecord(card.data);
  if (data) {
    stripGreetingFields(data);
    stripCardMetadataFields(data);
  }

  const cardMaterial = asMaterial(material, card);
  const cardSources = buildReaderSources(cardMaterial);
  const cardFields = cardSources.filter((source) => !isWorldbookSource(source));
  const warnings = [...material.warnings];
  const embeddedBooks = cardSources
    .filter(isWorldbookSource)
    .flatMap((source, index) => {
      const path = source.path ?? [];
      const entry = path.length ? recordAtPath(card, path) : null;
      if (!entry) {
        warnings.push('卡片内嵌世界书有条目无法安全对应到原始字段，已跳过该条目。');
        return [];
      }
      return {
        source: buildWorldbookSource(source, entry, index + 1, '卡片内嵌世界书'),
        origin: '卡片内嵌世界书',
        rank: 0,
        enabled: isWorldbookEntryEnabled(entry),
      };
    });

  const externalBooks: WorldbookSource[] = [];
  const worldbooks = material.worldbooks.map((book) =>
    `${book.binding === 'primary' ? '主关联' : '额外关联'}：${book.name}`);

  for (let index = 0; index < material.worldbooks.length; index += 1) {
    const book = material.worldbooks[index];
    const entries = findWorldbookEntries(book.data);
    if (entries === undefined) {
      warnings.push(`角色关联世界书「${book.name}」没有可识别的条目结构，未把其他字段当作世界书正文。`);
      continue;
    }

    const parsed = buildReaderSources(asMaterial(material, { entries }, 'worldbook', `${material.characterKey}:worldbook:${index}`));
    const entrySources = parsed.filter(isWorldbookSource);
    if (!entrySources.length) {
      warnings.push(`角色关联世界书「${book.name}」没有可读取的条目正文。`);
      continue;
    }

    const bindingLabel = book.binding === 'primary' ? '主关联世界书' : '额外关联世界书';
    for (let entryIndex = 0; entryIndex < entrySources.length; entryIndex += 1) {
      const source = entrySources[entryIndex];
      const path = source.path ?? [];
      const entry = path.length > 1 ? recordAtPath(entries, path.slice(1)) : null;
      if (!entry) {
        warnings.push(`角色关联世界书「${book.name}」有条目无法安全对应到原始字段，已跳过该条目。`);
        continue;
      }
      const enriched = buildWorldbookSource(source, entry, entryIndex + 1, `${bindingLabel}：${book.name}`);
      externalBooks.push({
        source: {
          ...enriched,
          path: ['linked_worldbooks', index, book.binding, book.name, ...path],
        },
        origin: `${bindingLabel}「${book.name}」`,
        rank: book.binding === 'primary' ? 2 : 1,
        enabled: isWorldbookEntryEnabled(entry),
      });
    }
  }

  const mergedWorldbooks = mergeWorldbookSources([...embeddedBooks, ...externalBooks]);
  const sources = [...cardFields, ...mergedWorldbooks.map(renderMergedWorldbook)]
    .map((source, index) => ({ ...source, id: `[S${index + 1}]` }));

  if (!mergedWorldbooks.length) {
    warnings.push('没有可读取的内嵌或角色关联世界书；未读取全局世界书或聊天世界书。');
  }
  warnings.push('仅读取卡片内嵌与角色明确关联的世界书；全局世界书和聊天世界书不在本次范围内。');
  const finalWarnings = [...new Set(warnings)];

  const fingerprint = await fingerprintReadingSurface(
    material.characterKey,
    worldbooks,
    material.characterName,
    sources,
    finalWarnings,
    hashDependencies,
  );

  return {
    characterKey: material.characterKey,
    characterName: material.characterName,
    fingerprint,
    sources,
    worldbooks,
    warnings: finalWarnings,
  };
}

async function fingerprintReadingSurface(
  characterKey: string,
  worldbooks: string[],
  characterName: string,
  sources: readonly ReaderSource[],
  warnings: readonly string[],
  hashDependencies: HashDependencies,
): Promise<string> {
  const canonical = JSON.stringify({
    version: 2,
    characterKey,
    characterName,
    worldbooks,
    sources: sources.map(({ label, text, note }) => ({ label, text, note: note ?? '' })),
    warnings,
  });
  return sha256Hex(canonical, hashDependencies);
}

function asMaterial(
  material: ReadingMaterial,
  original: Record<string, unknown>,
  kind: Material['kind'] = 'card',
  id = material.characterKey,
): Material {
  return {
    id,
    hash: '',
    name: material.characterName,
    kind,
    format: 'json',
    createdAt: '',
    original,
    text: '',
    warnings: [],
  };
}

function findWorldbookEntries(data: Record<string, unknown>): unknown | undefined {
  const field = WORLDBOOK_ROOT_FIELDS.find((key) => data[key] !== undefined && data[key] !== null);
  if (field) return data[field];
  if (looksLikeWorldbookEntry(data)) return [data];
  return Object.values(data).some((item) => looksLikeWorldbookEntry(asRecord(item))) ? data : undefined;
}

function looksLikeWorldbookEntry(value: Record<string, unknown> | null): boolean {
  if (!value) return false;
  return [
    value.content, value.text, value.description,
    value.keys, value.key, value.keywords, value.primary_keys, value.primaryKeys,
    value.secondary_keys, value.secondaryKeys, value.keysecondary, value.secondaryKeywords,
  ].some((item) => item !== undefined && item !== null && readableShapeHasText(item));
}

function readableShapeHasText(value: unknown): boolean {
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(readableShapeHasText);
  const record = asRecord(value);
  return Boolean(record && Object.values(record).some(readableShapeHasText));
}

function readableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const text = readableValue(item);
      return text.trim() ? `- ${text}` : '';
    }).filter(Boolean).join('\n');
  }
  const record = asRecord(value);
  return record
    ? Object.entries(record).flatMap(([key, item]) => {
      const text = readableValue(item);
      return text.trim() ? [`${key}: ${text}`] : [];
    }).join('\n')
    : '';
}

function mergeWorldbookSources(sources: WorldbookSource[]): MergedWorldbookSource[] {
  const merged: MergedWorldbookSource[] = [];
  const byContent = new Map<string, number[]>();

  for (const item of sources) {
    const key = worldbookEntryKey(item.source.text);
    const candidates = byContent.get(key) ?? [];
    const existingIndex = candidates.find((index) => {
      const existing = merged[index];
      const oneIsEmbedded = (existing.rank === 0) !== (item.rank === 0);
      return oneIsEmbedded || existing.enabled === item.enabled;
    });
    if (existingIndex === undefined) {
      candidates.push(merged.length);
      byContent.set(key, candidates);
      merged.push({ ...item, origins: [item.origin] });
      continue;
    }

    const existing = merged[existingIndex];
    if (!existing.origins.includes(item.origin)) existing.origins.push(item.origin);
    if (item.rank > existing.rank) {
      merged[existingIndex] = { ...item, origins: existing.origins };
    }
  }

  return merged;
}

function worldbookEntryKey(text: string): string {
  // Only the live enable state is ignored for mirror matching; key/body casing and spacing are meaningful.
  const lines = text.split('\n');
  const statusIndex = lines.findIndex((line) => line.startsWith('启用状态：'));
  if (statusIndex === 0 || statusIndex === 1) lines.splice(statusIndex, 1);
  return lines.join('\n');
}

function buildWorldbookSource(
  source: ReaderSource,
  entry: Record<string, unknown>,
  entryNumber: number,
  location: string,
): ReaderSource {
  // Rebuild from the raw fields so comment/title/name metadata never becomes model evidence.
  const enabled = isWorldbookEntryEnabled(entry);
  const constant = entry.constant === true || entry.always_active === true || entry.alwaysActive === true;
  const mainKeys = readWorldInfoField(entry, ['keys', 'key', 'keywords', 'primary_keys', 'primaryKeys']);
  const secondaryKeys = readWorldInfoField(entry, ['secondary_keys', 'secondaryKeys', 'keysecondary', 'secondaryKeywords']);
  const hasTriggers = readableShapeHasText(mainKeys) || readableShapeHasText(secondaryKeys);
  const selective = entry.selective === true || entry.use_regex === true || Boolean(hasTriggers);
  const status = !enabled
    ? '已禁用'
    : constant
      ? '常驻 / 始终启用'
      : selective
        ? '条件或关键词触发；是否生效取决于当前上下文和酒馆设置'
        : '触发状态未明示；不推断为当前正在生效';
  const lines = [`启用状态：${status}`];

  if (constant) lines.push('触发方式：常驻条目');
  if (entry.selective === true) lines.push('触发方式：条件/关键词选择');
  if (entry.use_regex === true) lines.push('关键词模式：正则');
  appendWorldbookTextLine(lines, '主关键词', mainKeys);
  appendWorldbookTextLine(lines, '次关键词', secondaryKeys);
  appendWorldbookTextLine(lines, '正文', entry.content ?? entry.text ?? entry.description);

  return appendWorldInfoTriggerConfig({
    ...source,
    label: `世界书 · 条目 ${entryNumber}（${location}）`,
    text: lines.join('\n'),
    note: status,
  }, entry);
}

function appendWorldbookTextLine(lines: string[], label: string, value: unknown): void {
  const text = readableValue(value);
  if (text.trim()) lines.push(`${label}：\n${text}`);
}

function appendWorldInfoTriggerConfig(source: ReaderSource, entry: Record<string, unknown>): ReaderSource {
  const logic = readWorldInfoField(entry, ['selectiveLogic', 'selective_logic']);
  const probability = readWorldInfoField(entry, ['probability']);
  const useProbability = readWorldInfoField(entry, ['useProbability', 'use_probability']);
  const characterFilter = readWorldInfoField(entry, ['characterFilter', 'character_filter']);
  const triggers = readWorldInfoField(entry, ['triggers']);
  const caseSensitive = readWorldInfoField(entry, ['caseSensitive', 'case_sensitive']);
  const matchWholeWords = readWorldInfoField(entry, ['matchWholeWords', 'match_whole_words']);
  const matchPersonaDescription = readWorldInfoField(entry, ['matchPersonaDescription', 'match_persona_description']);
  const matchCharacterDescription = readWorldInfoField(entry, ['matchCharacterDescription', 'match_character_description']);
  const matchCharacterPersonality = readWorldInfoField(entry, ['matchCharacterPersonality', 'match_character_personality']);
  const matchCharacterDepthPrompt = readWorldInfoField(entry, ['matchCharacterDepthPrompt', 'match_character_depth_prompt']);
  const matchScenario = readWorldInfoField(entry, ['matchScenario', 'match_scenario']);
  const matchCreatorNotes = readWorldInfoField(entry, ['matchCreatorNotes', 'match_creator_notes']);
  const recursion = [
    `excludeRecursion=${configuredBoolean(readWorldInfoField(entry, ['excludeRecursion', 'exclude_recursion']), '酒馆默认关闭')}`,
    `preventRecursion=${configuredBoolean(readWorldInfoField(entry, ['preventRecursion', 'prevent_recursion']), '酒馆默认关闭')}`,
    `delayUntilRecursion=${configuredValue(readWorldInfoField(entry, ['delayUntilRecursion', 'delay_until_recursion']), '酒馆默认关闭')}`,
  ].join('；');
  const timedEffects = [
    `sticky=${configuredValue(readWorldInfoField(entry, ['sticky']), '未设置')}`,
    `cooldown=${configuredValue(readWorldInfoField(entry, ['cooldown']), '未设置')}`,
    `delay=${configuredValue(readWorldInfoField(entry, ['delay']), '未设置')}`,
  ].join('；');
  const extraScanText = [
    ['matchPersonaDescription', matchPersonaDescription],
    ['matchCharacterDescription', matchCharacterDescription],
    ['matchCharacterPersonality', matchCharacterPersonality],
    ['matchCharacterDepthPrompt', matchCharacterDepthPrompt],
    ['matchScenario', matchScenario],
    ['matchCreatorNotes', matchCreatorNotes],
  ].map(([field, value]) => `${field}=${configuredBoolean(value, '酒馆默认关闭')}`).join('；');
  const groupSettings = [
    `group=${configuredValue(readWorldInfoField(entry, ['group']), '未设置')}`,
    `groupOverride=${configuredBoolean(readWorldInfoField(entry, ['groupOverride', 'group_override']), '酒馆默认关闭')}`,
    `groupWeight=${configuredValue(readWorldInfoField(entry, ['groupWeight', 'group_weight']), '酒馆默认 100')}`,
    `useGroupScoring=${inheritedBoolean(readWorldInfoField(entry, ['useGroupScoring', 'use_group_scoring']), '酒馆全局分组评分设置')}`,
  ].join('；');
  const keywordMatching = [
    `caseSensitive=${inheritedBoolean(caseSensitive, '酒馆全局大小写设置')}`,
    `matchWholeWords=${inheritedBoolean(matchWholeWords, '酒馆全局整词设置')}`,
  ].join('；');
  const lines = [
    `常驻 constant：${configuredBoolean(readWorldInfoField(entry, ['constant', 'always_active', 'alwaysActive']), '酒馆默认关闭')}`,
    `次关键词开关 selective：${configuredBoolean(readWorldInfoField(entry, ['selective']), '默认值依条目格式而异')}`,
    `次关键词逻辑 selectiveLogic：${describeSelectiveLogic(logic)}`,
    `概率抽选：useProbability=${configuredBoolean(useProbability, '酒馆默认开启')}；probability=${configuredValue(probability, '酒馆默认 100%')}`,
    `关键词匹配：${keywordMatching}`,
    '正则键：SillyTavern 对 /pattern/flags 格式的关键词走正则匹配。',
    `扫描深度 scanDepth：${configuredValue(readWorldInfoField(entry, ['scanDepth', 'scan_depth']), '使用酒馆全局扫描深度')}`,
    `角色/标签过滤 character_filter：${describeCharacterFilter(characterFilter)}`,
    `递归筛选：${recursion}`,
    `计时设置：${timedEffects}`,
    `额外扫描文本：${extraScanText}`,
    `生成类型筛选 triggers：${describeStringList(triggers, '未设置（不按生成类型筛选）')}`,
    `分组筛选：${groupSettings}`,
  ];
  const note = '静态触发配置；实际命中还取决于聊天上下文和酒馆全局设置。';
  return {
    ...source,
    text: `${source.text}\n\nSillyTavern 1.19.0 触发配置（原始字段）：\n${lines.join('\n')}\n说明：${note}`,
    note: [source.note, note].filter(Boolean).join('；'),
  };
}

function describeSelectiveLogic(value: unknown): string {
  const logicNames = ['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'] as const;
  const descriptions = [
    '主关键词命中后，至少一个次关键词也要命中',
    '主关键词命中后，至少一个次关键词不命中',
    '主关键词命中后，所有次关键词都不命中',
    '主关键词命中后，所有次关键词都要命中',
  ] as const;
  const rawNumber = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : -1;
  const namedIndex = typeof value === 'string' ? logicNames.indexOf(value.toUpperCase() as typeof logicNames[number]) : -1;
  const index = namedIndex >= 0 ? namedIndex : rawNumber;
  if (value === undefined || value === null) return '未显式设置（酒馆默认 AND_ANY / 0）';
  if (index < 0 || index >= logicNames.length) return `未知原值 ${formatRawValue(value)}`;
  return `${logicNames[index]}（原值 ${formatRawValue(value)}）：${descriptions[index]}`;
}

function describeCharacterFilter(value: unknown): string {
  const filter = asRecord(value);
  if (!filter) return value === undefined || value === null ? '未设置（不按角色/标签过滤）' : formatRawValue(value);
  const names = stringList(filter.names);
  const tags = stringList(filter.tags);
  if (!names.length && !tags.length) return '未设置有效角色名或标签过滤';
  const exclusion = filter.isExclude === true;
  const kind = exclusion ? '排除' : '仅限';
  return `${kind}角色名 [${names.join('、')}]，标签 [${tags.join('、')}]；isExclude=${configuredBoolean(filter.isExclude, 'false')}`;
}

function describeStringList(value: unknown, missing: string): string {
  const items = stringList(value);
  return items.length ? items.join('、') : value === undefined || value === null ? missing : formatRawValue(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item : formatRawValue(item));
}

function configuredBoolean(value: unknown, missing: string): string {
  if (value === undefined) return `未显式设置（${missing}）`;
  if (value === null) return 'null';
  if (value === true) return '是（true）';
  if (value === false) return '否（false）';
  return formatRawValue(value);
}

function inheritedBoolean(value: unknown, inheritedFrom: string): string {
  if (value === undefined || value === null) return `${formatRawValue(value)}（继承${inheritedFrom}）`;
  return configuredBoolean(value, '未显式设置');
}

function configuredValue(value: unknown, missing: string): string {
  return value === undefined ? `未显式设置（${missing}）` : formatRawValue(value);
}

function formatRawValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return '未显式设置';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[无法显示的原始值]';
  }
}

function readWorldInfoField(
  entry: Record<string, unknown>,
  aliases: readonly string[],
  extensionAliases: readonly string[] = aliases,
): unknown {
  const direct = firstDefined(entry, aliases);
  if (direct !== undefined && direct !== null) return direct;
  const extension = asRecord(entry.extensions);
  const nested = extension ? firstDefined(extension, extensionAliases) : undefined;
  return nested !== undefined ? nested : direct;
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function isWorldbookEntryEnabled(entry: Record<string, unknown> | null): boolean {
  if (!entry) return true;
  const enabled = readWorldInfoField(entry, ['enabled']);
  const disabled = readWorldInfoField(entry, ['disabled', 'disable']);
  return enabled !== false && disabled !== true;
}

function recordAtPath(root: unknown, path: readonly (string | number)[]): Record<string, unknown> | null {
  let current: unknown = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (record && typeof segment === 'string') current = record[segment];
    else if (record && typeof segment === 'number') current = record[String(segment)];
    else return null;
  }
  return asRecord(current);
}

function renderMergedWorldbook(item: MergedWorldbookSource): ReaderSource {
  const origins = [...new Set(item.origins)];
  const originLine = `来源范围：${origins.join('；')}`;
  return {
    ...item.source,
    text: `${originLine}\n${item.source.text}`,
    note: [item.source.note, origins.length > 1 ? `重复内容已合并（${origins.length} 个关联位置）` : '']
      .filter(Boolean)
      .join('；'),
  };
}

function isWorldbookSource(source: ReaderSource): boolean {
  return source.label.startsWith('世界书 · ');
}

function stripGreetingFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    const normalized = key.replace(/[-\s]/gu, '').toLocaleLowerCase();
    if (GREETING_FIELDS.has(normalized)) delete record[key];
  }
}

function stripCardMetadataFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    const normalized = key.replace(/[-_\s]/gu, '').toLocaleLowerCase();
    if (EXCLUDED_CARD_METADATA_FIELDS.has(normalized)) delete record[key];
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    throw new Error('角色卡无法安全复制；没有修改原卡，也没有开始读卡。');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
