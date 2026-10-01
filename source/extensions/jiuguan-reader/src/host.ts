import { normalizeReaderSettings } from './settings.js';
import { createCustomConnectionClient, resolveCustomApiBaseUrl } from './custom-connection.js';
import { providerErrorMessage, readCompletionResponse } from './completion-stream.js';
import { createReaderStore, type ReaderStoreDependencies } from './storage.js';
import type {
  ConnectionProfile,
  ReaderConnection,
  ReaderHost,
  ReaderMessage,
  ReaderSettings,
  ReadingMaterial,
} from './types.js';

const EXTENSION_SETTINGS_KEY = 'jiuguan-reader';
const PROFILE_WITHOUT_SECRET_ID = 'jiuguan-reader:no-profile-secret';
const WORLD_INFO_MODULE_URL = '/scripts/world-info.js';
const CORE_SCRIPT_MODULE_URL = '/script.js';
const OPENAI_SCRIPT_MODULE_URL = '/scripts/openai.js';
const SETTINGS_SAVE_TIMEOUT_MS = 10_000;
const MODEL_LIST_TIMEOUT_MS = 20_000;
const MODEL_LIST_SETTING_NAMES = [
  'custom_url', 'custom_include_headers', 'reverse_proxy', 'proxy_password', 'secret_id',
  'azure_base_url', 'azure_deployment_name', 'azure_api_version', 'siliconflow_endpoint',
  'minimax_endpoint', 'workers_ai_account_id', 'pollinations_endpoint',
] as const;
const CURRENT_CHAT_SETTING_MAP = [
  ['temp_openai', 'temperature'],
  ['freq_pen_openai', 'frequency_penalty'],
  ['pres_pen_openai', 'presence_penalty'],
  ['top_p_openai', 'top_p'],
  ['top_k_openai', 'top_k'],
  ['min_p_openai', 'min_p'],
  ['top_a_openai', 'top_a'],
  ['repetition_penalty_openai', 'repetition_penalty'],
  ['seed', 'seed'],
  ['reasoning_effort', 'reasoning_effort'],
  ['verbosity', 'verbosity'],
  ['nanogpt_provider', 'nanogpt_provider'],
  ['nanogpt_payg_override', 'nanogpt_payg_override'],
  ['openrouter_use_fallback', 'use_fallback'],
  ['openrouter_providers', 'provider'],
  ['openrouter_quantizations', 'quantizations'],
  ['openrouter_allow_fallbacks', 'allow_fallbacks'],
  ['openrouter_middleout', 'middleout'],
  ['azure_base_url', 'azure_base_url'],
  ['azure_deployment_name', 'azure_deployment_name'],
  ['azure_api_version', 'azure_api_version'],
  ['vertexai_auth_mode', 'vertexai_auth_mode'],
  ['vertexai_region', 'vertexai_region'],
  ['vertexai_express_project_id', 'vertexai_express_project_id'],
  ['zai_endpoint', 'zai_endpoint'],
  ['siliconflow_endpoint', 'siliconflow_endpoint'],
  ['minimax_endpoint', 'minimax_endpoint'],
  ['pollinations_endpoint', 'pollinations_endpoint'],
  ['workers_ai_account_id', 'workers_ai_account_id'],
  ['custom_url', 'custom_url'],
  ['custom_include_body', 'custom_include_body'],
  ['custom_exclude_body', 'custom_exclude_body'],
  ['custom_include_headers', 'custom_include_headers'],
  ['reverse_proxy', 'reverse_proxy'],
  ['proxy_password', 'proxy_password'],
  ['secret_id', 'secret_id'],
] as const;
const CURRENT_CHAT_CONNECTION_IDENTITY_SETTINGS = [
  'nanogpt_provider',
  'nanogpt_payg_override',
  'openrouter_use_fallback',
  'openrouter_providers',
  'openrouter_quantizations',
  'openrouter_allow_fallbacks',
  'openrouter_middleout',
  'azure_base_url',
  'azure_deployment_name',
  'azure_api_version',
  'vertexai_auth_mode',
  'vertexai_region',
  'vertexai_express_project_id',
  'zai_endpoint',
  'siliconflow_endpoint',
  'minimax_endpoint',
  'pollinations_endpoint',
  'workers_ai_account_id',
  'custom_url',
  'reverse_proxy',
  'secret_id',
] as const;

interface NativeCharacter extends Record<string, unknown> {
  avatar?: unknown;
  name?: unknown;
  data?: unknown;
}

interface NativeEventSource {
  once?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}

