import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { defaultReaderSettings } from '../extensions/jiuguan-reader/src/settings.js';
import { ReaderView } from '../extensions/jiuguan-reader/src/ui.js';
import type { ExtensionUpdater, ExtensionUpdateState } from '../extensions/jiuguan-reader/src/updater.js';
import type { ReaderConnection, ReaderHost, ReaderSettings } from '../extensions/jiuguan-reader/src/types.js';

type UpdatePhase = ExtensionUpdateState['phase'];
type SetUpdateState = (phase: UpdatePhase, message?: string) => void;
type ControllerState = { loading: boolean; busy: boolean; unsaved: boolean };
type UiSpies = { showModalCalls: number; confirmCalls: number; reloadCalls: number };

interface ReaderViewHarness {
  controller: { getState: () => ControllerState };
  updater: ExtensionUpdater;
  settingsDirty: boolean;
  questionInput: { value: string };
  questionDrafts: Map<string, string>;
  updateRequestPending: boolean;
  updateControlRenderers: Set<() => void>;
  createUpdateControls(): HTMLElement;
  requestExtensionUpdate(feedback: HTMLElement): Promise<void>;
  reloadAfterUpdate(feedback: HTMLElement): void;
}

interface ReaderSettingsViewHarness extends ReaderViewHarness {
  host: ReaderHost;
  settingsEditVersion: number;
  form: FakeElement;
  settingsPanel: FakeElement;
  systemInput: FakeElement;
  analysisInput: FakeElement;
  connectionMode: FakeElement;
  profileInput: FakeElement;
  customConnectionFields: FakeElement;
  apiUrlInput: FakeElement;
  apiKeyInput: FakeElement;
  noApiKeyInput: FakeElement;
  apiKeyNote: FakeElement;
  apiKeyToggle: FakeElement;
  modelSelect: FakeElement;
  modelInput: FakeElement;
  modelSummary: FakeElement;
  modelsStatus: FakeElement;
  fetchModelsButton: FakeElement;
  inheritGenerationInput: FakeElement;
  streamInput: FakeElement;
  temperatureInput: FakeElement;
  topPInput: FakeElement;
  frequencyInput: FakeElement;
  presenceInput: FakeElement;
  generationFields: FakeElement;
  contextInput: FakeElement;
  outputInput: FakeElement;
  shortcutsInput: FakeElement;
  settingsStatus: FakeElement;
  availableModels: string[];
  modelRequest: AbortController | null;
  openSettings(): void;
  fillSettings(settings: ReaderSettings): void;
  fetchModels(): Promise<void>;
  connectionChanged(): void;
  refreshModelSummary(): void;
  modelSelectionChanged(): void;
  modelInputChanged(): void;
  updateGenerationVisibility(): void;
  syncApiKey(force?: boolean, settings?: ReaderSettings): void;
  markSettingsDirty(message?: string): void;
  saveSettings(save: FakeElement): Promise<void>;
  hasUnsavedInput(): boolean;
  render(state: ControllerState): void;
}

interface FakeUpdater extends ExtensionUpdater {
  setState: SetUpdateState;
  updateCalls(): number;
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();
  parentElement: FakeElement | null = null;
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  title = '';
  type = '';
  value = '';
  id = '';
  htmlFor = '';
  min = '';
  max = '';
  step = '';
  required = false;
  checked = false;
  open = false;
  rows = 0;
  autocomplete = '';
  dataset: Record<string, string> = {};

  constructor(readonly tagName: string, private readonly spies: UiSpies) {}

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.parentElement = this;
        this.children.push(node);
      }
      else if (typeof node === 'string') this.textContent += node;
    }
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children.length = 0;
    this.textContent = '';
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === 'function'
      ? listener as (event: Event) => void
      : (event: Event) => listener.handleEvent(event);
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  click(): void {
    this.dispatch('click');
  }

  dispatch(type: string): void {
    const event = { type, target: this, preventDefault() {} } as unknown as Event;
    for (let current: FakeElement | null = this; current; current = current.parentElement) {
      for (const listener of current.listeners.get(type) ?? []) listener(event);
    }
  }

  closest(selector: string): FakeElement | null {
    for (let current: FakeElement | null = this; current; current = current.parentElement) {
      if (selector === 'label' && current.tagName === 'label') return current;
    }
    return null;
  }

  checkValidity(): boolean {
    if (this.disabled) return true;
    const value = this.value.trim();
    if (this.required && !value) return false;
    if (this.type !== 'number' || !value) return true;
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    if (this.min && number < Number(this.min)) return false;
    if (this.max && number > Number(this.max)) return false;
    if (this.step && this.step !== 'any') {
      const step = Number(this.step);
      const base = this.min ? Number(this.min) : 0;
      if (step > 0 && Math.abs((number - base) / step - Math.round((number - base) / step)) > 1e-8) return false;
    }
    return true;
  }

  showModal(): void {
    this.open = true;
    this.spies.showModalCalls += 1;
  }
}

