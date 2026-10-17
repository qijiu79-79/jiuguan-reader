import { buildReadingDocument, getFollowUpDocument } from './source-domain.js';
import { analyzeDocument, askDocument } from './reader-engine.js';
import { createBrowserUuid } from './browser-compat.js';
import type { ReaderHost, ReadingDocument, ReadingProgress, SavedReading } from './types.js';

export interface ReaderState {
  loading: boolean;
  document: ReadingDocument | null;
  record: SavedReading | null;
  busy: boolean;
  progress: ReadingProgress | null;
  unsaved: boolean;
  status: string;
  error: string;
}

export interface ReaderJobResult {
  kind: 'read' | 'question';
  characterKey: string;
  characterName: string;
  outcome: 'saved' | 'unsaved' | 'failed';
}

interface ControllerDependencies {
  buildDocument?: typeof buildReadingDocument;
  analyze?: typeof analyzeDocument;
  ask?: typeof askDocument;
  now?: () => string;
  uuid?: () => string;
}

/** Each job keeps its own card snapshot; a late response never becomes another card's result. */
export class ReaderController {
  private state: ReaderState = {
    loading: false, document: null, record: null, busy: false, progress: null,
    unsaved: false, status: '', error: '',
  };
  private listeners = new Set<(state: ReaderState) => void>();
  private jobListeners = new Set<(result: ReaderJobResult) => void>();
  private loadVersion = 0;
  private loadAbort: AbortController | null = null;
  private jobAbort: AbortController | null = null;
  private readonly buildDocument: typeof buildReadingDocument;
  private readonly analyze: typeof analyzeDocument;
  private readonly askReading: typeof askDocument;
  private readonly now: () => string;
  private readonly uuid: () => string;

  constructor(private readonly host: ReaderHost, dependencies: ControllerDependencies = {}) {
    this.buildDocument = dependencies.buildDocument ?? buildReadingDocument;
    this.analyze = dependencies.analyze ?? analyzeDocument;
    this.askReading = dependencies.ask ?? askDocument;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.uuid = dependencies.uuid ?? createBrowserUuid;
  }

  getState(): ReaderState { return this.state; }

