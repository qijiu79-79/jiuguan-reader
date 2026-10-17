/** Shared contracts for the focused Mac reader/translator. No secrets in public DTOs. */
import type { TranslationDefaultField } from './translation-defaults.js';
export type JsonPath = Array<string | number>;
export interface WebMaterialSource { site: 'chub' | 'janny'; url: string; savedAt: string }
export interface Material {
  id: string; name: string; kind: 'card' | 'worldbook' | 'text';
  format: 'png' | 'json' | 'text'; hash: string; createdAt: string;
  /** Original upload basename; older locally imported materials may not have one. */
  fileName?: string;
  /** A durable local collection marker, not an expiring browser handoff. */
  webSource?: WebMaterialSource;
  updateInfo?: { updatedAt: string; changed: number; greetings: number };
  original: Record<string, unknown> | null; text: string;
  pngBase64?: string; metadataKeys?: string[]; warnings: string[];
}
export type MaterialSummary = Omit<Material, 'original' | 'text' | 'pngBase64' | 'metadataKeys'>;
export interface MaterialUpdateChange {
  label: string; category: string; kind: 'added' | 'changed' | 'removed' | 'moved';
  before?: string; after?: string;
}
export interface MaterialUpdatePreview {
  token: string; materialId: string; candidateName: string;
  changes: MaterialUpdateChange[]; unchanged: number; hasChanges: boolean;
}
/** Small, read-only list indicators; never contain source text, prompts or keys. */
export interface MaterialTaskActivity {
  status: 'idle' | 'running' | 'paused' | 'done' | 'error' | 'partial';
  completed: number; total: number; hasResult: boolean; approved?: number;
  resultRevision?: string; unread?: boolean; reviewCount?: number;
}
export interface MaterialActivity {
  materialId: string; reader: MaterialTaskActivity; translation: MaterialTaskActivity;
  /** Present after a local export was confirmed; remains after later draft edits. */
  exportedAt?: string;
  /** User-requested unread reminder, independent of saved AI results. */
  manualUnreadRevision?: string;
}
export type ProviderProtocol = 'openai-compatible' | 'anthropic' | 'gemini';
export const MAX_TRANSLATION_AUTO_RETRIES = 10;
export interface ProviderConfig {
  baseUrl: string; model: string; protocol?: ProviderProtocol; apiKey?: string; hasKey?: boolean;
  /** The library entry currently selected for this role; its configuration remains usable if the entry is removed. */
  libraryModelId?: string;
  /** Whether to request SSE from the provider. Older settings default to true. */
  stream?: boolean;
  /** Auto uses Responses for known modern GPT models; other compatible models retain Chat Completions. */
  openAITransport?: 'auto' | 'chat-completions' | 'responses';
  /** Mark reusable reference prefixes on models supporting explicit caching. */
  promptCache?: boolean;
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
  /** Translation source fingerprint; absent only on legacy/reader results. */
  sourceHash?: string;
  /** Exact translation working source, retained so a historical version can restore its matching source. */
  sourceText?: string;
  /** Explicit user edit, not a model result subject to source-preservation checks. */
  manual?: boolean;
}
/** Timing only: no HTTP headers, reasoning text or credentials. */
export interface CompletionTiming {
  startedAt: string; responseHeadersAt?: string;
  firstActivityAt?: string; lastActivityAt?: string;
  maxIdleMs: number; elapsedMs: number;
  /** Monotonic elapsed generation time; unaffected by wall-clock adjustments. */
  generationMs?: number;
  timeoutPhase?: 'first-response' | 'stream-idle' | 'non-stream';
  serverRequestId?: string;
}
/** Counts and fixed protocol labels only; never stores reasoning or wire payloads. */
export interface CompletionOutputDiagnostics {
  textChars: number; textFragments: number; reasoningChars: number; reasoningFragments: number;
  eventCount: number; unknownEventCount: number; terminalEventReceived: boolean;
  wireFormats: Array<'chat-completions' | 'responses' | 'anthropic' | 'gemini'>;
}
export interface TranslationRequestLog {
  id: string; materialId: string; itemId: string; fieldLabel: string;
  source: string; sourceTruncated?: boolean;
  model: string; protocol: ProviderProtocol; stream: boolean; maxOutputTokens: number;
  startedAt: string; finishedAt?: string; chunkIndex: number; chunkCount: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; truncated?: boolean }>;
  response?: string; responseTruncated?: boolean; error?: string;
  itemIds?: string[];
  purpose?: 'translation' | 'glossary' | 'repair';
  firstTextAt?: string; generatedAt?: string; savedAt?: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheWriteTokens?: number };
  requestMeta?: {
    transport: 'chat-completions' | 'responses' | 'anthropic' | 'gemini';
    inputChars: number; cachePrefixChars: number; prefixHash: string;
    /** Longest marked reusable prefix, including history; not measured tokens. */
    cacheReusableChars?: number;
    cacheCheckpointCount?: number;
    cacheMode: 'explicit' | 'implicit' | 'off';
    context?: TranslationContextPlan;
    timing?: CompletionTiming;
    output?: CompletionOutputDiagnostics;
  };
}
/** Local scheduling estimates, never provider-reported usage or a billing guarantee. */
export interface TranslationContextPlan {
  mode: 'full' | 'focused';
  purpose?: 'glossary';
  estimatedFullInputTokens: number; estimatedInputTokens: number;
  omittedOpenings: number; relatedOpenings: number;
  historyItems: number; historyTotal: number;
  oversized: boolean;
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
  /** Used only when first creating a card's translation scope or adding new fields. */
  defaultTranslationFields: TranslationDefaultField[];
  /** Retry only transient failures; zero disables automatic retries. */
  autoRetries?: number;
  presets: PromptPreset[];
  savedModels?: SavedModel[];
}
export interface GlossaryTerm { source: string; target: string }
export interface TranslationItem {
  id: string; path: JsonPath; label: string; category: string;
  kind: 'text' | 'keywords'; source: string; selected: boolean;
  /** Imported source retained when the translation working copy is edited. */
  originalSource?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  translated: string; approved: boolean; error?: string; warning?: string;
  /** A possible non-translation model reply; independent of format warnings. */
  reviewWarning?: string;
  variants?: ResultVariant[]; activeVariantId?: string;
  /** Transient display only; never an adopted or exported draft. */
  preview?: string;
  /** Runtime-only individual request waiting for a configured concurrency slot. */
  queued?: boolean;
  /** Changes in the most recent source-card update, independent of translation status. */
  updateKind?: 'added' | 'changed' | 'moved';
}
export interface TranslationProgress {
  phase: 'preparing' | 'waiting' | 'retrying' | 'generating' | 'checking';
  activeRequests: number; requests: number; totalItems: number; completedItems: number;
  startedAt: string; firstTextAt?: string;
}
export interface TranslationExportRecord {
  format: 'png' | 'json';
  savedAt: string;
  /** Basename only; the local export directory is never stored in the task record. */
  fileName: string;
  /** Fingerprint of the material and translation working state written to disk. */
  fingerprint: string;
}
export interface TranslationState {
  materialId: string; status: 'idle' | 'running' | 'paused' | 'done' | 'error';
  /** Changes only when a new model result is successfully saved. */
  resultRevision?: string;
  /** Optional saved-model override for this material; absent means follow the global translation default. */
  translationModelId?: string;
  /** Last file confirmed written by the desktop app; browser downloads are not recorded as disk saves. */
  lastExport?: TranslationExportRecord;
  /** Computed on read from lastExport and the current working state. */
  exportStatus?: 'never' | 'current' | 'stale';
  /** Distinguishes individually launched fields from a whole-scope batch. */
  runMode?: 'batch' | 'individual';
  items: TranslationItem[]; glossary: GlossaryTerm[]; error?: string;
  snapshot?: unknown; updatedAt: string;
  /** Frozen, key-free snapshots for unfinished independently launched fields. */
  individualSnapshots?: Record<string, unknown>;
  /** Runtime-only progress, omitted from persisted task records. */
  progress?: TranslationProgress;
  /** Most recently planned request; source data and drafts are never pruned. */
  contextPlan?: TranslationContextPlan;
}
/** Read-only status for wait loops that do not need draft text or item details. */
export type TranslationProgressState = Pick<TranslationState, 'status' | 'error'>;
export interface ReaderSource { id: string; label: string; text: string; path?: JsonPath; note?: string }
export interface ReaderMessage { id?: string; role: 'user' | 'assistant'; content: string; createdAt: string; variants?: ResultVariant[]; activeVariantId?: string }
export interface ReaderState {
  materialId: string; status: 'idle' | 'running' | 'paused' | 'done' | 'error';
  resultRevision?: string;
  summary: string; sources: ReaderSource[]; messages: ReaderMessage[];
  completed: number; total: number; error?: string; updatedAt: string;
  summaryVariants?: ResultVariant[]; activeSummaryVariantId?: string;
}