function createFakeUpdater(
  initialPhase: UpdatePhase = 'idle',
  onUpdate: (setState: SetUpdateState) => Promise<void> = async () => {},
): FakeUpdater {
  let state: ExtensionUpdateState = { phase: initialPhase, message: '' };
  let calls = 0;
  const listeners = new Set<(next: ExtensionUpdateState) => void>();
  const setState: SetUpdateState = (phase, message = '') => {
    state = { phase, message };
    listeners.forEach((listener) => listener(state));
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    async update() {
      calls += 1;
      await onUpdate(setState);
    },
    setState,
    updateCalls: () => calls,
  };
}

function createView(options: {
  updater: ExtensionUpdater;
  settingsDirty?: boolean;
  questionText?: string;
  questionDrafts?: Iterable<[string, string]>;
  controllerState?: Partial<ControllerState>;
}): ReaderViewHarness {
  const state: ControllerState = {
    loading: false,
    busy: false,
    unsaved: false,
    ...options.controllerState,
  };
  const view = Object.create(ReaderView.prototype) as ReaderViewHarness;
  Object.assign(view, {
    controller: { getState: () => state },
    updater: options.updater,
    settingsDirty: options.settingsDirty ?? false,
    questionInput: { value: options.questionText ?? '' },
    questionDrafts: new Map(options.questionDrafts ?? []),
    updateRequestPending: false,
    updateControlRenderers: new Set<() => void>(),
  });
  return view;
}

function findNode(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return undefined;
}

function findButton(root: FakeElement, text: string): FakeElement | undefined {
  return findNode(root, (node) => node.tagName === 'button' && node.textContent === text);
}

function fakeFeedback(spies: UiSpies): FakeElement {
  return new FakeElement('p', spies);
}

async function withFakeBrowser<T>(spies: UiSpies, callback: () => T | Promise<T>): Promise<T> {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const confirmDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  const fakeDocument = {
    createElement: (tagName: string) => new FakeElement(tagName, spies),
  };
  const fakeWindow = {
    confirm: () => {
      spies.confirmCalls += 1;
      throw new Error('Unexpected confirmation dialog in UI regression test');
    },
    location: {
      reload: () => { spies.reloadCalls += 1; },
    },
  };
  const confirm = () => {
    spies.confirmCalls += 1;
    throw new Error('Unexpected confirmation dialog in UI regression test');
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDocument });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'confirm', { configurable: true, writable: true, value: confirm });

  const restore = (key: string, descriptor: PropertyDescriptor | undefined): void => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  };
  try {
    return await callback();
  } finally {
    restore('document', documentDescriptor);
    restore('window', windowDescriptor);
    restore('confirm', confirmDescriptor);
  }
}

function emptySpies(): UiSpies {
  return { showModalCalls: 0, confirmCalls: 0, reloadCalls: 0 };
}

interface FakeReaderSettingsHost {
  host: ReaderHost;
  getSavedSettings(): ReaderSettings;
  getSaveCalls(): number;
}

function createFakeReaderSettingsHost(
  initialSettings = defaultReaderSettings(),
  options: {
    profiles?: Array<{ id: string; name: string }>;
    listModels?: (connection: ReaderConnection, signal?: AbortSignal, draftApiKey?: string) => Promise<string[]>;
    beforeSave?: (settings: ReaderSettings, draftApiKey?: string) => Promise<void>;
  } = {},
): FakeReaderSettingsHost {
  let settings = initialSettings;
  let saveCalls = 0;
  const profiles = options.profiles ?? [
    { id: 'profile-a', name: '虚构连接 A' },
    { id: 'profile-b', name: '虚构连接 B' },
  ];
  const host = {
    getSettings: () => settings,
    async saveSettings(next: ReaderSettings, draftApiKey?: string) {
      saveCalls += 1;
      await options.beforeSave?.(next, draftApiKey);
      settings = { ...next, customApiKeys: { ...settings.customApiKeys } };
      if (next.connection.mode === 'custom' && draftApiKey?.trim()) {
        settings.customApiKeys![next.connection.baseUrl!] = draftApiKey.trim();
      }
    },
    getProfiles: () => profiles,
    getConnectionInfo(connection: ReaderConnection) {
      const profile = profiles.find((item) => item.id === connection.profileId);
      const label = connection.mode === 'profile' ? profile?.name ?? '独立连接' : '当前酒馆 API';
      const baseModel = connection.mode === 'profile' ? 'profile-model' : 'chat-model';
      return { label, source: connection.mode === 'profile' ? '虚构独立连接' : '虚构当前连接', model: connection.model ?? baseModel };
    },
    listModels: options.listModels ?? (async () => ['model-one', 'model-two']),
  } as unknown as ReaderHost;
  return {
    host,
    getSavedSettings: () => settings,
    getSaveCalls: () => saveCalls,
  };
}

