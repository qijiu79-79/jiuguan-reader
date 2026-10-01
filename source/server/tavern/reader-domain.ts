import type { Material, JsonPath, ReaderSource } from '../../config/tavern-types.js';

export interface ReaderChunkPart {
  sourceId: string;
  start: number;
  end: number;
}

export interface ReaderChunk {
  id: string;
  sourceIds: string[];
  parts: ReaderChunkPart[];
}

const CARD_FIELDS: Array<{ keys: string[]; label: string }> = [
  { keys: ['name'], label: '角色名称' },
  { keys: ['description'], label: '角色设定与经历' },
  { keys: ['personality'], label: '性格' },
  { keys: ['scenario'], label: '背景与当前情境' },
  { keys: ['first_mes', 'firstMessage', 'first_message'], label: '主开场白' },
  { keys: ['alternate_greetings', 'alternateGreetings'], label: '备用开场白' },
  { keys: ['group_only_greetings', 'groupOnlyGreetings'], label: '群聊开场白' },
  { keys: ['mes_example', 'example_dialogue', 'exampleDialogue'], label: '示例对白' },
  { keys: ['creator_notes', 'creatorcomment', 'creator_comment'], label: '作者说明' },
  { keys: ['system_prompt', 'system_prompts'], label: '卡片内系统设定' },
  { keys: ['post_history_instructions'], label: '历史消息后的设定' },
  { keys: ['tags'], label: '标签' },
];

/**
 * Builds the complete human-readable reading surface from a material. Binary assets,
 * image payloads and executable code are intentionally not traversed.
 */
export function buildReaderSources(material: Material): ReaderSource[] {
  const collected: Omit<ReaderSource, 'id'>[] = [];
  const original = asRecord(material.original);

  if (material.kind === 'text' || material.format === 'text' || !original) {
    const text = material.text;
    if (text.trim()) {
      collected.push({
        label: material.kind === 'text' ? '粘贴的网页简介或文本' : material.name || '可读取文本',
        text,
        note: material.kind === 'text'
          ? '仅依据这段简介或粘贴原文；未读取完整角色卡。'
          : '仅依据当前材料中可读取的原文；文件没有提供可解析的完整角色卡对象。',
      });
    }
    if (material.kind === 'text') return withSourceIds(collected);
  } else if (material.kind === 'worldbook') {
    appendWorldbookSources(collected, original, []);
  } else {
    const data = asRecord(original.data) ?? original;
    for (const field of CARD_FIELDS) {
      const found = findCardField(original, data, field.keys);
      if (!found) continue;
      appendFieldSources(collected, field.label, found.value, found.path);
    }

    appendEmbeddedWorldbooks(collected, original, data);
  }

  if (collected.length === 0 && material.text.trim()) {
    collected.push({
      label: material.name || '材料文本',
      text: material.text,
      note: '仅依据当前材料提供的原文。',
    });
  }
  return withSourceIds(collected);
}

export function buildReaderWarnings(material: Material, sources: readonly ReaderSource[]): string[] {
  const warnings = [...material.warnings];
  if (material.kind === 'card' && !sources.some((source) => source.label.startsWith('世界书 · '))) {
    warnings.push('当前角色卡文件没有找到可读取的内嵌世界书正文；若酒馆中另有外部世界书，请单独导入后再解读。');
  }
  if (!sources.length) warnings.push('当前材料没有可读取的文字字段；没有执行脚本或加载远程资源。');
  if (material.kind === 'text' && !warnings.some((warning) => /仅依据粘贴|简介/u.test(warning))) {
    warnings.push('仅依据这段简介或粘贴文本；没有关联完整角色卡，也没有关联外部世界书。');
  }
  return [...new Set(warnings)];
}

/** Split source texts into contiguous, lossless ranges whose rendered size is bounded. */
export function buildReaderChunks(sources: readonly ReaderSource[], maxCharsPerChunk: number): ReaderChunk[] {
  const budget = Math.max(1, Math.floor(maxCharsPerChunk));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const chunks: ReaderChunk[] = [];
  let current: ReaderChunk = { id: 'C1', sourceIds: [], parts: [] };
  let currentChars = 0;

  const flush = (): void => {
    if (!current.parts.length) return;
    chunks.push(current);
    current = { id: `C${chunks.length + 1}`, sourceIds: [], parts: [] };
    currentChars = 0;
  };

  for (const source of sources) {
    if (!source.text.length) continue;
    let start = 0;
    while (start < source.text.length) {
      const headerChars = sourceHeader(source).length + 2;
      const perPartBudget = Math.max(1, budget - headerChars);
      let end = chooseBoundary(source.text, start, perPartBudget);
      if (end <= start) end = Math.min(source.text.length, start + 1);
      const cost = headerChars + (end - start);

      if (current.parts.length && currentChars + cost > budget) flush();
      current.parts.push({ sourceId: source.id, start, end });
      current.sourceIds.push(source.id);
      currentChars += cost;
      start = end;
    }
  }
  flush();
  return chunks.map((chunk) => ({ ...chunk, sourceIds: [...new Set(chunk.sourceIds)] }));
}

