import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ReaderView } from '../extensions/jiuguan-reader/src/ui.js';
import type { ExtensionUpdater, ExtensionUpdateState } from '../extensions/jiuguan-reader/src/updater.js';

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

interface FakeUpdater extends ExtensionUpdater {
  setState: SetUpdateState;
  updateCalls(): number;
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  title = '';
  type = '';
  value = '';

  constructor(readonly tagName: string, private readonly spies: UiSpies) {}

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) this.children.push(node);
      else if (typeof node === 'string') this.textContent += node;
    }
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
    for (const listener of this.listeners.get('click') ?? []) listener({} as Event);
  }

  showModal(): void {
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

const extensionIndexSource = readFileSync(new URL('../extensions/jiuguan-reader/src/index.ts', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('../extensions/jiuguan-reader/src/ui.ts', import.meta.url), 'utf8');

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
    for (const scenario of [
      { name: '未保存', settingsDirty: true, busy: false, expected: /未保存/u },
      { name: '任务忙', settingsDirty: false, busy: true, expected: /正在进行/u },
    ]) {
      const updater = createFakeUpdater('updated');
      const draftText = `虚构追问-${scenario.name}`;
      const view = createView({
        updater,
        settingsDirty: scenario.settingsDirty,
        questionText: draftText,
        questionDrafts: [['fictional-card', draftText]],
        controllerState: { busy: scenario.busy },
      });
      const feedback = fakeFeedback(spies);

      view.reloadAfterUpdate(feedback as unknown as HTMLElement);

      assert.equal(spies.reloadCalls, 0, `${scenario.name}时不能刷新`);
      assert.match(feedback.textContent, scenario.expected);
      assert.equal(view.questionInput.value, draftText);
      assert.deepEqual([...view.questionDrafts], [['fictional-card', draftText]]);
    }
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