function createReaderSettingsView(
  spies: UiSpies,
  settingsHost = createFakeReaderSettingsHost(),
): { view: ReaderSettingsViewHarness; form: FakeElement } {
  const view = Object.create(ReaderView.prototype) as ReaderSettingsViewHarness;
  const controllerState: ControllerState = { loading: false, busy: false, unsaved: false };
  const form = new FakeElement('form', spies);
  const addField = (control: FakeElement): FakeElement => {
    const label = new FakeElement('label', spies);
    label.append(new FakeElement('span', spies), control);
    form.append(label);
    return label;
  };
  const systemInput = new FakeElement('textarea', spies);
  const analysisInput = new FakeElement('textarea', spies);
  const connectionMode = new FakeElement('select', spies);
  const profileInput = new FakeElement('select', spies);
  const customConnectionFields = new FakeElement('div', spies);
  const apiUrlInput = new FakeElement('input', spies);
  const apiKeyInput = new FakeElement('input', spies);
  const noApiKeyInput = new FakeElement('input', spies);
  const apiKeyNote = new FakeElement('p', spies);
  const apiKeyToggle = new FakeElement('button', spies);
  const modelSelect = new FakeElement('select', spies);
  const modelInput = new FakeElement('input', spies);
  const modelSummary = new FakeElement('div', spies);
  const modelsStatus = new FakeElement('p', spies);
  const fetchModelsButton = new FakeElement('button', spies);
  const inheritGenerationInput = new FakeElement('input', spies);
  const temperatureInput = new FakeElement('input', spies);
  const topPInput = new FakeElement('input', spies);
  const frequencyInput = new FakeElement('input', spies);
  const presenceInput = new FakeElement('input', spies);
  const generationFields = new FakeElement('div', spies);
  const contextInput = new FakeElement('input', spies);
  const outputInput = new FakeElement('input', spies);
  const shortcutsInput = new FakeElement('textarea', spies);
  const settingsStatus = new FakeElement('div', spies);
  modelInput.type = 'text';
  inheritGenerationInput.type = 'checkbox';
  for (const [input, min, max] of [
    [temperatureInput, '0', '2'],
    [topPInput, '0', '1'],
    [frequencyInput, '-2', '2'],
    [presenceInput, '-2', '2'],
  ] as const) {
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.step = 'any';
    input.required = true;
  }
  contextInput.type = 'number';
  contextInput.min = '1';
  contextInput.step = '1';
  contextInput.required = true;
  outputInput.type = 'number';
  outputInput.min = '1';
  outputInput.step = '1';
  outputInput.required = true;
  Object.assign(view, {
    controller: { getState: () => controllerState },
    updater: createFakeUpdater(),
    host: settingsHost.host,
    settingsDirty: false,
    settingsEditVersion: 0,
    questionInput: new FakeElement('textarea', spies),
    questionDrafts: new Map<string, string>(),
    updateRequestPending: false,
    updateControlRenderers: new Set<() => void>(),
    settingsPanel: new FakeElement('dialog', spies),
    form,
    systemInput,
    analysisInput,
    connectionMode,
    profileInput,
    customConnectionFields,
    apiUrlInput,
    apiKeyInput,
    noApiKeyInput,
    apiKeyNote,
    apiKeyToggle,
    modelSelect,
    modelInput,
    modelSummary,
    modelsStatus,
    fetchModelsButton,
    inheritGenerationInput,
    streamInput: new FakeElement('input', spies),
    temperatureInput,
    topPInput,
    frequencyInput,
    presenceInput,
    generationFields,
    contextInput,
    outputInput,
    shortcutsInput,
    settingsStatus,
    availableModels: [],
    modelRequest: null,
    render: () => {},
  });

  addField(systemInput);
  addField(analysisInput);
  addField(connectionMode);
  addField(profileInput);
  form.append(modelSummary);
  addField(modelSelect);
  addField(modelInput);
  form.append(modelsStatus);
  addField(inheritGenerationInput);
  for (const input of [temperatureInput, topPInput, frequencyInput, presenceInput]) addField(input);
  form.append(generationFields);
  addField(contextInput);
  addField(outputInput);
  addField(shortcutsInput);
  form.append(settingsStatus);

  connectionMode.addEventListener('change', () => view.connectionChanged());
  apiUrlInput.addEventListener('input', () => view.syncApiKey());
  profileInput.addEventListener('change', () => view.connectionChanged());
  modelSelect.addEventListener('change', () => view.modelSelectionChanged());
  modelInput.addEventListener('input', () => view.modelInputChanged());
  inheritGenerationInput.addEventListener('change', () => view.updateGenerationVisibility());
  form.addEventListener('input', () => view.markSettingsDirty());
  form.addEventListener('change', () => view.markSettingsDirty());
  view.fillSettings(settingsHost.host.getSettings());
  return { view, form };
}

const extensionIndexSource = readFileSync(new URL('../extensions/jiuguan-reader/src/index.ts', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('../extensions/jiuguan-reader/src/ui.ts', import.meta.url), 'utf8');

test('独立API有直接填写地址Key和模型的入口，旧连接档案保留为不同选项', async () => {
  assert.match(viewSource, /option\('custom', '独立 API：自己填写'\)/u);
  assert.match(viewSource, /option\('profile', '酒馆已保存的连接配置'\)/u);
  assert.match(viewSource, /jgr-api-url/u);
  assert.match(viewSource, /jgr-api-key/u);
  assert.match(viewSource, /Key 和模型保存到当前酒馆用户/u);
  const spies = emptySpies();
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies);
    assert.equal(view.customConnectionFields.hidden, true);
    view.connectionMode.value = 'custom';
    view.connectionMode.dispatch('change');
    assert.equal(view.customConnectionFields.hidden, false);
    assert.equal(view.profileInput.closest('label')!.hidden, true);
    assert.equal(view.modelInput.closest('label')!.hidden, false, '独立模式不必另选手动模式才出现模型输入');
  });
});

