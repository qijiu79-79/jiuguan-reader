/** Shared contracts for the focused Mac reader/translator. No secrets in public DTOs. */
export type JsonPath = Array<string | number>;
export interface WebMaterialSource { site: 'chub' | 'janny'; url: string; savedAt: string }
export interface Material {
  id: string; name: string; kind: 'card' | 'worldbook' | 'text';
  format: 'png' | 'json' | 'text'; hash: string; createdAt: string;
  /** Original upload basename; older locally imported materials may not have one. */
  fileName?: string;
  /** A durable local collection marker, not an expiring browser handoff. */
  webSource?: WebMaterialSource;
  original: Record<string, unknown> | null; text: string;
  pngBase64?: string; metadataKeys?: string[]; warnings: string[];
}
export type MaterialSummary = Omit<Material, 'original' | 'text' | 'pngBase64' | 'metadataKeys'>;
export type ProviderProtocol = 'openai-compatible' | 'anthropic' | 'gemini';
export interface ProviderConfig {
  baseUrl: string; model: string; protocol?: ProviderProtocol; apiKey?: string; hasKey?: boolean;
  /** The library entry currently selected for this role; its configuration remains usable if the entry is removed. */
  libraryModelId?: string;
  /** Whether to request SSE from the provider. Older settings default to true. */
  stream?: boolean;
  timeoutSeconds: number; maxOutputTokens: number; contextChars: number;
}
/** Request-only connection draft. Model discovery never persists these values. */
export interface ModelConnectionDraft { baseUrl: string; protocol?: ProviderProtocol; apiKey?: string; clearKey?: boolean }
export interface SavedModel { id: string; name: string; provider: ProviderConfig; sourceId?: string; sourceName?: string }
export interface ModelLibraryDraft {
  sourceName: string; connection?: ModelConnectionDraft; models: string[]; sourceModelId?: string;
}
export interface ModelSourceDraft { sourceName: string; connection: ModelConnectionDraft }
export interface ResultVariant {
  id: string; content: string; createdAt: string; model: string;
  baseUrl?: string; systemPrompt?: string; taskPrompt?: string;
}
/** systemPrompt is retained only to import settings/presets from older versions. */
export interface PromptPreset { id: string; name: string; systemPrompt: string; translationPrompt: string }
export interface TavernSettings {
  sharedSystemPrompt: string;
  sharedPromptTargets: Array<'translation' | 'reader'>;
  translation: ProviderConfig;
  reader: ProviderConfig & { useTranslation: boolean; systemPrompt: string; analysisPrompt: string };
  /** Legacy translation-only system prompt; merged into translationPrompt when settings are read. */
  systemPrompt: string; translationPrompt: string;
  concurrency: number; sourceLanguage: string; targetLanguage: string;
  presets: PromptPreset[];
  savedModels?: SavedModel[];
}
export interface GlossaryTerm { source: string; target: string }
export interface TranslationItem {
  id: string; path: JsonPath; label: string; category: string;
  kind: 'text' | 'keywords'; source: string; selected: boolean;
  status: 'pending' | 'running' | 'done' | 'error';
  translated: string; approved: boolean; error?: string; warning?: string;
  variants?: ResultVariant[]; activeVariantId?: string;
}
export interface TranslationState {
  materialId: string; status: 'idle' | 'running' | 'paused' | 'done' | 'error';
  items: TranslationItem[]; glossary: GlossaryTerm[]; error?: string;
  snapshot?: unknown; updatedAt: string;
}
export interface ReaderSource { id: string; label: string; text: string; path?: JsonPath; note?: string }
export interface ReaderMessage { id?: string; role: 'user' | 'assistant'; content: string; createdAt: string; variants?: ResultVariant[]; activeVariantId?: string }
export interface ReaderState {
  materialId: string; status: 'idle' | 'running' | 'paused' | 'done' | 'error';
  summary: string; sources: ReaderSource[]; messages: ReaderMessage[];
  completed: number; total: number; error?: string; updatedAt: string;
  summaryVariants?: ResultVariant[]; activeSummaryVariantId?: string;
}