interface NativeContext {
  characterId?: number | string;
  groupId?: string;
  menuType?: string;
  characters?: NativeCharacter[];
  extensionSettings?: Record<string, unknown>;
  mainApi?: string;
  chatCompletionSettings?: Record<string, unknown>;
  CONNECT_API_MAP?: Record<string, unknown>;
  getOneCharacter?: (avatar: string) => Promise<void>;
  loadWorldInfo?: (name: string) => Promise<unknown>;
  getRequestHeaders?: () => HeadersInit;
  substituteParams?: (value: string) => string;
  getChatCompletionModel?: () => string;
  ChatCompletionService?: {
    processRequest?: (
      requestData: Record<string, unknown>,
      options: Record<string, unknown>,
      extractData: boolean,
      signal: AbortSignal,
    ) => Promise<unknown>;
  };
  ConnectionManagerRequestService?: {
    getSupportedProfiles?: () => NativeConnectionProfile[];
    sendRequest?: (
      profileId: string,
      messages: ReaderMessage[],
      maxTokens: number,
      options: Record<string, unknown>,
      overridePayload: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  eventSource?: NativeEventSource;
  eventTypes?: Record<string, string>;
}

interface NativeConnectionProfile extends Record<string, unknown> {
  id?: unknown;
  name?: unknown;
  api?: unknown;
  model?: unknown;
  'api-url'?: unknown;
  'secret-id'?: unknown;
  proxy?: unknown;
}

interface NativeProfileSnapshot {
  id: string;
  api: string;
  model?: string;
  source: string;
  apiUrl?: string;
  secretId?: string;
  proxy?: string;
}

interface NativeCurrentConnectionSnapshot {
  mainApi: string;
  source: string;
  model: string;
  connectionSettings: Record<string, unknown>;
}

type GenerationSession =
  | {
    mode: 'current';
    model: string;
    source: string;
    requestDefaults: Record<string, unknown>;
    identity: NativeCurrentConnectionSnapshot;
    modelOverride?: string;
  }
  | { mode: 'profile'; profileId: string; profile: NativeProfileSnapshot; proxyEndpoint?: string; proxyPassword?: string; modelOverride?: string; samplingDefaults: Record<string, unknown> };

interface WorldInfoState {
  world_info?: unknown;
}

export interface ReaderHostDependencies {
  getContext?: () => NativeContext;
  getWorldInfoSettings?: () => Promise<WorldInfoState> | WorldInfoState;
  saveNativeSettings?: (context: NativeContext) => Promise<void>;
  getProfileProxyEndpoint?: (proxyName: string) => string | undefined | Promise<string | undefined>;
  getProfileProxyPassword?: (proxyName: string) => string | Promise<string>;
  store?: ReaderHost['store'];
  fetcher?: ReaderStoreDependencies['fetcher'];
}

/** Bridge the reader engine to SillyTavern's current character, API and user files. */
export function createReaderHost(dependencies: ReaderHostDependencies = {}): ReaderHost {
  const getContext = dependencies.getContext ?? getGlobalContext;
  const store = dependencies.store ?? createReaderStore({
    fetcher: dependencies.fetcher,
    getHeaders: () => getContext().getRequestHeaders?.() ?? {},
  });
  const generationSessions = new WeakMap<AbortSignal, GenerationSession>();
  const customClient = createCustomConnectionClient({
    fetcher: dependencies.fetcher,
    getHeaders: () => getContext().getRequestHeaders?.() ?? {},
    getSavedApiKey: (url) => normalizeReaderSettings(getContext().extensionSettings?.[EXTENSION_SETTINGS_KEY]).customApiKeys?.[url],
  });

  return {
    async getMaterial(signal) {
      const context = getContext();
      throwIfAborted(signal);
      if (context.menuType === 'create' || context.characterId === undefined || context.characterId === '') {
        throw new Error('请先打开一张已保存的角色卡，再开始读卡。');
      }

      const characterIndex = Number(context.characterId);
      const characters = context.characters;
      const before = Number.isInteger(characterIndex) ? characters?.[characterIndex] : undefined;
      const avatar = typeof before?.avatar === 'string' ? before.avatar : '';
      if (!before || !avatar.trim()) throw new Error('当前角色卡没有可用的头像文件标识，无法安全读取。');
      if (typeof context.getOneCharacter !== 'function') {
        throw new Error('当前酒馆版本没有提供完整角色卡读取接口；没有开始读卡。');
      }

      try {
        await context.getOneCharacter(avatar);
      } catch {
        throw new Error('酒馆没有成功读取完整角色卡；请检查角色文件后重试。');
      }
      throwIfAborted(signal);

      // In SillyTavern 1.19.0 getOneCharacter fetches /api/characters/get
      // with shallow:false and replaces the matching character in this array.
      const character = context.characters?.find((item) => item.avatar === avatar);
      if (!character || character === before) {
        throw new Error('没有取得完整角色卡资料；本次没有向模型发送内容。');
      }

      const characterKey = avatar;
      const characterName = typeof character.name === 'string' && character.name.trim()
        ? character.name
        : '未命名角色';
      const warnings: string[] = [];
      const worldbookBindings = collectWorldbookBindings(character, warnings);

      try {
        const worldInfo = await readWorldInfoSettings(dependencies.getWorldInfoSettings);
        const state = asRecord(worldInfo.world_info);
        if (!state) {
          warnings.push('无法读取酒馆的角色额外世界书绑定；本次资料可能不完整。');
        } else {
          const charLore = state.charLore;
          if (charLore !== undefined && !Array.isArray(charLore)) {
            warnings.push('酒馆的额外世界书绑定格式无法识别；本次资料可能不完整。');
          } else if (Array.isArray(charLore)) {
            const avatarFileName = avatar.replace(/\.[^/.]+$/u, '');
            const binding = charLore
              .map(asRecord)
              .find((entry) => entry?.name === avatarFileName);
            const extraBooks = binding?.extraBooks;
            if (extraBooks !== undefined && !Array.isArray(extraBooks)) {
              warnings.push('这张角色卡的额外世界书列表格式无法识别；本次资料可能不完整。');
            } else if (Array.isArray(extraBooks)) {
              for (const name of extraBooks) {
                if (typeof name === 'string' && name.trim()) {
                  worldbookBindings.push({ name, binding: 'extra' });
                }
              }
            }
          }
        }
      } catch {
        warnings.push('无法读取酒馆的角色额外世界书绑定；本次资料可能不完整。');
      }

      throwIfAborted(signal);
      const worldbooks = await loadLinkedWorldbooks(context, worldbookBindings, warnings, signal);
      return {
        characterKey,
        characterName,
        card: character,
        worldbooks,
        warnings: [...new Set(warnings)],
      };
    },

    getSettings() {
      const value = getContext().extensionSettings?.[EXTENSION_SETTINGS_KEY];
      return normalizeReaderSettings(value);
    },

    async saveSettings(settings, draftApiKey) {
      const context = getContext();
      const extensionSettings = context.extensionSettings;
      if (!extensionSettings) throw new Error('酒馆设置尚未加载；没有保存读卡设置。');

      const normalized = normalizeReaderSettings(settings);
      const previous = extensionSettings[EXTENSION_SETTINGS_KEY];
      const savedKeys = normalizeReaderSettings(previous).customApiKeys;
      // The form only edits one connection. Saving prompts or parameters keeps all saved keys.
      if (savedKeys) normalized.customApiKeys = { ...savedKeys };
      if (normalized.connection.mode === 'custom') {
        normalized.connection.baseUrl = resolveCustomApiBaseUrl(normalized.connection.baseUrl ?? '');
        if (!normalized.connection.model) throw new Error('请先为独立 API 选择或填写模型 ID。');
        if (/[\r\n]/u.test(draftApiKey ?? '')) throw new Error('API Key 不能包含换行，请检查粘贴的内容。');
        if (draftApiKey?.trim()) {
          normalized.customApiKeys = { ...normalized.customApiKeys, [normalized.connection.baseUrl]: draftApiKey.trim() };
        }
      }
      extensionSettings[EXTENSION_SETTINGS_KEY] = normalized;
      try {
        const save = dependencies.saveNativeSettings ?? saveNativeSettings;
        await save(context);
      } catch {
        if (extensionSettings[EXTENSION_SETTINGS_KEY] === normalized) {
          if (previous === undefined) delete extensionSettings[EXTENSION_SETTINGS_KEY];
          else extensionSettings[EXTENSION_SETTINGS_KEY] = previous;
        }
        throw new Error('酒馆没有确认读卡设置已写入；原设置和输入仍保留，请稍后重试。');
      }
    },

    getProfiles() {
      return getSupportedProfiles(getContext());
    },

    hasCustomApiKey(connection) {
      return customClient.hasApiKey(connection);
    },

    getConnectionInfo(connection) {
      return getConnectionInfo(getContext(), connection);
    },

    async listModels(connection, signal, draftApiKey) {
      throwIfAborted(signal);
      const abort = new AbortController();
      const forwardAbort = (): void => abort.abort();
      signal?.addEventListener('abort', forwardAbort, { once: true });
      const timer = setTimeout(() => abort.abort(), MODEL_LIST_TIMEOUT_MS);
      try {
        if (connection.mode === 'custom') return await raceWithAbort(customClient.listModels(connection, abort.signal, draftApiKey), abort.signal);
        const sessions = new WeakMap<AbortSignal, GenerationSession>();
        const context = getContext();
        const session = await getGenerationSession(sessions, context, connection, abort.signal, dependencies, true);
        if (session.mode === 'profile' && session.profile.proxy && session.proxyEndpoint !== '') {
          throw new ReaderHostSafeError('这条独立连接使用反向代理；请手动填写模型 ID，或使用酒馆当前 API 拉取列表。不会借用当前聊天的代理密码。');
        }
        const defaults = session.mode === 'current' ? session.requestDefaults : buildProfileOverride(session.profile, false);
        const payload: Record<string, unknown> = {
          chat_completion_source: session.mode === 'current' ? session.source : session.profile.source,
        };
        for (const key of MODEL_LIST_SETTING_NAMES) {
          if (defaults[key] !== undefined) payload[key] = defaults[key];
        }
        if (payload.chat_completion_source === 'custom' && typeof payload.custom_include_headers === 'string') {
          if (typeof context.substituteParams === 'function') {
            payload.custom_include_headers = context.substituteParams(payload.custom_include_headers);
          } else if (payload.custom_include_headers.includes('{{')) {
            throw new ReaderHostSafeError('酒馆没有提供自定义请求头的宏替换能力；请手动填写模型 ID，没有发送未替换的请求头。');
          }
        }
        const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
        const response = await raceWithAbort(fetcher('/api/backends/chat-completions/status', {
          method: 'POST',
          headers: context.getRequestHeaders?.() ?? {},
          body: JSON.stringify(payload),
          signal: abort.signal,
          cache: 'no-cache',
        }), abort.signal);
        if (!response.ok) throw new ReaderHostSafeError(`拉取模型失败（HTTP ${response.status}）。请检查酒馆连接，也可以手动填写模型 ID。`);
        const data = asRecord(await raceWithAbort(response.json(), abort.signal));
        await getGenerationSession(sessions, getContext(), connection, abort.signal, dependencies, true);
        const models = data && !data.error && Array.isArray(data.data)
          ? [...new Set(data.data.map((item) => asRecord(item)?.id)
            .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
            .map((id) => id.trim()))].sort((left, right) => left.localeCompare(right))
          : [];
        if (!models.length) throw new ReaderHostSafeError('接口没有返回可选模型列表。可以手动填写模型 ID；不会自动换连接或模型。');
        return models;
      } catch (error) {
        if (signal?.aborted) throw createAbortError();
        if (abort.signal.aborted) throw new ReaderHostSafeError('拉取模型超时，请重试或手动填写模型 ID。');
        if (error instanceof ReaderHostSafeError) throw error;
        if (connection.mode === 'custom' && error instanceof Error) throw error;
        throw new ReaderHostSafeError('无法拉取模型列表，请检查酒馆连接或手动填写模型 ID。');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
      }
    },

    describeConnection(connection) {
      const info = getConnectionInfo(getContext(), connection);
      return info.model ? `${info.label}（${info.model}）` : info.label;
    },

    async generate(messages, settings, signal, onText) {
      throwIfAborted(signal);
      validateRawMessages(messages);
      const context = getContext();
      const rawMessages = messages.map((message) => ({ role: message.role, content: message.content }));
      if (settings.connection.mode === 'custom') {
        const generation = buildGenerationOverride(settings, currentSamplingDefaults(context));
        const result = await raceWithAbort(customClient.generate(rawMessages, settings, signal, generation, onText), signal);
        throwIfAborted(signal);
        return extractGeneratedText(result);
      }
      const useSystemPrompt = rawMessages.some((message) => message.role === 'system');
      const session = await getGenerationSession(generationSessions, context, settings.connection, signal, dependencies);
      const generation = buildGenerationOverride(settings, session.mode === 'profile' ? session.samplingDefaults : {});
      throwIfAborted(signal);
      try {
        if (settings.stream) {
          let profilePassword = '';
          if (session.mode === 'profile' && session.proxyEndpoint && session.profile.proxy) {
            profilePassword = await readProfileProxyPassword(session.profile.proxy, session.proxyEndpoint, dependencies);
            if (session.proxyPassword !== undefined && session.proxyPassword !== profilePassword) {
              throw new ReaderHostSafeError('指定连接的代理 Key 在读卡过程中发生变化；已停止，未混用连接。');
            }
            session.proxyPassword = profilePassword;
          }
          const payload = session.mode === 'current' ? { ...session.requestDefaults }
            : { ...buildProfileOverride(session.profile, useSystemPrompt), reverse_proxy: session.proxyEndpoint ?? '', proxy_password: profilePassword };
          if (session.mode === 'profile' && asStringArray(context.extensionSettings?.disabledExtensions).includes('connection-manager')) {
            throw new ReaderHostSafeError('指定连接模式需要启用酒馆 Connection Manager；本次没有改用当前连接。');
          }
          const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
          const response = await raceWithAbort(fetcher('/api/backends/chat-completions/generate', {
            method: 'POST', headers: { ...Object.fromEntries(new Headers(context.getRequestHeaders?.() ?? {})), 'Content-Type': 'application/json' },
            signal, cache: 'no-cache', body: JSON.stringify({
              ...payload, ...generation, stream: true, messages: rawMessages,
              model: session.modelOverride ?? (session.mode === 'current' ? session.model : session.profile.model),
              chat_completion_source: session.mode === 'current' ? session.source : session.profile.source,
              max_tokens: settings.maxOutputTokens, use_sysprompt: useSystemPrompt, custom_prompt_post_processing: '',
            }),
          }), signal);
          if (!response.ok) {
            let details = '';
            try { details = providerErrorMessage(await response.json()); } catch { /* Never echo arbitrary HTML. */ }
            throw new Error(`HTTP ${response.status}${details ? `: ${details}` : ''}`);
          }
          const result = await raceWithAbort(readCompletionResponse(response, signal, onText), signal);
          return extractGeneratedText(result);
        }
        let request: Promise<unknown>;
        if (session.mode === 'profile') {
          const manager = context.ConnectionManagerRequestService;
          const isDisabled = asStringArray(context.extensionSettings?.disabledExtensions)
            .includes('connection-manager');
          if (isDisabled || typeof manager?.sendRequest !== 'function') {
            throw new ReaderHostSafeError('指定连接模式需要启用酒馆 Connection Manager；本次没有改用当前连接。');
          }
          const currentProfile = findChatCompletionProfile(context, session.profileId);
          if (!currentProfile || !sameProfileSnapshot(session.profile, currentProfile)) {
            throw new ReaderHostSafeError('指定连接档案在本次读卡过程中发生变化；为避免混用模型，读卡已停止。');
          }
          request = manager.sendRequest(
            session.profileId,
            rawMessages,
            settings.maxOutputTokens,
            {
              stream: false,
              signal,
              extractData: false,
              includePreset: false,
              includeInstruct: false,
            },
            { ...buildProfileOverride(session.profile, useSystemPrompt), ...generation,
              ...(session.modelOverride ? { model: session.modelOverride } : {}) },
          );
        } else {
          const service = context.ChatCompletionService;
          if (typeof service?.processRequest !== 'function') {
            throw new ReaderHostSafeError('当前酒馆未提供 Chat Completion 原始请求接口；读卡已停止，没有切换到 generateRaw。');
          }
          request = service.processRequest({
            ...session.requestDefaults,
            ...generation,
            stream: false,
            messages: rawMessages,
            model: session.modelOverride ?? session.model,
            chat_completion_source: session.source,
            max_tokens: settings.maxOutputTokens,
            use_sysprompt: useSystemPrompt,
            custom_prompt_post_processing: '',
          }, {}, false, signal);
        }

        const result = await raceWithAbort(request, signal);
        throwIfAborted(signal);
        return extractGeneratedText(result);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw createAbortError();
        if (error instanceof ReaderHostSafeError) throw error;
        const route = session.mode === 'profile' ? '酒馆指定连接' : '酒馆当前连接';
        const key = session.mode === 'current' ? session.requestDefaults.proxy_password : session.proxyPassword;
        const details = typeof key === 'string' && key ? formatProviderError(error).split(key).join('[密钥已隐藏]') : formatProviderError(error);
        throw new Error(`${route}请求失败：${details}；本次没有切换到其他连接。`);
      }
    },

    store,
  };
}

async function loadLinkedWorldbooks(
  context: NativeContext,
  bindings: Array<{ name: string; binding: 'primary' | 'extra' }>,
  warnings: string[],
  signal?: AbortSignal,
): Promise<ReadingMaterial['worldbooks']> {
  const loaded = new Map<string, Record<string, unknown> | null>();
  const result: ReadingMaterial['worldbooks'] = [];

  for (const binding of bindings) {
    throwIfAborted(signal);
    if (!loaded.has(binding.name)) {
      if (typeof context.loadWorldInfo !== 'function') {
        loaded.set(binding.name, null);
      } else {
        try {
          const data = await context.loadWorldInfo(binding.name);
          loaded.set(binding.name, asRecord(data));
        } catch {
          loaded.set(binding.name, null);
        }
      }
    }

    const data = loaded.get(binding.name);
    if (!data) {
      warnings.push(`角色关联世界书「${binding.name}」无法读取；本次内容可能不完整。`);
      continue;
    }
    result.push({ name: binding.name, binding: binding.binding, data });
  }

  return result;
}

function collectWorldbookBindings(
  character: NativeCharacter,
  warnings: string[],
): Array<{ name: string; binding: 'primary' | 'extra' }> {
  const data = asRecord(character.data);
  if (!data) warnings.push('角色卡没有标准 data 字段；已按酒馆返回的完整卡片原样读取。');
  const extensions = asRecord(data?.extensions);
  const primary = extensions?.world;
  const bindings: Array<{ name: string; binding: 'primary' | 'extra' }> = [];
  if (typeof primary === 'string' && primary.trim()) {
    bindings.push({ name: primary, binding: 'primary' });
  }
  return bindings;
}

async function readWorldInfoSettings(
  injected?: ReaderHostDependencies['getWorldInfoSettings'],
): Promise<WorldInfoState> {
  if (injected) return await injected();
  const modulePath = WORLD_INFO_MODULE_URL;
  const module = await import(/* @vite-ignore */ modulePath) as unknown as {
    getWorldInfoSettings?: () => WorldInfoState;
  };
  if (typeof module.getWorldInfoSettings !== 'function') {
    throw new Error('World Info settings API unavailable');
  }
  return module.getWorldInfoSettings();
}

async function saveNativeSettings(context: NativeContext): Promise<void> {
  const eventSource = context.eventSource;
  const eventName = context.eventTypes?.SETTINGS_UPDATED;
  if (!eventSource?.once || !eventSource.removeListener || !eventName) {
    throw new Error('Settings update confirmation unavailable');
  }

  const modulePath = CORE_SCRIPT_MODULE_URL;
  const module = await import(/* @vite-ignore */ modulePath) as unknown as {
    saveSettings?: () => Promise<void>;
  };
  if (typeof module.saveSettings !== 'function') throw new Error('Native settings save unavailable');

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onSaved: (() => void) | undefined;
  const confirmation = new Promise<void>((resolve, reject) => {
    onSaved = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    eventSource.once?.(eventName, onSaved);
    timer = setTimeout(() => {
      if (onSaved) eventSource.removeListener?.(eventName, onSaved);
      reject(new Error('Settings save was not confirmed'));
    }, SETTINGS_SAVE_TIMEOUT_MS);
  });

  try {
    await module.saveSettings();
    await confirmation;
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (onSaved) eventSource.removeListener?.(eventName, onSaved);
    throw error;
  }
}

function getSupportedProfiles(context: NativeContext): ConnectionProfile[] {
  const service = context.ConnectionManagerRequestService;
  if (typeof service?.getSupportedProfiles !== 'function') return [];
  try {
    return service.getSupportedProfiles()
      .filter((profile): profile is NativeConnectionProfile & { id: string; name: string } =>
        typeof profile?.id === 'string'
        && typeof profile.name === 'string'
        && isChatCompletionProfile(context, profile))
      .map((profile) => ({ id: profile.id, name: profile.name }));
  } catch {
    return [];
  }
}

async function getGenerationSession(
  sessions: WeakMap<AbortSignal, GenerationSession>,
  context: NativeContext,
  connection: ReaderConnection,
  signal: AbortSignal,
  dependencies: ReaderHostDependencies,
  allowEmptyModel = false,
): Promise<GenerationSession> {
  const existing = sessions.get(signal);
  const modelOverride = connection.model?.trim() || undefined;
  if (existing) {
    if (existing.mode !== connection.mode
      || (existing.mode === 'profile' && existing.profileId !== connection.profileId)
      || existing.modelOverride !== modelOverride) {
      throw new ReaderHostSafeError('读卡任务中的连接选择发生变化；为避免混用模型，读卡已停止。');
    }
    if (existing.mode === 'current') {
      let current: Extract<GenerationSession, { mode: 'current' }>;
      try {
        current = createCurrentConnectionSession(context, allowEmptyModel || Boolean(modelOverride));
      } catch {
        throw new ReaderHostSafeError('酒馆当前连接在本次读卡过程中发生变化或无法确认；为避免混用连接，读卡已停止。');
      }
      if (!sameCurrentConnectionSnapshot(existing.identity, current.identity)) {
        throw new ReaderHostSafeError('酒馆当前连接在本次读卡过程中发生变化；为避免混用模型或端点，读卡已停止。');
      }
    } else {
      const currentProfile = findChatCompletionProfile(context, existing.profileId);
      if (!currentProfile || !sameProfileSnapshot(existing.profile, currentProfile)) {
        throw new ReaderHostSafeError('指定连接档案在本次读卡过程中发生变化；为避免混用模型，读卡已停止。');
      }
      const proxyName = existing.profile.proxy;
      if (proxyName) {
        const currentEndpoint = await readProfileProxyEndpoint(proxyName, dependencies.getProfileProxyEndpoint);
        if (currentEndpoint === undefined || currentEndpoint !== existing.proxyEndpoint) {
          throw new ReaderHostSafeError('指定连接使用的代理地址在本次读卡过程中发生变化或无法确认；为避免跨端点混用密钥，读卡已停止。');
        }
      }
    }
    return existing;
  }

  let session: GenerationSession;
  if (connection.mode === 'profile') {
    if (!connection.profileId) throw new ReaderHostSafeError('请先在读卡设置中选择一条酒馆 Chat Completion 连接档案。');
    const profile = findChatCompletionProfile(context, connection.profileId);
    if (!profile) {
      throw new ReaderHostSafeError('所选档案不可用或不是 Chat Completion 连接；本次没有切换到当前连接。');
    }
    if (!allowEmptyModel && !profile.model?.trim() && !modelOverride) {
      throw new ReaderHostSafeError('这条独立连接还没有模型；请在读卡设置中选择或手动填写模型 ID。');
    }
    const proxyName = profile.proxy;
    const proxyEndpoint = proxyName
      ? await readProfileProxyEndpoint(proxyName, dependencies.getProfileProxyEndpoint)
      : undefined;
    if (proxyName && proxyEndpoint === undefined) {
      throw new ReaderHostSafeError('无法确认指定连接的代理地址；本次没有向模型发送资料。');
    }
    session = { mode: 'profile', profileId: connection.profileId, profile, proxyEndpoint, modelOverride, samplingDefaults: currentSamplingDefaults(context) };
  } else if (connection.mode === 'current') {
    session = { ...createCurrentConnectionSession(context, allowEmptyModel || Boolean(modelOverride)), modelOverride };
  } else {
    throw new ReaderHostSafeError('读卡连接模式无效；本次没有发送请求。');
  }

  sessions.set(signal, session);
  return session;
}

function createCurrentConnectionSession(context: NativeContext, allowEmptyModel = false): Extract<GenerationSession, { mode: 'current' }> {
  if (context.mainApi !== 'openai') {
    throw new ReaderHostSafeError('读卡首版仅支持酒馆 Chat Completion 当前连接；本次没有改用其他接口。');
  }
  const settings = asRecord(context.chatCompletionSettings);
  const source = typeof settings?.chat_completion_source === 'string'
    ? settings.chat_completion_source.trim()
    : '';
  const model = safeCurrentModel(context);
  if (!settings || !source || (!model && !allowEmptyModel)) {
    throw new ReaderHostSafeError('无法确认酒馆当前 Chat Completion 服务商和模型；本次没有发送请求。');
  }

  const requestDefaults: Record<string, unknown> = {};
  for (const [settingName, requestName] of CURRENT_CHAT_SETTING_MAP) {
    if (settingName === 'proxy_password' && !(typeof settings.reverse_proxy === 'string' && settings.reverse_proxy.trim())) {
      continue;
    }
    if ((settingName === 'reasoning_effort' || settingName === 'verbosity') && settings[settingName] === 'auto') {
      continue;
    }
    const value = cloneRequestValue(settings[settingName]);
    if (value !== undefined) requestDefaults[requestName] = value;
  }

  const connectionSettings: Record<string, unknown> = {};
  for (const settingName of CURRENT_CHAT_CONNECTION_IDENTITY_SETTINGS) {
    const value = cloneRequestValue(settings[settingName]);
    if (value !== undefined) connectionSettings[settingName] = value;
  }
  const identity = {
    mainApi: context.mainApi,
    source,
    model,
    connectionSettings,
  };

  return { mode: 'current', model, source, requestDefaults, identity };
}

function sameCurrentConnectionSnapshot(
  left: NativeCurrentConnectionSnapshot,
  right: NativeCurrentConnectionSnapshot,
): boolean {
  return left.mainApi === right.mainApi
    && left.source === right.source
    && left.model === right.model
    && sameRequestValue(left.connectionSettings, right.connectionSettings);
}

function findChatCompletionProfile(context: NativeContext, profileId: string): NativeProfileSnapshot | null {
  const service = context.ConnectionManagerRequestService;
  if (typeof service?.getSupportedProfiles !== 'function') return null;
  try {
    const profile = service.getSupportedProfiles().find((item) => item.id === profileId);
    if (!profile || !isChatCompletionProfile(context, profile) || typeof profile.api !== 'string') return null;
    const mapping = getProfileApiMapping(context, profile);
    if (!mapping || typeof mapping.source !== 'string' || !mapping.source.trim()) return null;
    return {
      id: profileId,
      api: profile.api,
      model: optionalString(profile.model),
      source: mapping.source,
      apiUrl: optionalString(profile['api-url']),
      secretId: optionalString(profile['secret-id']),
      proxy: optionalString(profile.proxy),
    };
  } catch {
    return null;
  }
}

async function readProfileProxyEndpoint(
  proxyName: string,
  injected?: ReaderHostDependencies['getProfileProxyEndpoint'],
): Promise<string | undefined> {
  try {
    if (injected) {
      const endpoint = await injected(proxyName);
      return typeof endpoint === 'string' ? endpoint : undefined;
    }

    const modulePath = OPENAI_SCRIPT_MODULE_URL;
    const module = await import(/* @vite-ignore */ modulePath) as unknown as { proxies?: unknown };
    if (!Array.isArray(module.proxies)) return undefined;
    const match = module.proxies
      .map(asRecord)
      .find((proxy) => proxy?.name === proxyName);
    return typeof match?.url === 'string' ? match.url : undefined;
  } catch {
    return undefined;
  }
}

async function readProfileProxyPassword(proxyName: string, expectedUrl: string, dependencies: ReaderHostDependencies): Promise<string> {
  if (dependencies.getProfileProxyPassword) return dependencies.getProfileProxyPassword(proxyName);
  // Tests injecting only an endpoint never load real host configuration.
  if (dependencies.getProfileProxyEndpoint) return '';
  const modulePath = OPENAI_SCRIPT_MODULE_URL;
  const module = await import(/* @vite-ignore */ modulePath) as unknown as { proxies?: unknown };
  const proxy = Array.isArray(module.proxies) ? module.proxies.map(asRecord).find((item) => item?.name === proxyName) : null;
  if (proxy?.url !== expectedUrl) throw new ReaderHostSafeError('指定代理地址已变化；没有发送资料。');
  return typeof proxy.password === 'string' ? proxy.password : '';
}

function isChatCompletionProfile(context: NativeContext, profile: NativeConnectionProfile): boolean {
  const mapping = getProfileApiMapping(context, profile);
  return mapping?.selected === 'openai'
    && typeof mapping.source === 'string'
    && Boolean(mapping.source.trim());
}

function getProfileApiMapping(
  context: NativeContext,
  profile: NativeConnectionProfile,
): Record<string, unknown> | null {
  if (typeof profile.api !== 'string') return null;
  return asRecord(context.CONNECT_API_MAP?.[profile.api]);
}

function sameProfileSnapshot(left: NativeProfileSnapshot, right: NativeProfileSnapshot): boolean {
  return left.id === right.id
    && left.api === right.api
    && left.model === right.model
    && left.source === right.source
    && left.apiUrl === right.apiUrl
    && left.secretId === right.secretId
    && left.proxy === right.proxy;
}

function buildProfileOverride(profile: NativeProfileSnapshot, useSystemPrompt: boolean): Record<string, unknown> {
  const override: Record<string, unknown> = {
    chat_completion_source: profile.source,
    use_sysprompt: useSystemPrompt,
    custom_prompt_post_processing: '',
  };
  if (profile.model !== undefined) override.model = profile.model;
  override.secret_id = profile.secretId?.trim() ? profile.secretId : PROFILE_WITHOUT_SECRET_ID;
  if (profile.apiUrl !== undefined) {
    override.custom_url = profile.apiUrl;
    override.vertexai_region = profile.apiUrl;
    override.zai_endpoint = profile.apiUrl;
    override.siliconflow_endpoint = profile.apiUrl;
    override.minimax_endpoint = profile.apiUrl;
    override.pollinations_endpoint = profile.apiUrl;
  }
  return override;
}

function getConnectionInfo(context: NativeContext, connection: ReaderConnection) {
  if (connection.mode === 'custom') {
    return { label: '独立 API', source: 'OpenAI 兼容接口', model: connection.model?.trim() || '' };
  }
  if (connection.mode === 'profile') {
    const profile = findChatCompletionProfile(context, connection.profileId);
    const label = getSupportedProfiles(context).find((item) => item.id === connection.profileId)?.name ?? '酒馆指定连接';
    return { label, source: profile?.source ?? '', model: connection.model?.trim() || profile?.model || '' };
  }
  return {
    label: '酒馆当前连接',
    source: optionalString(context.chatCompletionSettings?.chat_completion_source) ?? '',
    model: connection.model?.trim() || safeCurrentModel(context),
  };
}

function currentSamplingDefaults(context: NativeContext): Record<string, unknown> {
  const native = context.chatCompletionSettings ?? {};
  const generation = normalizeReaderSettings({ generation: {
    temperature: native.temp_openai,
    topP: native.top_p_openai,
    frequencyPenalty: native.freq_pen_openai,
    presencePenalty: native.pres_pen_openai,
  } }).generation;
  return {
    temperature: generation.temperature, top_p: generation.topP,
    frequency_penalty: generation.frequencyPenalty, presence_penalty: generation.presencePenalty,
  };
}

function buildGenerationOverride(settings: ReaderSettings, inherited: Record<string, unknown>): Record<string, unknown> {
  const generation = normalizeReaderSettings(settings).generation;
  return generation.inherit ? inherited : {
    temperature: generation.temperature,
    top_p: generation.topP,
    frequency_penalty: generation.frequencyPenalty,
    presence_penalty: generation.presencePenalty,
  };
}

function cloneRequestValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneRequestValue).filter((item) => item !== undefined);
  }
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(Object.entries(record)
      .map(([key, entry]) => [key, cloneRequestValue(entry)] as const)
      .filter(([, entry]) => entry !== undefined));
  }
  return undefined;
}

function sameRequestValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameRequestValue(value, right[index]));
  }

  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameRequestValue(leftRecord[key], rightRecord[key]));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function validateRawMessages(messages: ReaderMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('读卡请求没有可发送的消息。');
  }
  let systemCount = 0;
  for (const message of messages) {
    if (!message || (message.role !== 'system' && message.role !== 'user') || typeof message.content !== 'string') {
      throw new Error('读卡请求只能包含明确的 system/user 原始消息；没有发送聊天记录。');
    }
    if (message.role === 'system') systemCount += 1;
  }
  if (systemCount > 1) throw new Error('读卡请求中出现多个 system 消息；没有发送请求。');
}

function extractGeneratedText(value: unknown): string {
  const result = asRecord(value);
  if (!result) throw new ReaderHostSafeError('酒馆接口没有返回可验证的 Chat Completion 结果。');

  const embeddedError = asRecord(result.error);
  if (embeddedError) {
    const message = typeof embeddedError.message === 'string' ? embeddedError.message : '模型接口返回错误。';
    throw new ReaderHostSafeError(`模型接口返回错误：${sanitizeProviderText(message) || '原因已隐藏'}`);
  }

  const choices = Array.isArray(result.choices) ? result.choices : [];
  const choice = asRecord(choices[0]);
  const candidateList = Array.isArray(result.candidates) ? result.candidates : [];
  const candidate = asRecord(candidateList[0]);
  const stopReason = firstString(
    choice?.finish_reason,
    choice?.finishReason,
    choice?.stop_reason,
    result.finish_reason,
    result.finishReason,
    result.stop_reason,
    result.stopReason,
    candidate?.finishReason,
    candidate?.finish_reason,
    candidate?.stopReason,
    candidate?.stop_reason,
  );
  if (!stopReason) {
    throw new ReaderHostSafeError('模型接口没有返回可确认的结束原因；为避免把可能截断的回答当成完整解读，本次结果未采用。');
  }
  validateCompletionStopReason(stopReason);

  const message = asRecord(choice?.message);
  const refusal = typeof message?.refusal === 'string' && message.refusal.trim()
    ? message.refusal
    : undefined;
  const candidateContent = asRecord(candidate?.content);
  const content = refusal
    ?? extractTextContent(message?.content)
    ?? extractTextContent(choice?.text)
    ?? extractTextContent(result.content)
    ?? extractTextContent(candidateContent?.parts);
  if (!content?.trim()) {
    if (isProviderRefusalStopReason(stopReason)) {
      throw new ReaderHostSafeError(`模型接口以「${sanitizeProviderText(stopReason)}」结束，没有返回正文。`);
    }
    throw new ReaderHostSafeError('模型已正常结束，但没有返回可读取的文本。');
  }
  return content;
}

