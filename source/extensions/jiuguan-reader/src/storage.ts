import type { ReaderSource } from '../../../config/tavern-types.js';
import { sha256Hex, type HashDependencies } from './browser-compat.js';
import type { ReadingStore, SavedAnswer, SavedReading } from './types.js';

const FILE_PREFIX = 'jiuguan-reader-';
const FILE_ROUTE = '/user/files/';

export interface ReaderStoreDependencies extends HashDependencies {
  fetcher?: typeof fetch;
  getHeaders?: () => HeadersInit;
}

/** Persist per-character read cards in SillyTavern's own user-files area. */
export function createReaderStore(dependencies: ReaderStoreDependencies = {}): ReadingStore {
  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  const getHeaders = dependencies.getHeaders ?? (() => ({}));

  return {
    async load(characterKey) {
      assertCharacterKey(characterKey);
      const fileName = await getFileName(characterKey, dependencies);
      let response: Response;
      try {
        response = await fetcher(`${FILE_ROUTE}${fileName}`, {
          method: 'GET',
          cache: 'no-cache',
          headers: getHeaders(),
        });
      } catch {
        throw new Error('无法连接酒馆用户文件；请检查酒馆服务和登录状态。');
      }

      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`读取已保存解读失败（HTTP ${response.status}）。`);

      let raw: unknown;
      try {
        raw = JSON.parse(await response.text()) as unknown;
      } catch {
        throw new Error('酒馆中的读卡记录格式无效；原文件未被修改。');
      }

      return validateSavedReading(raw, characterKey);
    },

    async save(record) {
      assertCharacterKey(record.characterKey);
      validateSavedReading(record, record.characterKey);
      const fileName = await getFileName(record.characterKey, dependencies);
      const encoded = encodeUtf8Base64(JSON.stringify(record));

      let response: Response;
      try {
        response = await fetcher('/api/files/upload', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ name: fileName, data: encoded }),
        });
      } catch {
        throw new Error('无法连接酒馆用户文件；本次保存未收到确认，请保留当前内容后重试。');
      }

      if (!response.ok) throw new Error(`酒馆拒绝保存读卡记录（HTTP ${response.status}）。`);

      let result: unknown;
      try {
        result = await response.json() as unknown;
      } catch {
        throw new Error('酒馆没有返回有效的保存确认；请重新打开读卡记录确认保存状态。');
      }
      const returnedPath = asRecord(result)?.path;
      if (typeof returnedPath !== 'string' || !isExpectedReturnedPath(returnedPath, fileName)) {
        throw new Error('酒馆返回了无法确认的用户文件路径；没有报告保存成功。');
      }
    },
  };
}

async function getFileName(characterKey: string, hashDependencies: HashDependencies): Promise<string> {
  const hash = await sha256Hex(characterKey, hashDependencies);
  return `${FILE_PREFIX}${hash}.json`;
}

function assertCharacterKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) {
    throw new Error('角色头像文件标识无效；无法安全定位这张卡的解读记录。');
  }
}

function validateSavedReading(value: unknown, expectedCharacterKey: string): SavedReading {
  const record = asRecord(value);
  if (!record
    || record.schemaVersion !== 1
    || record.characterKey !== expectedCharacterKey
    || typeof record.characterName !== 'string'
    || typeof record.fingerprint !== 'string'
    || typeof record.analysis !== 'string'
    || !isStringArray(record.chunkNotes)
    || !isNonNegativeInteger(record.sourceCount)
    || !isNonNegativeInteger(record.chunkCount)
    || !Array.isArray(record.sources)
    || !record.sources.every(isReaderSource)
    || !isStringArray(record.worldbooks)
    || !isStringArray(record.warnings)
    || typeof record.readAt !== 'string'
    || typeof record.model !== 'string'
    || !Array.isArray(record.answers)
    || !record.answers.every(isSavedAnswer)) {
    throw new Error('酒馆中的读卡记录缺少必要字段或角色标识不匹配；原文件未被修改。');
  }

  return record as unknown as SavedReading;
}

function isReaderSource(value: unknown): value is ReaderSource {
  const source = asRecord(value);
  return Boolean(source
    && typeof source.id === 'string'
    && typeof source.label === 'string'
    && typeof source.text === 'string'
    && (source.note === undefined || typeof source.note === 'string')
    && (source.path === undefined || (Array.isArray(source.path)
      && source.path.every((part) => typeof part === 'string' || typeof part === 'number'))));
}

function isSavedAnswer(value: unknown): value is SavedAnswer {
  const answer = asRecord(value);
  return Boolean(answer
    && typeof answer.id === 'string'
    && typeof answer.question === 'string'
    && typeof answer.answer === 'string'
    && typeof answer.createdAt === 'string'
    && typeof answer.model === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isExpectedReturnedPath(value: string, fileName: string): boolean {
  const parts = value.replace(/\\/gu, '/').split('/').filter(Boolean);
  return parts.at(-1) === fileName
    && parts.at(-2)?.toLocaleLowerCase() === 'files'
    && parts.at(-3)?.toLocaleLowerCase() === 'user';
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