  subscribe(listener: (state: ReaderState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  subscribeJobs(listener: (result: ReaderJobResult) => void): () => void {
    this.jobListeners.add(listener);
    return () => { this.jobListeners.delete(listener); };
  }

  async loadCurrent(): Promise<void> {
    // Closing/reopening the view or changing the host's current character is
    // not cancellation. Keep the active card snapshot until its job is saved.
    if (this.state.busy) return;
    if (this.state.unsaved) {
      this.patch({ error: '还有未保存的解读或回答，请先点“保存”，再切换读卡对象。' });
      return;
    }
    const version = ++this.loadVersion;
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    const previouslyDisplayed = this.state.record;
    this.patch({ loading: true, document: null, record: previouslyDisplayed, busy: false, progress: null, error: '', status: '正在读取卡片资料；没有调用 AI。' });
    try {
      const material = await this.host.getMaterial(abort.signal);
      abort.signal.throwIfAborted();
      const document = await this.buildDocument(material);
      let record: SavedReading | null;
      let storageError = '';
      try {
        record = await this.host.store.load(document.characterKey);
      } catch (error) {
        record = previouslyDisplayed?.characterKey === document.characterKey ? previouslyDisplayed : null;
        storageError = `已保存解读读取失败：${errorMessage(error)}。保存文件未改动，可以关闭后重开重试；生成新解读将替换旧记录。`;
      }
      abort.signal.throwIfAborted();
      if (version !== this.loadVersion) return;
      this.patch({ document, record, error: storageError, status: storageError && record
        ? '暂时保留当前窗口已有的解读；没有调用 AI。'
        : record ? '已打开之前保存的解读；没有调用 AI。' : '资料已准备好，点击“生成解读”才会调用 AI。' });
    } catch (error) {
      if (version === this.loadVersion && !abort.signal.aborted) {
        this.patch({
          document: null,
          record: previouslyDisplayed,
          error: errorMessage(error),
          status: previouslyDisplayed
            ? `此前「${previouslyDisplayed.characterName}」的已保存解读仍保留；当前资料未取得，没有调用 AI。`
            : '当前资料未取得，没有调用 AI。',
        });
      }
    } finally {
      if (version === this.loadVersion) this.patch({ loading: false });
    }
  }

  async read(): Promise<void> {
    const document = this.state.document;
    if (!document || this.state.busy || this.state.loading) return;
    if (this.state.unsaved) {
      this.patch({ error: '请先保存当前结果，再重新解读；未保存的内容不会被覆盖。' });
      return;
    }
    await this.run('read', document, async (signal, onProgress) => {
      const settings = structuredClone(this.host.getSettings());
      const model = this.host.describeConnection(settings.connection);
      const result = await this.analyze(document, settings, this.host.generate.bind(this.host), signal, onProgress);
      signal.throwIfAborted();
      const record: SavedReading = {
        schemaVersion: 1,
        characterKey: document.characterKey,
        characterName: document.characterName,
        fingerprint: document.fingerprint,
        analysis: result.text,
        chunkNotes: result.chunkNotes,
        sourceCount: document.sources.length,
        chunkCount: result.chunkCount,
        sources: structuredClone(document.sources),
        worldbooks: [...document.worldbooks],
        warnings: [...document.warnings],
        readAt: this.now(),
        model,
        answers: [],
      };
      return record;
    });
  }

  async question(question: string): Promise<void> {
    const document = this.state.document;
    const saved = this.state.record;
    if (!document || !saved || this.state.busy || this.state.loading || !question.trim()) return;
    if (this.state.unsaved) {
      this.patch({ error: '请先保存当前结果，再继续追问。' });
      return;
    }
    if (document.characterKey !== saved.characterKey) {
      this.patch({ error: '当前资料与已保存解读不是同一角色，请重新打开读卡面板。' });
      return;
    }
    const questionDocument = getFollowUpDocument(document, saved);
    if (!questionDocument) {
      this.patch({ error: '旧解读缺少完整原文，无法安全继续追问；请重新解读当前设定。之前保存的内容仍保留。' });
      return;
    }
    await this.run('question', questionDocument, async (signal, onProgress) => {
      const settings = structuredClone(this.host.getSettings());
      const model = this.host.describeConnection(settings.connection);
      const result = await this.askReading(questionDocument, saved, question.trim(), settings, this.host.generate.bind(this.host), signal, onProgress);
      signal.throwIfAborted();
      return {
        ...structuredClone(saved),
        answers: [...saved.answers, {
          id: this.uuid(), question: question.trim(), answer: result.text,
          createdAt: this.now(), model,
        }],
      };
    });
  }

  cancel(): void { this.jobAbort?.abort(); }

  async save(): Promise<void> {
    const record = this.state.record;
    if (!record || !this.state.unsaved || this.state.busy) return;
    this.patch({ busy: true, error: '', status: '正在保存到酒馆用户文件…' });
    try {
      await this.host.store.save(record);
      this.patch({ unsaved: false, status: '已保存到酒馆用户文件，下次可以直接查看。' });
    } catch (error) {
      this.patch({ error: `保存失败：${errorMessage(error)}。内容仍在当前窗口，请重试保存。`, status: '尚未保存' });
    } finally {
      this.patch({ busy: false });
    }
  }

  private async run(kind: ReaderJobResult['kind'], document: ReadingDocument,
    operation: (signal: AbortSignal, onProgress: (progress: ReadingProgress) => void) => Promise<SavedReading>): Promise<void> {
    const abort = new AbortController();
    this.jobAbort = abort;
    const version = this.loadVersion;
    let outcome: ReaderJobResult['outcome'] | null = null;
    this.patch({ busy: true, progress: null, error: '', status: '正在解读，完成后自动保存；之前的结果仍保留。' });
    try {
      const record = await operation(abort.signal, (progress) => {
        if (version === this.loadVersion && !abort.signal.aborted) this.patch({ progress });
      });
      abort.signal.throwIfAborted();
      if (version !== this.loadVersion) return;
      this.patch({ record, progress: null, unsaved: true, status: '生成完成，正在保存…' });
      try {
        await this.host.store.save(record);
        outcome = 'saved';
        if (version === this.loadVersion) this.patch({ unsaved: false, status: '已自动保存，下次打开这张卡可以直接查看。' });
      } catch (error) {
        outcome = 'unsaved';
        if (version === this.loadVersion) this.patch({ error: `保存失败：${errorMessage(error)}。结果没有丢失，请点“保存”重试。`, status: '尚未保存' });
      }
    } catch (error) {
      if (!abort.signal.aborted) outcome = 'failed';
      if (version === this.loadVersion) {
        this.patch(abort.signal.aborted
          ? { progress: null, status: '已停止；之前保存的解读和回答没有改动。', error: '' }
          : { progress: null, status: '生成失败；之前保存的内容没有改动。', error: errorMessage(error) });
      }
    } finally {
      if (this.jobAbort === abort) this.jobAbort = null;
      if (version === this.loadVersion) this.patch({ busy: false, progress: null });
      if (outcome) {
        const result = { kind, characterKey: document.characterKey, characterName: document.characterName, outcome };
        this.jobListeners.forEach((listener) => listener(result));
      }
    }
  }

  private patch(update: Partial<ReaderState>): void {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener(this.state));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请检查连接后重试';
}
