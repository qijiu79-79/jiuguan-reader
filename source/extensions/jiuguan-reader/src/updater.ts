import manifest from '../manifest.json';

export const READER_EXTENSION_VERSION = manifest.version;
export const READER_EXTENSION_REPOSITORY = 'https://github.com/qijiu79-79/jiuguan-reader';

export interface ExtensionUpdateState {
  phase: 'idle' | 'checking' | 'updating' | 'current' | 'updated' | 'error';
  message: string;
}

export interface ExtensionUpdater {
  getState(): ExtensionUpdateState;
  subscribe(listener: (state: ExtensionUpdateState) => void): () => void;
  update(): Promise<void>;
}

interface UpdaterDependencies {
  getHeaders: () => HeadersInit;
  fetcher?: typeof fetch;
  moduleUrl?: string;
  requestTimeoutMs?: number;
}

interface UpdateTarget {
  extensionName: string;
  global: boolean;
}

class UpdateError extends Error {
  constructor(message: string, readonly responseReceived = false) { super(message); }
}

/** Update only this installed extension through the authenticated Tavern API. */
export class ReaderUpdater implements ExtensionUpdater {
  private state: ExtensionUpdateState = { phase: 'idle', message: '手动检查并更新，不会自动刷新或调用 AI。' };
  private readonly listeners = new Set<(state: ExtensionUpdateState) => void>();
  private running: Promise<void> | null = null;
  private pendingReload = false;
  private checkedCommit: string | null = null;
  private unresolvedWrite = false;
  private readonly fetcher: typeof fetch;

  constructor(private readonly dependencies: UpdaterDependencies) {
    this.fetcher = dependencies.fetcher ?? ((...args) => fetch(...args));
  }

  getState(): ExtensionUpdateState { return this.state; }

