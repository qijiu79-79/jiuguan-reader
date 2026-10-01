import { createReaderHost } from './host.js';
import { ReaderController } from './controller.js';
import { ReaderView } from './ui.js';
import { ReaderUpdater } from './updater.js';
import './style.css';

interface NativeContext {
  characterId?: number | string;
  characters?: Array<{ avatar?: string }>;
  menuType?: string;
  getRequestHeaders?: () => HeadersInit;
  eventSource?: { on(event: string, listener: (...args: unknown[]) => void): void };
  eventTypes?: Record<string, string>;
}

function nativeContext(): NativeContext | null {
  const native = (globalThis as unknown as { SillyTavern?: { getContext(): NativeContext } }).SillyTavern;
  return native?.getContext() ?? null;
}

function currentCardKey(): string {
  const context = nativeContext();
  if (!context || context.menuType === 'create' || context.characterId === undefined || context.characterId === '') return '';
  return context.characters?.[Number(context.characterId)]?.avatar ?? '';
}

async function initialize(): Promise<void> {
  if (document.getElementById('jgr-reader-dialog')) return;
  const host = await createReaderHost();
  const controller = new ReaderController(host);
  const updater = new ReaderUpdater({
    getHeaders: () => {
      const context = nativeContext();
      if (typeof context?.getRequestHeaders !== 'function') {
        throw new Error('当前酒馆未提供扩展更新所需的请求头接口，请更新酒馆后重试。');
      }
      return context.getRequestHeaders();
    },
  });
  const view = new ReaderView(controller, host, updater);
  let previousKey = currentCardKey();
  let refreshPending = false;
  const refreshMaterial = (): void => {
    if (!view.isOpen()) return;
    const state = controller.getState();
    if (state.busy || state.unsaved || state.loading) {
      refreshPending = true;
      return;
    }
    refreshPending = false;
    void controller.loadCurrent();
  };
  controller.subscribe((state) => {
    if (!view.isOpen() || state.busy || state.unsaved || state.loading) return;
    // Saving a retained result after switching cards must return to the card
    // currently shown by the host, without losing the unsaved old-card result.
    const cardChanged = state.document && state.document.characterKey !== currentCardKey();
    if (refreshPending || cardChanged) {
      refreshPending = false;
      void controller.loadCurrent();
    }
  });
  const mount = (): void => {
    const toolbar = document.querySelector('#avatar_controls .form_create_bottom_buttons_block')
      ?? document.querySelector('#avatar_div .form_create_bottom_buttons_block');
    let entry = document.getElementById('jgr-character-entry') as HTMLButtonElement | null;
    if (toolbar && !entry) {
      entry = document.createElement('button');
      entry.id = 'jgr-character-entry';
      entry.type = 'button';
      entry.className = 'menu_button jgr-entry';
      entry.title = '中文解读人物、经历和世界书，不读开场白';
      entry.setAttribute('aria-label', '读懂这张角色卡');
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-book-open';
      icon.setAttribute('aria-hidden', 'true');
      entry.append(icon, document.createTextNode('读卡'));
      entry.addEventListener('click', () => { void view.open(); });
    }
    if (toolbar && entry && toolbar.firstElementChild !== entry) {
      toolbar.prepend(entry);
    }
    const key = currentCardKey();
    if (entry) entry.disabled = !key;
    if (key !== previousKey) {
      previousKey = key;
      if (view.isOpen()) void controller.loadCurrent();
    }
    const settingsContainer = document.getElementById('extensions_settings');
    if (settingsContainer && !document.getElementById('jgr-extension-settings')) {
      const settings = document.createElement('div');
      settings.id = 'jgr-extension-settings';
      settings.className = 'inline-drawer jgr-extension-settings extension_container';
      const header = document.createElement('div');
      header.className = 'inline-drawer-toggle inline-drawer-header';
      const title = document.createElement('b');
      title.textContent = '酒馆读卡';
      const icon = document.createElement('div');
      icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
      header.append(title, icon);
      const content = document.createElement('div');
      content.className = 'inline-drawer-content';
      const hint = document.createElement('p');
      hint.className = 'jgr-muted';
      hint.textContent = '在角色卡头像旁点“读卡”。连接、提示词与快捷问题可在下面的设置中修改。';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jgr-button';
      button.textContent = '打开读卡设置';
      button.addEventListener('click', () => view.openSettings());
      content.append(view.createUpdateControls(), hint, button);
      settings.append(header, content);
      settingsContainer.append(settings);
    }
  };
  mount();
  let mountPending = false;
  const observer = new MutationObserver(() => {
    if (mountPending) return;
    mountPending = true;
    requestAnimationFrame(() => { mountPending = false; mount(); });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const context = nativeContext();
  for (const name of ['APP_READY', 'CHAT_CHANGED', 'CHARACTER_EDITED', 'CHARACTER_DELETED']) {
    const event = context?.eventTypes?.[name];
    if (!event) continue;
    context?.eventSource?.on(event, () => {
      mount();
      if (name === 'CHARACTER_EDITED') refreshMaterial();
    });
  }
  const worldUpdated = context?.eventTypes?.WORLDINFO_UPDATED;
  if (worldUpdated) context?.eventSource?.on(worldUpdated, (name) => {
    const books = controller.getState().document?.worldbooks ?? [];
    if (typeof name === 'string' && books.some((book) => book === `主关联：${name}` || book === `额外关联：${name}`)) refreshMaterial();
  });
  const bindingsUpdated = context?.eventTypes?.WORLDINFO_SETTINGS_UPDATED;
  if (bindingsUpdated) context?.eventSource?.on(bindingsUpdated, refreshMaterial);
}

let attempts = 0;
function boot(): void {
  if (!nativeContext()) {
    if (++attempts < 100) setTimeout(boot, 300);
    return;
  }
  void initialize().catch(() => {
    const settings = document.getElementById('extensions_settings');
    if (!settings || document.getElementById('jgr-init-error')) return;
    const warning = document.createElement('p');
    warning.id = 'jgr-init-error';
    warning.textContent = '酒馆读卡未能加载，请刷新页面并确认酒馆版本支持扩展生成接口。';
    settings.append(warning);
  });
}

boot();