function validateCompletionStopReason(reason: string): void {
  const normalized = reason.trim().toLocaleLowerCase().replace(/[\s-]+/gu, '_');
  if (['length', 'max_tokens', 'max_tokens_exceeded', 'max_output_tokens', 'max_output_tokens_exceeded', 'token_limit', 'max_tokens_reached'].includes(normalized)) {
    throw new ReaderHostSafeError(`模型回复因「${sanitizeProviderText(reason)}」达到输出上限；请提高读卡最大输出长度后重试。`);
  }
  if (['stop', 'end_turn', 'stop_sequence', 'completed', 'complete', 'finished', 'eos', 'end'].includes(normalized)
    || isProviderRefusalStopReason(normalized)) return;
  throw new ReaderHostSafeError(`模型接口以「${sanitizeProviderText(reason) || '未知原因'}」结束；未确认解读完整，因此没有采用这段结果。`);
}

function isProviderRefusalStopReason(reason: string): boolean {
  const normalized = reason.trim().toLocaleLowerCase().replace(/[\s-]+/gu, '_');
  return ['content_filter', 'refusal', 'safety', 'recitation', 'blocklist', 'prohibited_content', 'spii'].includes(normalized);
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.map((item) => {
    if (typeof item === 'string') return item;
    const record = asRecord(item);
    return record && (record.type === 'text' || record.type === undefined) && typeof record.text === 'string'
      ? record.text
      : '';
  }).join('');
  return text || undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

function formatProviderError(error: unknown): string {
  const status = findHttpStatus(error);
  let message = unwrapErrorMessage(error);
  if (status && !new RegExp(`\\b${status}\\b`, 'u').test(message)) message = `HTTP ${status}: ${message}`;
  return sanitizeProviderText(message) || '酒馆没有提供可安全显示的错误原因。';
}

function unwrapErrorMessage(error: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const nested = cause === undefined ? '' : unwrapErrorMessage(cause, depth + 1);
    if (nested.trim()) return nested;
    return error.message;
  }
  return typeof error === 'string' ? error : '';
}