  subscribe(listener: (state: ExtensionUpdateState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  async update(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.performUpdate();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async performUpdate(): Promise<void> {
    try {
      this.patch('checking', '正在检查安装来源和更新；没有调用 AI。');
      const target = await this.findTarget();
      const version = record(await this.request('/api/extensions/version', target));
      if (!version) throw new UpdateError('酒馆返回的版本信息不完整；本次没有下载更新。');
      if (!version.remoteUrl && !version.currentCommitHash) {
        throw new UpdateError('当前是手动 ZIP 安装，不能一键更新。请保留用户数据，改用公开仓库地址从酒馆“安装扩展”安装。');
      }
      if (!isReaderRepository(version.remoteUrl)) {
        throw new UpdateError('安装来源不是酒馆读卡的发布仓库；本次没有更新，请先核对安装地址。');
      }
      if (typeof version.isUpToDate !== 'boolean' || typeof version.currentBranchName !== 'string'
        || !version.currentBranchName.trim() || !isCommitHash(version.currentCommitHash)) {
        throw new UpdateError('酒馆返回的版本信息不完整；本次没有下载更新。');
      }
      if (!this.checkedCommit) this.checkedCommit = String(version.currentCommitHash);
      if (version.currentCommitHash !== this.checkedCommit) {
        this.pendingReload = true;
        this.unresolvedWrite = false;
        this.patch('updated', '已确认安装文件发生更新，当前页面尚未应用。请先保存酒馆中其他未保存的输入，再刷新页面。');
        return;
      }
      if (version.isUpToDate) {
        this.unresolvedWrite = false;
        this.patch(this.pendingReload ? 'updated' : 'current', this.pendingReload
          ? '更新已下载，当前页面尚未应用。请先保存酒馆中其他未保存的输入，再刷新页面。'
          : '已经是当前安装分支的最新版本；已有解读和设置没有改动。');
        return;
      }
      if (this.unresolvedWrite) {
        throw new UpdateError('上次下载结果暂不确定，服务器可能仍在处理。当前只核对状态，不会重复下载；请稍后重新检查。若持续无变化，请让管理员检查服务器日志。');
      }

      this.patch('updating', '正在通过酒馆下载更新；完成后由你决定何时刷新。');
      this.unresolvedWrite = true;
      let result: Record<string, unknown> | null;
      try {
        result = record(await this.request('/api/extensions/update', target));
      } catch (error) {
        // A finished HTTP error allows retrying. A disconnected or timed-out
        // browser request does not prove that Tavern stopped its Git operation.
        if (error instanceof UpdateError && error.responseReceived) this.unresolvedWrite = false;
        throw error;
      }
      if (!result || typeof result.isUpToDate !== 'boolean' || !isShortCommitHash(result.shortCommitHash)
        || !isReaderRepository(result.remoteUrl)) {
        throw new UpdateError('酒馆没有返回完整的更新结果；请在扩展管理中核对状态后再刷新。解读和设置未改动。');
      }
      // Even an "already current" response may mean another Tavern tab updated
      // between the check and pull. This page still runs its original code.
      this.unresolvedWrite = false;
      this.pendingReload = true;
      this.patch('updated', `更新已下载（${result.shortCommitHash}）。请先保存酒馆中其他未保存的输入，再刷新页面应用更新。`);
    } catch (error) {
      this.patch('error', error instanceof UpdateError ? error.message
        : '未能完成更新，请检查网络或酒馆服务器日志后重试。已有解读和设置未改动。');
    }
  }

  private async findTarget(): Promise<UpdateTarget> {
    const url = new URL(this.dependencies.moduleUrl ?? import.meta.url);
    const match = /^\/scripts\/extensions\/third-party\/([a-zA-Z0-9_-][a-zA-Z0-9._-]*)\/index\.js$/u.exec(url.pathname);
    if (!match) throw new UpdateError('无法确定当前插件的安装目录；本次没有更新，请使用酒馆扩展管理。');
    const extensionName = match[1];
    const installed = await this.request('/api/extensions/discover');
    if (!Array.isArray(installed)) throw new UpdateError('无法取得酒馆的安装类型；本次没有更新。');
    const matches = installed.map(record).filter((item) => item?.name === `third-party/${extensionName}`);
    if (matches.length !== 1 || !['local', 'global'].includes(String(matches[0]?.type))) {
      throw new UpdateError('未找到当前读卡插件的有效安装记录；请在酒馆扩展管理中核对。');
    }
    return { extensionName, global: matches[0]?.type === 'global' };
  }

  private async request(endpoint: string, body?: UpdateTarget): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.dependencies.requestTimeoutMs ?? 90_000);
    try {
      const headers = new Headers(this.dependencies.getHeaders());
      if (body) headers.set('Content-Type', 'application/json');
      const response = await this.fetcher(endpoint, {
        method: body ? 'POST' : 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        if (response.status === 401) throw new UpdateError('酒馆登录已失效，请重新登录后再更新。', true);
        if (response.status === 403) throw new UpdateError('酒馆拒绝了更新请求。全局安装需要管理员权限；也请确认登录仍有效。', true);
        if (response.status === 404) throw new UpdateError('酒馆未找到插件目录或更新接口；请在扩展管理中核对安装。', true);
        throw new UpdateError(`酒馆更新接口返回 ${response.status}，请检查酒馆到 GitHub 的网络或服务器日志后重试。已有解读和设置未改动。`, true);
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new UpdateError('更新请求超时。服务器可能仍在处理，请稍后重新检查；已有解读和设置未改动。');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private patch(phase: ExtensionUpdateState['phase'], message: string): void {
    this.state = { phase, message };
    for (const listener of this.listeners) listener(this.state);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isCommitHash(value: unknown): boolean {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value);
}

function isShortCommitHash(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/iu.test(value);
}

function isReaderRepository(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/^git@github\.com:qijiu79-79\/jiuguan-reader(?:\.git)?$/iu.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && /^\/qijiu79-79\/jiuguan-reader(?:\.git)?\/?$/iu.test(url.pathname);
  } catch {
    return false;
  }
}