test('流式开关和明确无密钥选项能保存恢复，界面说明部分结果未完成未保存', async () => {
  assert.match(viewSource, /流式生成（边生成边显示）/u);
  assert.match(viewSource, /未完成预览，尚未保存/u);
  assert.match(viewSource, /打开 API 设置补填/u);
  const spies = emptySpies();
  const settingsHost = createFakeReaderSettingsHost();
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    assert.equal(view.streamInput.checked, true);
    view.streamInput.checked = false;
    view.connectionMode.value = 'custom';
    view.connectionMode.dispatch('change');
    view.noApiKeyInput.checked = true;
    view.apiUrlInput.value = 'https://no-key.example.test/v1';
    view.modelInput.value = 'fake-public-model';
    await view.saveSettings(new FakeElement('button', spies));
    assert.equal(settingsHost.getSavedSettings().stream, false);
    assert.equal(settingsHost.getSavedSettings().connection.noApiKey, true);
    view.openSettings();
    assert.equal(view.streamInput.checked, false);
    assert.equal(view.noApiKeyInput.checked, true);
    assert.equal(view.apiKeyInput.disabled, true);
  });
});

test('独立拉取用未保存表单地址和Key，不要求模型，不保存也不清空草稿', async () => {
  const spies = emptySpies();
  let sentConnection: ReaderConnection | undefined;
  let sentKey: string | undefined;
  const settingsHost = createFakeReaderSettingsHost(defaultReaderSettings(), {
    listModels(connection, _signal, draftApiKey) { sentConnection = connection; sentKey = draftApiKey; return Promise.resolve(['independent-model']); },
  });
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    view.connectionMode.value = 'custom';
    view.connectionMode.dispatch('change');
    view.apiUrlInput.value = 'https://fictional.example.test/v3';
    view.apiKeyInput.value = 'fictional-draft-key';
    view.systemInput.value = '未保存的提示词';
    await view.fetchModels();
    assert.deepEqual(sentConnection, { mode: 'custom', profileId: '', baseUrl: 'https://fictional.example.test/v3' });
    assert.equal(sentKey, 'fictional-draft-key');
    assert.equal(settingsHost.getSaveCalls(), 0);
    assert.equal(view.apiKeyInput.value, 'fictional-draft-key');
    assert.equal(view.systemInput.value, '未保存的提示词');
    assert.equal(view.modelSelect.value, 'manual', '不自动选第一个模型');
    view.modelSelect.value = 'model:independent-model';
    view.modelSelect.dispatch('change');
    assert.equal(view.modelInput.value, 'independent-model');
  });
});

test('独立API手填模型和Key可保存，成功后重开恢复Key，保存失败保留输入', async () => {
  const spies = emptySpies();
  let sentKey: string | undefined;
  let fail = true;
  const settingsHost = createFakeReaderSettingsHost(defaultReaderSettings(), {
    async beforeSave(_settings, key) { sentKey = key; if (fail) throw new Error('虚构保存失败'); },
  });
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    view.connectionMode.value = 'custom';
    view.connectionMode.dispatch('change');
    view.apiUrlInput.value = 'https://fictional.example.test/v1';
    view.apiKeyInput.value = 'fictional-independent-key';
    view.modelInput.value = 'a-long-provider/full-model-id';
    view.modelInput.dispatch('input');
    await view.saveSettings(new FakeElement('button', spies));
    assert.equal(view.apiKeyInput.value, 'fictional-independent-key');
    assert.equal(view.settingsDirty, true);
    fail = false;
    await view.saveSettings(new FakeElement('button', spies));
    assert.equal(sentKey, 'fictional-independent-key');
    assert.deepEqual(settingsHost.getSavedSettings().connection, { mode: 'custom', profileId: '', baseUrl: 'https://fictional.example.test/v1', model: 'a-long-provider/full-model-id' });
    assert.equal(settingsHost.getSavedSettings().customApiKeys?.['https://fictional.example.test/v1'], 'fictional-independent-key');
    assert.equal(view.apiKeyInput.value, 'fictional-independent-key');
    assert.equal(view.settingsDirty, false);
    view.openSettings();
    assert.equal(view.apiUrlInput.value, 'https://fictional.example.test/v1');
    assert.equal(view.modelInput.value, 'a-long-provider/full-model-id');
    assert.equal(view.apiKeyInput.value, 'fictional-independent-key');
    const anotherView = createReaderSettingsView(spies, settingsHost).view;
    assert.equal(anotherView.apiKeyInput.value, 'fictional-independent-key');
  });
});

