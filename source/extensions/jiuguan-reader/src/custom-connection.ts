import type { ReaderConnection, ReaderMessage, ReaderSettings } from './types.js';

/** Keys stay in this page's memory, never in extension settings or browser storage. */
export function createCustomConnectionClient(dependencies: {
  fetcher?: typeof fetch;
  getHeaders: () => HeadersInit;
}) {
  const keys = new Map<string, string>();
  const sessions = new WeakMap<AbortSignal, {
    url: string; key: string; model: string; generation: Record<string, unknown>;
  }>();
  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);

  function keyFor(url: string, draftKey?: string): string {
    const key = draftKey?.trim() || keys.get(url) || '';
    if (/[\r\n]/u.test(key)) throw new Error('API Key 不能包含换行，请检查粘贴的内容。');
    return key;
  }

  async function request(route: 'status' | 'generate', payload: Record<string, unknown>, key: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const headers = new Headers(dependencies.getHeaders());
      headers.set('Content-Type', 'application/json');
      const response = await fetcher(`/api/backends/chat-completions/${route}`, {
        method: 'POST', headers, body: JSON.stringify(payload), signal, cache: 'no-cache',
      });
      if (signal.aborted) throw abortError();
      let data: Record<string, unknown> | null = null;
      try { data = asRecord(await response.json()); } catch { /* Report safe status, not arbitrary HTML. */ }
      if (signal.aborted) throw abortError();
      if (!response.ok || !data || data.error) {
        const details = safeError(data?.error ?? data?.message, key);
        throw new Error(`独立 API ${route === 'status' ? '拉取模型' : '请求'}失败${response.ok ? '' : `（HTTP ${response.status}）`}${details ? `：${details}` : '，请检查地址和 Key。'}`);
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
      try { return keys.has(resolveCustomApiBaseUrl(connection.baseUrl ?? '')); } catch { return false; }
    },

    rememberApiKey(connection: ReaderConnection, draftKey?: string): void {
      const url = resolveCustomApiBaseUrl(connection.baseUrl ?? '');
      if (draftKey?.trim()) keys.set(url, keyFor(url, draftKey));
    },

    async listModels(connection: ReaderConnection, signal: AbortSignal, draftKey?: string): Promise<string[]> {
      const url = resolveCustomApiBaseUrl(connection.baseUrl ?? '');
      const key = keyFor(url, draftKey);
      const data = await request('status', customFields(url, key), key, signal);
      const models = Array.isArray(data.data)
        ? [...new Set(data.data.map((item) => asRecord(item)?.id)
          .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
          .map((id) => id.trim()))].sort((left, right) => left.localeCompare(right))
        : [];
      if (!models.length) throw new Error('独立 API 没有返回模型列表；仍可在下方直接填写模型 ID。');
      return models;
    },

    async generate(messages: ReaderMessage[], settings: ReaderSettings, signal: AbortSignal, generation: Record<string, unknown>): Promise<Record<string, unknown>> {
      const url = resolveCustomApiBaseUrl(settings.connection.baseUrl ?? '');
      const model = settings.connection.model?.trim() || '';
      if (!model) throw new Error('请先为独立 API 选择或填写模型 ID。');
      const key = keyFor(url);
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
        stream: false, max_tokens: settings.maxOutputTokens,
        use_sysprompt: messages.some(({ role }) => role === 'system'),
        custom_prompt_post_processing: '',
      }, session.key, signal);
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
    .replace(/[\r\n\t ]+/gu, ' ').slice(0, 500);
}

function abortError(): Error {
  const error = new Error('请求已取消。');
  error.name = 'AbortError';
  return error;
}
