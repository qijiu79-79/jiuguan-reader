import type { ReaderConnection, ReaderMessage, ReaderSettings } from './types.js';
import { providerErrorMessage, readCompletionResponse } from './completion-stream.js';

/** Read saved keys from the current Tavern user's settings, not per-device storage. */
export function createCustomConnectionClient(dependencies: {
  fetcher?: typeof fetch;
  getHeaders: () => HeadersInit;
  getSavedApiKey?: (url: string) => string | undefined;
}) {
  const sessions = new WeakMap<AbortSignal, {
    url: string; key: string; model: string; generation: Record<string, unknown>;
  }>();
  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);

  function keyFor(url: string, draftKey?: string): string {
    const key = draftKey?.trim() || dependencies.getSavedApiKey?.(url) || '';
    if (/[\r\n]/u.test(key)) throw new Error('API Key 不能包含换行，请检查粘贴的内容。');
    return key;
  }

  async function request(route: 'status' | 'generate', payload: Record<string, unknown>, key: string, signal: AbortSignal, onText?: (text: string) => void): Promise<Record<string, unknown>> {
    try {
      const headers = new Headers(dependencies.getHeaders());
      headers.set('Content-Type', 'application/json');
      const response = await fetcher(`/api/backends/chat-completions/${route}`, {
        method: 'POST', headers, body: JSON.stringify(payload), signal, cache: 'no-cache',
      });
      if (signal.aborted) throw abortError();
      if (response.ok && payload.stream === true) {
        const data = await readCompletionResponse(response, signal, onText);
        if (data.error) throw new Error(providerErrorMessage(data) || '独立 API 返回了错误，未采用结果。');
        return data;
      }
      let data: Record<string, unknown> | null = null;
      let raw = '';
      try {
        raw = await response.text();
        data = asRecord(JSON.parse(raw));
      } catch { /* Plain-text errors are allowed, arbitrary HTML is not. */ }
      if (signal.aborted) throw abortError();
      if (!response.ok || !data || data.error) {
        const details = safeError(providerErrorMessage(data) || (!/[<>]/u.test(raw) ? raw : ''), key);
        // SillyTavern maps upstream 401 to HTTP 400 but retains Unauthorized.
        const hint = /401|403|unauthorized|forbidden|invalid.{0,15}(key|credential)/iu.test(`${response.status} ${response.statusText} ${details}`)
          ? ' 请打开读卡设置检查或重填 Key，再保存；本次未改用聊天 API。'
          : response.status === 429 || /quota|rate.limit/iu.test(details) ? ' 请检查接口额度或稍后再试。' : ' 请检查地址、模型和接口支持的参数。';
        throw new Error(`独立 API ${route === 'status' ? '拉取模型' : '请求'}失败${response.ok ? '' : `（HTTP ${response.status}）`}${details ? `：${details}` : '：接口没有提供错误详情。'}${hint}`);
      }
      return data;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
      const message = safeError(error, key);
      throw new Error(message || '无法连接独立 API，请检查地址和 Key；没有改用酒馆聊天连接。');
    }
  }

  return {
    hasApiKey(connection: ReaderConnection): boolean {
      try { return Boolean(keyFor(resolveCustomApiBaseUrl(connection.baseUrl ?? ''))); } catch { return false; }
    },

    async listModels(connection: ReaderConnection, signal: AbortSignal, draftKey?: string): Promise<string[]> {
      const url = resolveCustomApiBaseUrl(connection.baseUrl ?? '');
      const key = connection.noApiKey ? '' : keyFor(url, draftKey);
      const data = await request('status', customFields(url, key), key, signal);
      const models = Array.isArray(data.data)
        ? [...new Set(data.data.map((item) => asRecord(item)?.id)
          .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
          .map((id) => id.trim()))].sort((left, right) => left.localeCompare(right))
        : [];
      if (!models.length) throw new Error('独立 API 没有返回模型列表；仍可在下方直接填写模型 ID。');
      return models;
    },

    async generate(messages: ReaderMessage[], settings: ReaderSettings, signal: AbortSignal, generation: Record<string, unknown>, onText?: (text: string) => void): Promise<Record<string, unknown>> {
      const url = resolveCustomApiBaseUrl(settings.connection.baseUrl ?? '');
      const model = settings.connection.model?.trim() || '';
      if (!model) throw new Error('请先为独立 API 选择或填写模型 ID。');
      const key = settings.connection.noApiKey ? '' : keyFor(url);
      if (!key && !isLocalApi(url) && !settings.connection.noApiKey) throw new Error('请在读卡设置填写 API Key 并保存；保存一次后，刷新和手机登录同一酒馆用户都可继续使用。无需密钥的接口可勾选“接口无需 Key”。');
      let session = sessions.get(signal);
      if (session && (session.url !== url || session.key !== key || session.model !== model)) {
        throw new Error('独立 API 的地址、Key 或模型在读卡过程中发生变化；已停止，未混用连接。');
      }
      if (!session) {
        session = { url, key, model, generation: { ...generation } };
        sessions.set(signal, session);
      }
      return request('generate', {
        ...customFields(session.url, session.key), ...session.generation,
        model: session.model, messages: messages.map(({ role, content }) => ({ role, content })),
        stream: settings.stream, max_tokens: settings.maxOutputTokens,
        use_sysprompt: messages.some(({ role }) => role === 'system'),
        custom_prompt_post_processing: '',
      }, session.key, signal, onText);
    },
  };
}

export function resolveCustomApiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请填写完整 API 地址，例如 https://服务商地址/v1。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址只支持 HTTP/HTTPS，不要在地址中填写 Key、账号密码、查询参数或 # 后缀。');
  }
  let path = url.pathname.replace(/\/+$/u, '').replace(/\/(?:chat\/completions|models)$/u, '');
  if (!path) path = '/v1';
  return `${url.origin}${path}`;
}

function customFields(url: string, key: string): Record<string, unknown> {
  // Same host-backed OpenAI-compatible route used by LittleWhiteBox: no CORS,
  // Connection Manager profile, current credentials, or global API switch needed.
  return { chat_completion_source: 'openai', reverse_proxy: url, proxy_password: key };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeError(value: unknown, key: string): string {
  const record = asRecord(value);
  let text = value instanceof Error ? value.message
    : typeof value === 'string' ? value
      : typeof record?.message === 'string' ? record.message : '';
  if (key) text = text.split(key).join('[密钥已隐藏]');
  return text.replace(/https?:\/\/[^\s"'<>]+/giu, '[地址已隐藏]')
    .replace(/\bBearer\s+[^\s,;)}\]]+/giu, 'Bearer [密钥已隐藏]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/giu, '[密钥已隐藏]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|authorization|credential)(\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/giu, '$1$2[已隐藏]')
    .replace(/[\r\n\t ]+/gu, ' ').slice(0, 500);
}

function isLocalApi(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname === '[::1]' || /^127\./u.test(hostname) || /^10\./u.test(hostname)
    || /^192\.168\./u.test(hostname) || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname);
}

function abortError(): Error {
  const error = new Error('请求已取消。');
  error.name = 'AbortError';
  return error;
}