test('更换API地址清除原地址Key，切回时恢复对应Key，同地址输入不覆盖草稿', async () => {
  const spies = emptySpies();
  const settingsHost = createFakeReaderSettingsHost({ ...defaultReaderSettings(),
    connection: { mode: 'custom', profileId: '', baseUrl: 'https://first.example.test/v1', model: 'fake-model' },
    customApiKeys: { 'https://first.example.test/v1': 'fictional-first', 'https://second.example.test/v1': 'fictional-second' },
  });
  await withFakeBrowser(spies, () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    assert.equal(view.apiKeyInput.value, 'fictional-first');
    view.apiUrlInput.value = 'https://new.example.test/v1';
    view.apiUrlInput.dispatch('input');
    assert.equal(view.apiKeyInput.value, '');
    view.apiUrlInput.value = 'https://second.example.test/v1';
    view.apiUrlInput.dispatch('input');
    assert.equal(view.apiKeyInput.value, 'fictional-second');
    view.apiKeyInput.value = 'fictional-draft';
    view.apiUrlInput.value += '/chat/completions';
    view.apiUrlInput.dispatch('input');
    assert.equal(view.apiKeyInput.value, 'fictional-draft');
    view.apiUrlInput.value = 'https://first.example.test/v1';
    view.apiUrlInput.dispatch('input');
    assert.equal(view.apiKeyInput.value, 'fictional-first');
    assert.equal(settingsHost.getSaveCalls(), 0);
  });
});

test('模型列表不自动选首项，保存后重开恢复所选模型和生成参数', async () => {
  const spies = emptySpies();
  const settingsHost = createFakeReaderSettingsHost();
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);

    await view.fetchModels();
    assert.equal(view.modelSelect.value, '', '拉取列表后仍跟随连接模型，不应自动挑第一项');
    assert.deepEqual(view.availableModels, ['model-one', 'model-two']);

    view.modelSelect.value = 'model:model-two';
    view.modelSelect.dispatch('change');
    view.inheritGenerationInput.checked = false;
    view.inheritGenerationInput.dispatch('change');
    view.temperatureInput.value = '0.31';
    view.temperatureInput.dispatch('input');
    view.topPInput.value = '0.82';
    view.topPInput.dispatch('input');
    view.frequencyInput.value = '-0.25';
    view.frequencyInput.dispatch('input');
    view.presenceInput.value = '0.4';
    view.presenceInput.dispatch('input');
    await view.saveSettings(new FakeElement('button', spies));

    const saved = settingsHost.getSavedSettings();
    assert.equal(saved.connection.model, 'model-two');
    assert.deepEqual(saved.generation, {
      inherit: false,
      temperature: 0.31,
      topP: 0.82,
      frequencyPenalty: -0.25,
      presencePenalty: 0.4,
    });
    assert.equal(view.settingsDirty, false);

    view.settingsPanel.open = false;
    view.openSettings();
    assert.equal(view.modelSelect.value, 'model:model-two', '重新打开后仍应恢复保存的模型选择');
    assert.equal(view.temperatureInput.value, '0.31');
    assert.equal(view.topPInput.value, '0.82');
    assert.equal(view.frequencyInput.value, '-0.25');
    assert.equal(view.presenceInput.value, '0.4');
    assert.equal(view.inheritGenerationInput.checked, false);
  });
});

test('切换连接会取消旧模型请求，晚到结果不会覆盖新连接的列表', async () => {
  const spies = emptySpies();
  let resolveOld!: (models: string[]) => void;
  let oldSignal: AbortSignal | undefined;
  const settingsHost = createFakeReaderSettingsHost(defaultReaderSettings(), {
    listModels(connection, signal) {
      if (connection.mode === 'current') {
        oldSignal = signal;
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve(['profile-b-model']);
    },
  });
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    const oldRequest = view.fetchModels();
    assert.ok(oldSignal);

    view.connectionMode.value = 'profile';
    view.connectionMode.dispatch('change');
    view.profileInput.value = 'profile-b';
    view.profileInput.dispatch('change');
    assert.equal(oldSignal.aborted, true, '更换连接时应取消旧请求');

    await view.fetchModels();
    assert.deepEqual(view.availableModels, ['profile-b-model']);
    resolveOld(['stale-current-model']);
    await oldRequest;

    assert.deepEqual(view.availableModels, ['profile-b-model']);
    assert.ok(!view.modelSelect.children.some((option) => option.value === 'model:stale-current-model'));
    assert.match(view.modelsStatus.textContent, /已获取 1 个模型/u);
  });
});

test('重新打开设置时取消待处理模型请求并清除旧列表状态', async () => {
  const spies = emptySpies();
  let resolveModels!: (models: string[]) => void;
  let signal: AbortSignal | undefined;
  const settingsHost = createFakeReaderSettingsHost(defaultReaderSettings(), {
    listModels(_connection, nextSignal) {
      signal = nextSignal;
      return new Promise((resolve) => { resolveModels = resolve; });
    },
  });
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    const pending = view.fetchModels();
    assert.ok(signal);
    view.modelsStatus.textContent = '旧连接已获取 9 个模型';
    view.modelsStatus.hidden = false;

    view.openSettings();
    assert.equal(signal.aborted, true);
    assert.equal(view.modelsStatus.hidden, true);
    assert.equal(view.modelsStatus.textContent, '');
    assert.deepEqual(view.availableModels, []);

    resolveModels(['late-model']);
    await pending;
    assert.equal(view.modelsStatus.hidden, true);
    assert.equal(view.modelsStatus.textContent, '');
    assert.deepEqual(view.availableModels, []);
  });
});