export function renderReaderChunk(chunk: ReaderChunk, sources: readonly ReaderSource[]): string {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return chunk.parts.map((part) => {
    const source = byId.get(part.sourceId);
    if (!source) return '';
    return `${sourceHeader(source)}\n${source.text.slice(part.start, part.end)}`;
  }).join('\n\n');
}

export function extractSourceCitationIds(text: string): string[] {
  return [...text.matchAll(/\[(S\d+)\]/gu)].map((match) => `[${match[1]}]`);
}

/** Replace model-invented source IDs instead of presenting them as real evidence. */
export function validateSourceCitations(text: string, validSourceIds: ReadonlySet<string>): string {
  return text.replace(/\[(S\d+)\]/gu, (citation) => validSourceIds.has(citation) ? citation : '[无对应原文来源]');
}

export function sourceDirectoryRow(source: ReaderSource, previewChars = 100): string {
  const normalized = source.text.replace(/\s+/gu, ' ').trim();
  const first = normalized.slice(0, previewChars);
  const last = normalized.length > previewChars * 1.7 ? normalized.slice(-Math.floor(previewChars * 0.65)) : '';
  const preview = last ? `${first} … ${last}` : first;
  const note = source.note ? `；说明：${source.note}` : '';
  return `${source.id} ${source.label}${note}；原文长度 ${source.text.length} 字符；预览：${preview}`;
}

export function materialFingerprint(material: Material): string {
  // The caller hashes this canonical string; separating text from the JSON object avoids
  // accidentally treating two different materials with the same display name as one chat.
  return JSON.stringify({
    id: material.id,
    kind: material.kind,
    format: material.format,
    hash: material.hash,
    text: material.text,
    original: material.original,
  });
}

