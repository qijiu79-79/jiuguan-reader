import type { ReaderSource } from '../../../config/tavern-types.js';

export type { ReaderSource };

export interface LinkedWorldbook {
  name: string;
  binding: 'primary' | 'extra';
  data: Record<string, unknown>;
}

export interface ReadingMaterial {
  characterKey: string;
  characterName: string;
  card: Record<string, unknown>;
  worldbooks: LinkedWorldbook[];
  warnings: string[];
}

export interface ReadingDocument {
  characterKey: string;
  characterName: string;
  fingerprint: string;
  sources: ReaderSource[];
  worldbooks: string[];
  warnings: string[];
}

export interface ReaderConnection {
  mode: 'current' | 'profile';
  profileId: string;
  model?: string;
}

export interface ReaderGenerationSettings {
  inherit: boolean;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

export interface ReaderConnectionInfo {
  label: string;
  source: string;
  model: string;
}

export interface ReaderSettings {
  systemPrompt: string;
  analysisPrompt: string;
  connection: ReaderConnection;
  generation: ReaderGenerationSettings;
  contextChars: number;
  maxOutputTokens: number;
  quickQuestions: string[];
}

export interface ConnectionProfile {
  id: string;
  name: string;
}

export interface ReaderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ReadingProgress {
  phase: 'reading' | 'combining';
  completed: number;
  total: number;
  sourceCount: number;
}

export interface ReadingResult {
  text: string;
  chunkNotes: string[];
  chunkCount: number;
}

export interface SavedAnswer {
  id: string;
  question: string;
  answer: string;
  createdAt: string;
  model: string;
}

export interface SavedReading {
  schemaVersion: 1;
  characterKey: string;
  characterName: string;
  fingerprint: string;
  analysis: string;
  chunkNotes: string[];
  sourceCount: number;
  chunkCount: number;
  sources: ReaderSource[];
  worldbooks: string[];
  warnings: string[];
  readAt: string;
  model: string;
  answers: SavedAnswer[];
}

export interface ReadingStore {
  load(characterKey: string): Promise<SavedReading | null>;
  save(record: SavedReading): Promise<void>;
}

export interface ReaderHost {
  getMaterial(signal?: AbortSignal): Promise<ReadingMaterial>;
  getSettings(): ReaderSettings;
  saveSettings(settings: ReaderSettings): Promise<void>;
  getProfiles(): ConnectionProfile[];
  getConnectionInfo(connection: ReaderConnection): ReaderConnectionInfo;
  listModels(connection: ReaderConnection, signal?: AbortSignal): Promise<string[]>;
  describeConnection(connection: ReaderConnection): string;
  generate(messages: ReaderMessage[], settings: ReaderSettings, signal: AbortSignal): Promise<string>;
  store: ReadingStore;
}

export type GenerateReading = (
  messages: ReaderMessage[],
  settings: ReaderSettings,
  signal: AbortSignal,
) => Promise<string>;