test('继承参数时空字段回退到原保存值，同时保留有效的新数值', async () => {
  const spies = emptySpies();
  const initial = defaultReaderSettings();
  initial.generation = { inherit: true, temperature: 0.8, topP: 0.6, frequencyPenalty: 0.25, presencePenalty: -0.25 };
  const settingsHost = createFakeReaderSettingsHost(initial);
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    view.inheritGenerationInput.checked = false;
    view.inheritGenerationInput.dispatch('change');
    view.temperatureInput.value = '0.42';
    view.temperatureInput.dispatch('input');
    view.topPInput.value = '';
    view.topPInput.dispatch('input');
    view.frequencyInput.value = '';
    view.frequencyInput.dispatch('input');
    view.presenceInput.value = '';
    view.presenceInput.dispatch('input');
    view.inheritGenerationInput.checked = true;
    view.inheritGenerationInput.dispatch('change');

    await view.saveSettings(new FakeElement('button', spies));
    assert.deepEqual(settingsHost.getSavedSettings().generation, {
      inherit: true,
      temperature: 0.42,
      topP: 0.6,
      frequencyPenalty: 0.25,
      presencePenalty: -0.25,
    });
    assert.deepEqual([
      view.temperatureInput.value,
      view.topPInput.value,
      view.frequencyInput.value,
      view.presenceInput.value,
    ], ['0.42', '0.6', '0.25', '-0.25'], '保存后隐藏参数字段也应显示实际保留值');
  });
});

test('空手填模型和越界生成参数都拒绝保存', async () => {
  const spies = emptySpies();
  const settingsHost = createFakeReaderSettingsHost();
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    const save = new FakeElement('button', spies);
    view.modelSelect.value = 'manual';
    view.modelSelect.dispatch('change');
    view.modelInput.value = '';
    await view.saveSettings(save);
    assert.match(view.settingsStatus.textContent, /请填写模型 ID/u);
    assert.equal(settingsHost.getSaveCalls(), 0);

    view.modelInput.value = 'manual-model-id';
    view.modelInput.dispatch('input');
    view.inheritGenerationInput.checked = false;
    view.inheritGenerationInput.dispatch('change');
    for (const [input, invalidValue] of [
      [view.temperatureInput, '2.1'],
      [view.topPInput, '1.1'],
      [view.frequencyInput, '-2.1'],
      [view.presenceInput, '2.1'],
    ] as const) {
      input.value = invalidValue;
      input.dispatch('input');
      await view.saveSettings(save);
      assert.match(view.settingsStatus.textContent, /温度请填/u);
      assert.equal(settingsHost.getSaveCalls(), 0, `${input.id || input.type} 越界时不应保存`);
      input.value = input === view.temperatureInput ? '0.7'
        : input === view.topPInput ? '1'
          : '0';
    }
  });
});

test('保存期间继续编辑会保留未保存标记与输入，避免被旧保存结果清掉', async () => {
  const spies = emptySpies();
  let finishSave!: () => void;
  const delayedSave = new Promise<void>((resolve) => { finishSave = resolve; });
  const settingsHost = createFakeReaderSettingsHost(defaultReaderSettings(), { beforeSave: () => delayedSave });
  await withFakeBrowser(spies, async () => {
    const { view } = createReaderSettingsView(spies, settingsHost);
    view.analysisInput.value = '保存快照中的提示词';
    view.analysisInput.dispatch('input');
    const save = new FakeElement('button', spies);
    const saving = view.saveSettings(save);
    assert.equal(save.disabled, true);

    view.analysisInput.value = '保存期间新输入的提示词';
    view.analysisInput.dispatch('input');
    finishSave();
    await saving;

    assert.equal(settingsHost.getSavedSettings().analysisPrompt, '保存快照中的提示词');
    assert.equal(view.analysisInput.value, '保存期间新输入的提示词');
    assert.equal(view.settingsDirty, true);
    assert.equal(view.hasUnsavedInput(), true);
    assert.match(view.settingsStatus.textContent, /保存期间又有新修改/u);
    assert.equal(save.disabled, false);
  });
});