function appendEmbeddedWorldbooks(
  output: Omit<ReaderSource, 'id'>[],
  original: Record<string, unknown>,
  data: Record<string, unknown>,
): number {
  const candidates: Array<{ value: unknown; path: JsonPath }> = [];
  for (const [owner, pathPrefix] of [[data, data === original ? [] : ['data']], [original, []]] as const) {
    const book = asRecord(owner.character_book);
    if (book && book.entries != null) candidates.push({ value: book.entries, path: [...pathPrefix, 'character_book', 'entries'] });
    if (owner.lorebook != null) candidates.push({ value: owner.lorebook, path: [...pathPrefix, 'lorebook'] });
    if (owner.worldbook != null) candidates.push({ value: owner.worldbook, path: [...pathPrefix, 'worldbook'] });
    const module = asRecord(owner.$module) ?? asRecord(owner.module);
    if (module?.lorebook != null) candidates.push({ value: module.lorebook, path: [...pathPrefix, module === owner.$module ? '$module' : 'module', 'lorebook'] });
  }

  const seen = new Set<string>();
  let count = 0;
  for (const candidate of candidates) {
    const entries = normalizeEntries(candidate.value);
    for (let index = 0; index < entries.length; index += 1) {
      const item = entries[index];
      const entry = item.entry;
      const signature = `${candidate.path.join('.')}:${item.path.join('.')}:${entryIdentity(entry, index)}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      appendWorldbookEntry(output, entry, [...candidate.path, ...item.path], index);
      count += 1;
    }
  }
  return count;
}

function appendWorldbookSources(
  output: Omit<ReaderSource, 'id'>[],
  worldbook: Record<string, unknown>,
  pathPrefix: JsonPath,
): void {
  const field = ['entries', 'lorebook', 'worldbook', 'data'].find((key) => worldbook[key] != null);
  const candidates = field ? [{ value: worldbook[field], path: [...pathPrefix, field] }] : [];
  const normalized = candidates.flatMap((candidate) => normalizeEntries(candidate.value)
    .map((item, index) => ({ entry: item.entry, path: [...candidate.path, ...item.path], index })));
  for (const { entry, path, index } of normalized) appendWorldbookEntry(output, entry, path, index);
  if (!normalized.length) {
    const text = readableValue(worldbook);
    if (text.trim()) output.push({
      label: '独立世界书',
      path: pathPrefix,
      text,
      note: '按当前文件的原文读取；没有可辨认的条目结构。',
    });
  }
}

function appendWorldbookEntry(
  output: Omit<ReaderSource, 'id'>[],
  entry: Record<string, unknown>,
  path: JsonPath,
  index: number,
): void {
  const name = firstText(entry.name, entry.comment, entry.title, entry.key) || `条目 ${index + 1}`;
  const enabled = entry.enabled !== false && entry.disabled !== true && entry.disable !== true;
  const isConstant = entry.constant === true || entry.always_active === true || entry.alwaysActive === true;
  const hasTriggers = readableValue(entry.keys ?? entry.key ?? entry.keywords ?? entry.primary_keys ?? entry.primaryKeys).trim()
    || readableValue(entry.secondary_keys ?? entry.secondaryKeys ?? entry.keysecondary ?? entry.secondaryKeywords).trim();
  const selective = entry.selective === true || entry.use_regex === true || Boolean(hasTriggers);
  const status = !enabled
    ? '已禁用'
    : isConstant
      ? '常驻 / 始终启用'
      : selective
        ? '条件或关键词触发；是否生效取决于当前上下文和酒馆设置'
        : '触发状态未明示；不推断为当前正在生效';
  const lines = [`条目名：${name}`, `启用状态：${status}`];
  if (entry.constant === true || entry.always_active === true || entry.alwaysActive === true) lines.push('触发方式：常驻条目');
  if (entry.selective === true) lines.push('触发方式：条件/关键词选择');
  if (entry.use_regex === true) lines.push('关键词模式：正则');
  appendLine(lines, '主关键词', entry.keys ?? entry.key ?? entry.keywords ?? entry.primary_keys ?? entry.primaryKeys);
  appendLine(lines, '次关键词', entry.secondary_keys ?? entry.secondaryKeys ?? entry.keysecondary ?? entry.secondaryKeywords);
  if (entry.comment != null && firstText(entry.comment) !== name) appendLine(lines, '条目备注', entry.comment);
  appendLine(lines, '正文', entry.content ?? entry.text ?? entry.description);
  const text = lines.join('\n');
  output.push({
    label: `世界书 · ${name}`,
    path,
    text,
    note: status,
  });
}

function findCardField(
  original: Record<string, unknown>,
  data: Record<string, unknown>,
  aliases: readonly string[],
): { value: unknown; path: JsonPath } | null {
  for (const key of aliases) {
    const value = data[key];
    if (hasReadableText(value)) return { value, path: data === original ? [key] : ['data', key] };
  }
  if (data !== original) {
    for (const key of aliases) {
      if (hasReadableText(original[key])) return { value: original[key], path: [key] };
    }
  }
  return null;
}

function appendFieldSources(
  output: Omit<ReaderSource, 'id'>[],
  label: string,
  value: unknown,
  path: JsonPath,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const text = readableValue(item);
      if (!text.trim()) return;
      output.push({ label: `${label} ${index + 1}`, path: [...path, index], text });
    });
    return;
  }
  const text = readableValue(value);
  if (text.trim()) output.push({ label, path, text });
}

function normalizeEntries(value: unknown, prefix: JsonPath = []): Array<{ entry: Record<string, unknown>; path: JsonPath }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => {
    const entry = asRecord(item);
    return entry ? [{ entry, path: [...prefix, index] }] : [];
  });
  const record = asRecord(value);
  if (!record) return [];
  for (const field of ['entries', 'lorebook', 'items']) {
    if (record[field] !== undefined) return normalizeEntries(record[field], [...prefix, field]);
  }
  return Object.entries(record).flatMap(([key, item]) => {
    const entry = asRecord(item);
    return entry ? [{ entry, path: [...prefix, key] }] : [];
  });
}

function entryIdentity(entry: Record<string, unknown>, index: number): string {
  return firstText(entry.uid, entry.id, entry.name, entry.comment, entry.key) || String(index);
}

function sourceHeader(source: ReaderSource): string {
  const label = source.label.slice(0, 160);
  const note = source.note ? `\n资料状态：${source.note.slice(0, 180)}` : '';
  return `${source.id} ${label}${note}`;
}

function chooseBoundary(text: string, start: number, maxLength: number): number {
  let end = Math.min(text.length, start + Math.max(1, maxLength));
  if (end < text.length) {
    const paragraphBreak = text.lastIndexOf('\n', end - 1);
    if (paragraphBreak >= start + Math.floor(maxLength * 0.55)) end = paragraphBreak + 1;
    if (end > start && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  }
  return Math.max(start + 1, end);
}

function isHighSurrogate(value: number): boolean { return value >= 0xd800 && value <= 0xdbff; }
function isLowSurrogate(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff; }

function withSourceIds(sources: Omit<ReaderSource, 'id'>[]): ReaderSource[] {
  return sources.map((source, index) => ({ ...source, id: `[S${index + 1}]` }));
}

function readableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const text = readableValue(item);
      return text.trim() ? `- ${text}` : '';
    }).filter(Boolean).join('\n');
  }
  const record = asRecord(value);
  if (record) {
    return Object.entries(record).flatMap(([key, item]) => {
      const text = readableValue(item);
      return text.trim() ? [`${key}: ${text}`] : [];
    }).join('\n');
  }
  return '';
}

function hasReadableText(value: unknown): boolean {
  return typeof value === 'string' ? Boolean(value.trim())
    : typeof value === 'number' || typeof value === 'boolean'
      ? true
      : Array.isArray(value)
        ? value.some(hasReadableText)
        : Boolean(asRecord(value) && Object.values(asRecord(value)!).some(hasReadableText));
}

function appendLine(lines: string[], label: string, value: unknown): void {
  const text = readableValue(value);
  if (text.trim()) lines.push(`${label}：\n${text}`);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