function findHttpStatus(error: unknown, depth = 0): number | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(error);
  const candidate = record?.status ?? record?.statusCode;
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
    return candidate;
  }
  const messageStatus = typeof record?.message === 'string'
    ? record.message.match(/\b(?:HTTP\s*)?([45]\d{2})\b/iu)?.[1]
    : undefined;
  if (messageStatus) return Number(messageStatus);
  return record?.cause === undefined ? undefined : findHttpStatus(record.cause, depth + 1);
}

function sanitizeProviderText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[地址已隐藏]')
    .replace(/\bBearer\s+[^\s,;)}\]]+/giu, 'Bearer [密钥已隐藏]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/giu, '[密钥已隐藏]')
    .replace(/\b(api[_-]?key|key|access[_-]?token|token|client[_-]?secret|secret(?:[_-]?id)?|password|authorization|credential)(\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/giu, '$1$2[已隐藏]')
    .replace(/[\r\n\t ]+/gu, ' ')
    .trim()
    .slice(0, 400);
}

function safeCurrentModel(context: NativeContext): string {
  try {
    const model = context.getChatCompletionModel?.();
    return typeof model === 'string' ? model.trim() : '';
  } catch {
    return '';
  }
}

async function raceWithAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([request, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('读卡请求已取消。');
  error.name = 'AbortError';
  return error;
}

function isAbortError(value: unknown): boolean {
  return asRecord(value)?.name === 'AbortError';
}

function getGlobalContext(): NativeContext {
  const global = globalThis as typeof globalThis & {
    SillyTavern?: { getContext?: () => NativeContext };
  };
  const context = global.SillyTavern?.getContext?.();
  if (!context) throw new Error('没有连接到 SillyTavern；请从酒馆角色卡面板打开读卡器。');
  return context;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

class ReaderHostSafeError extends Error {}