test('更新控件挂在酒馆扩展抽屉入口，不混入读卡设置表单', () => {
  const extensionSettingsMount = extensionIndexSource.match(
    /const settingsContainer = document\.getElementById\('extensions_settings'\);[\s\S]*?settingsContainer\.append\(settings\);/u,
  )?.[0];

  assert.ok(extensionSettingsMount, '应创建并挂载酒馆读卡的扩展设置入口');
  assert.match(extensionSettingsMount, /settings\.id = 'jgr-extension-settings'/u);
  assert.match(extensionSettingsMount, /view\.createUpdateControls\(\)/u);
  assert.equal((extensionIndexSource.match(/view\.createUpdateControls\(\)/gu) ?? []).length, 1);
  assert.doesNotMatch(viewSource, /form\.append\([^;]*this\.createUpdateControls\(\)/su);
  assert.doesNotMatch(viewSource, /this\.createUpdateControls\(\)/u);
});

test('刷新按钮仅在 updater 为 updated 时显示', async () => {
  const spies = emptySpies();
  await withFakeBrowser(spies, () => {
    const updater = createFakeUpdater();
    const controls = createView({ updater }).createUpdateControls() as unknown as FakeElement;
    const reloadButton = findButton(controls, '刷新页面');

    assert.ok(reloadButton, '扩展更新区应提供独立的页面刷新按钮');
    assert.equal(reloadButton.hidden, true);
    updater.setState('updated', '模拟更新已下载。');
    assert.equal(reloadButton.hidden, false);
    updater.setState('error', '模拟网络失败。');
    assert.equal(reloadButton.hidden, true);
  });
});

test('普通检查和下载不弹窗、不请求确认，也不自动刷新', async () => {
  const spies = emptySpies();
  await withFakeBrowser(spies, async () => {
    const updater = createFakeUpdater('idle', async (setState) => {
      setState('checking', '正在检查虚构更新。');
      setState('updating', '正在下载虚构更新。');
      setState('updated', '虚构更新已下载。');
    });
    const view = createView({ updater });
    view.createUpdateControls();

    await view.requestExtensionUpdate(fakeFeedback(spies) as unknown as HTMLElement);

    assert.equal(updater.updateCalls(), 1);
    assert.equal(updater.getState().phase, 'updated');
    assert.deepEqual(spies, { showModalCalls: 0, confirmCalls: 0, reloadCalls: 0 });
  });
});

test('下载更新不受未保存输入或读卡任务状态拦截，并保留所有输入', async () => {
  const spies = emptySpies();
  await withFakeBrowser(spies, async () => {
    const scenarios: Array<{
      name: string;
      settingsDirty?: boolean;
      questionText?: string;
      questionDrafts?: Array<[string, string]>;
      controllerState?: Partial<ControllerState>;
    }> = [
      { name: '未保存设置', settingsDirty: true },
      { name: '当前问题草稿', questionText: '当前角色的虚构问题草稿' },
      { name: '其他角色的问题草稿', questionDrafts: [['fictional-other-card', '其他角色的虚构追问']] },
      { name: '未保存解读结果', controllerState: { unsaved: true } },
      { name: '资料加载中', controllerState: { loading: true } },
      { name: '读卡任务忙', controllerState: { busy: true } },
    ];

    for (const scenario of scenarios) {
      const updater = createFakeUpdater('idle', async (setState) => {
        setState('checking', '正在检查虚构更新。');
        setState('updating', '正在下载虚构更新。');
        setState('updated', '虚构更新已下载。');
      });
      const view = createView({ ...scenario, updater });
      const beforeState = { ...view.controller.getState() };
      const beforeQuestion = view.questionInput.value;
      const beforeDrafts = [...view.questionDrafts];
      const feedback = fakeFeedback(spies);

      await view.requestExtensionUpdate(feedback as unknown as HTMLElement);

      assert.equal(updater.updateCalls(), 1, `${scenario.name}时仍应启动下载`);
      assert.equal(updater.getState().phase, 'updated', `${scenario.name}时应完成下载`);
      assert.equal(feedback.hidden, true, `${scenario.name}时不应显示拦截提示`);
      assert.equal(view.settingsDirty, scenario.settingsDirty ?? false, `${scenario.name}时应保留设置未保存标记`);
      assert.deepEqual(view.controller.getState(), beforeState, `${scenario.name}时不应改动读卡状态`);
      assert.equal(view.questionInput.value, beforeQuestion, `${scenario.name}时应保留当前问题草稿`);
      assert.deepEqual([...view.questionDrafts], beforeDrafts, `${scenario.name}时应保留所有角色的问题草稿`);
      assert.equal(view.updateRequestPending, false, `${scenario.name}下载完成后应清除更新进行标记`);
      assert.deepEqual(spies, { showModalCalls: 0, confirmCalls: 0, reloadCalls: 0 });
    }
  });
});

test('已下载且没有拦截条件时，点击刷新页面只刷新一次且不确认', async () => {
  const spies = emptySpies();
  await withFakeBrowser(spies, () => {
    const updater = createFakeUpdater('updated');
    const view = createView({ updater });
    const controls = view.createUpdateControls() as unknown as FakeElement;
    const reloadButton = findButton(controls, '刷新页面');

    assert.ok(reloadButton);
    reloadButton.click();

    assert.equal(spies.reloadCalls, 1);
    assert.equal(spies.confirmCalls, 0);
    assert.equal(spies.showModalCalls, 0);
  });
});

test('未保存输入或读卡任务忙时不刷新，并保留问题草稿', async () => {
  const spies = emptySpies();
  await withFakeBrowser(spies, () => {
    const scenarios: Array<{
      name: string;
      settingsDirty?: boolean;
      questionText?: string;
      questionDrafts?: Array<[string, string]>;
      controllerState?: Partial<ControllerState>;
      expected: RegExp;
    }> = [
      { name: '未保存设置', settingsDirty: true, expected: /未保存/u },
      { name: '未保存解读结果', controllerState: { unsaved: true }, expected: /未保存/u },
      { name: '当前问题草稿', questionText: '当前角色的虚构问题草稿', expected: /未保存/u },
      { name: '其他角色的问题草稿', questionDrafts: [['fictional-other-card', '其他角色的虚构追问']], expected: /未保存/u },
      { name: '资料加载中', controllerState: { loading: true }, expected: /正在读取角色卡资料/u },
      { name: '读卡任务忙', controllerState: { busy: true }, expected: /正在进行/u },
    ];

    for (const scenario of scenarios) {
      const updater = createFakeUpdater('updated');
      const view = createView({
        updater,
        settingsDirty: scenario.settingsDirty,
        questionText: scenario.questionText,
        questionDrafts: scenario.questionDrafts,
        controllerState: scenario.controllerState,
      });
      const beforeState = { ...view.controller.getState() };
      const beforeQuestion = view.questionInput.value;
      const beforeDrafts = [...view.questionDrafts];
      const feedback = fakeFeedback(spies);

      view.reloadAfterUpdate(feedback as unknown as HTMLElement);

      assert.equal(spies.reloadCalls, 0, `${scenario.name}时不能刷新`);
      assert.match(feedback.textContent, scenario.expected);
      assert.equal(view.settingsDirty, scenario.settingsDirty ?? false, `${scenario.name}时应保留设置未保存标记`);
      assert.deepEqual(view.controller.getState(), beforeState, `${scenario.name}时不应改动读卡状态`);
      assert.equal(view.questionInput.value, beforeQuestion, `${scenario.name}时应保留当前问题草稿`);
      assert.deepEqual([...view.questionDrafts], beforeDrafts, `${scenario.name}时应保留所有角色的问题草稿`);
    }

    assert.equal(spies.confirmCalls, 0);
    assert.equal(spies.showModalCalls, 0);
    assert.equal(spies.reloadCalls, 0);
  });
});

test('updater 未进入 updated 时不刷新', async () => {
  const spies = emptySpies();
  await withFakeBrowser(spies, () => {
    for (const phase of ['idle', 'checking', 'updating', 'current', 'error'] as const) {
      const updater = createFakeUpdater(phase);
      const view = createView({ updater, questionDrafts: [['fictional-card', '']] });
      const feedback = fakeFeedback(spies);
      const before = [...view.questionDrafts];

      view.reloadAfterUpdate(feedback as unknown as HTMLElement);

      assert.equal(spies.reloadCalls, 0, `${phase}状态时不能刷新`);
      assert.match(feedback.textContent, /先成功下载/u);
      assert.deepEqual([...view.questionDrafts], before, `${phase}状态不应清空已有草稿容器`);
    }
  });
});

test('更新进行中重复请求不会再启动更新，也不会清掉稍后输入的草稿', async () => {
  const spies = emptySpies();
  await withFakeBrowser(spies, async () => {
    let finishUpdate!: () => void;
    const waitForUpdate = new Promise<void>((resolve) => { finishUpdate = resolve; });
    const updater = createFakeUpdater('idle', async (setState) => {
      setState('checking', '正在检查虚构更新。');
      setState('updating', '正在下载虚构更新。');
      await waitForUpdate;
      setState('updated', '虚构更新已下载。');
    });
    const view = createView({ updater });
    const firstRequest = view.requestExtensionUpdate(fakeFeedback(spies) as unknown as HTMLElement);

    assert.equal(view.updateRequestPending, true);
    assert.equal(updater.updateCalls(), 1);
    view.questionInput.value = '更新期间输入的虚构问题';
    view.questionDrafts.set('fictional-card', '稍后再问的虚构追问');
    const repeatedFeedback = fakeFeedback(spies);
    await view.requestExtensionUpdate(repeatedFeedback as unknown as HTMLElement);

    assert.equal(updater.updateCalls(), 1);
    assert.match(repeatedFeedback.textContent, /仍在完成/u);
    assert.equal(view.questionInput.value, '更新期间输入的虚构问题');
    assert.deepEqual([...view.questionDrafts], [['fictional-card', '稍后再问的虚构追问']]);

    finishUpdate();
    await firstRequest;
    assert.equal(view.questionInput.value, '更新期间输入的虚构问题');
    assert.deepEqual([...view.questionDrafts], [['fictional-card', '稍后再问的虚构追问']]);
    assert.equal(spies.reloadCalls, 0);
  });
});

test('更新失败时保留正在输入的虚构问题和追问草稿', async () => {
  const spies = emptySpies();
  await withFakeBrowser(spies, async () => {
    let view!: ReaderViewHarness;
    const updater = createFakeUpdater('idle', async (setState) => {
      setState('checking', '正在检查虚构更新。');
      setState('updating', '正在下载虚构更新。');
      view.questionInput.value = '失败期间输入的虚构问题';
      view.questionDrafts.set('fictional-card', '失败后仍要保留的虚构追问');
      setState('error', '模拟更新失败。');
      throw new Error('FAKE_UPDATE_FAILURE');
    });
    view = createView({ updater });

    await view.requestExtensionUpdate(fakeFeedback(spies) as unknown as HTMLElement);

    assert.equal(updater.getState().phase, 'error');
    assert.equal(view.updateRequestPending, false);
    assert.equal(view.questionInput.value, '失败期间输入的虚构问题');
    assert.deepEqual([...view.questionDrafts], [['fictional-card', '失败后仍要保留的虚构追问']]);
    assert.deepEqual(spies, { showModalCalls: 0, confirmCalls: 0, reloadCalls: 0 });
  });
});
