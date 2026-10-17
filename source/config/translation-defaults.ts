/** Stable field identifiers, shared by settings and the card scanner. */
export const TRANSLATION_FIELD_OPTIONS = [
  { id: 'name', label: '角色名称', group: '人物信息' },
  { id: 'first_mes', label: '主开场白', group: '开场内容' },
  { id: 'alternate_greetings', label: '备用开场白', group: '开场内容' },
  { id: 'group_only_greetings', label: '群聊开场白', group: '开场内容' },
  { id: 'description', label: '人物描述', group: '人物设定' },
  { id: 'personality', label: '性格', group: '人物设定' },
  { id: 'scenario', label: '场景', group: '人物设定' },
  { id: 'mes_example', label: '示例对白', group: '人物设定' },
  { id: 'creator_notes', label: '作者说明（含旧版字段）', group: '人物设定' },
  { id: 'worldbook-primary-keywords', label: '世界书主关键词', group: '世界书' },
  { id: 'worldbook-secondary-keywords', label: '世界书次关键词', group: '世界书' },
  { id: 'worldbook-content', label: '世界书正文', group: '世界书' },
  { id: 'worldbook-name', label: '世界书条目名称', group: '世界书' },
  { id: 'worldbook-comment', label: '世界书备注 / 标题', group: '世界书' },
] as const;

export type TranslationDefaultField = typeof TRANSLATION_FIELD_OPTIONS[number]['id'];

/** Upgrades retain the original defaults until the user saves a custom choice. */
export const DEFAULT_TRANSLATION_FIELDS: readonly TranslationDefaultField[] = [
  'name', 'first_mes', 'alternate_greetings', 'worldbook-primary-keywords', 'worldbook-secondary-keywords',
];

export function isTranslationDefaultField(value: unknown): value is TranslationDefaultField {
  return TRANSLATION_FIELD_OPTIONS.some(option => option.id === value);
}

/** Missing old settings use the original defaults; an explicit empty list stays empty. */
export function normalizeTranslationDefaultFields(value: unknown): TranslationDefaultField[] {
  if (!Array.isArray(value)) return [...DEFAULT_TRANSLATION_FIELDS];
  return [...new Set(value.filter(isTranslationDefaultField))];
}
