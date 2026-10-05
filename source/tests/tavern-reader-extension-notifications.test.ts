import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyReader } from '../extensions/jiuguan-reader/src/notifications.js';

type Tone = 'success' | 'warning' | 'error' | 'info';

interface ToastCall {
  tone: Tone;
  args: unknown[];
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  parentNode: FakeElement | null = null;
  className = '';
  textContent = '';
  removed = false;
  popoverShown = false;
  throwOnPopover = false;
  innerHtmlWasUsed = false;

  constructor(readonly tagName: string) {}

  set innerHTML(_value: string) {
    this.innerHtmlWasUsed = true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
    this.removed = true;
  }

  showPopover(): void {
    if (this.throwOnPopover) throw new Error('Popover is unavailable');
    this.popoverShown = true;
  }
}

class FakeDocument {
  readonly body = new FakeElement('body');
  readonly documentElement = new FakeElement('html');
  modalOpen = false;
  throwOnPopover = false;

  createElement(tagName: string): HTMLElement {
    const element = new FakeElement(tagName);
    element.throwOnPopover = this.throwOnPopover;
    return element as unknown as HTMLElement;
  }

  querySelector(selector: string): Element | null {
    assert.equal(selector, 'dialog[open]');
    return this.modalOpen ? {} as Element : null;
  }
}

function replaceGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  };
}

function useFakeTimer(): { timers: Array<{ callback: () => void; delay: number }>; restore: () => void } {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const fakeSetTimeout = ((callback: TimerHandler, delay = 0) => {
    timers.push({ callback: callback as () => void, delay });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  return { timers, restore: replaceGlobal('setTimeout', fakeSetTimeout) };
}

test('uses the matching SillyTavern toast method with per-toast options only', () => {
  const calls: ToastCall[] = [];
  const globalOptions = { positionClass: 'toast-bottom-right', timeOut: 321 };
  const record = (tone: Tone) => (...args: unknown[]) => calls.push({ tone, args });
  const toastr = {
    options: globalOptions,
    success: record('success'),
    warning: record('warning'),
    error: record('error'),
    info: record('info'),
  };
  const restore = replaceGlobal('toastr', toastr);

  try {
    notifyReader('解读完成');
    notifyReader('需要留意', 'warning');
    notifyReader('解读失败', 'error');
    notifyReader('有更新', 'info');

    assert.deepEqual(calls.map(({ tone, args }) => ({ tone, message: args[0], title: args[1], options: args[2] })), [
      { tone: 'success', message: '解读完成', title: undefined, options: {
        positionClass: 'toast-top-center', timeOut: 5000, extendedTimeOut: 1000, closeButton: false, escapeHtml: true,
      } },
      { tone: 'warning', message: '需要留意', title: undefined, options: {
        positionClass: 'toast-top-center', timeOut: 5000, extendedTimeOut: 1000, closeButton: false, escapeHtml: true,
      } },
      { tone: 'error', message: '解读失败', title: undefined, options: {
        positionClass: 'toast-top-center', timeOut: 5000, extendedTimeOut: 1000, closeButton: false, escapeHtml: true,
      } },
      { tone: 'info', message: '有更新', title: undefined, options: {
        positionClass: 'toast-top-center', timeOut: 5000, extendedTimeOut: 1000, closeButton: false, escapeHtml: true,
      } },
    ]);
    assert.deepEqual(toastr.options, { positionClass: 'toast-bottom-right', timeOut: 321 });
    assert.notEqual(calls[0]?.args[2], calls[1]?.args[2]);
  } finally {
    restore();
  }
});

test('fallback uses textContent and removes its green success bar after six seconds', () => {
  const fakeDocument = new FakeDocument();
  const restoreDocument = replaceGlobal('document', fakeDocument);
  const restoreToastr = replaceGlobal('toastr', undefined);
  const timer = useFakeTimer();

  try {
    const untrustedMessage = '<img src=x onerror="run()"> 解读完成';
    notifyReader(untrustedMessage);

    const bar = fakeDocument.body.children[0];
    assert.ok(bar);
    assert.equal(bar.textContent, untrustedMessage);
    assert.equal(bar.innerHtmlWasUsed, false);
    assert.equal(bar.style.backgroundColor, '#2e7d32');
    assert.equal(bar.getAttribute('role'), 'status');
    assert.equal(bar.getAttribute('aria-live'), 'polite');
    assert.equal(bar.popoverShown, true);
    assert.equal(timer.timers[0]?.delay, 6000);

    timer.timers[0]?.callback();
    assert.equal(bar.removed, true);
    assert.equal(fakeDocument.body.children.length, 0);
  } finally {
    timer.restore();
    restoreToastr();
    restoreDocument();
  }
});

test('uses a top-layer warning bar instead of a toast hidden by an open native dialog', () => {
  const fakeDocument = new FakeDocument();
  fakeDocument.modalOpen = true;
  const restoreDocument = replaceGlobal('document', fakeDocument);
  let toastCalls = 0;
  const restoreToastr = replaceGlobal('toastr', { error: () => { toastCalls += 1; } });
  const timer = useFakeTimer();

  try {
    notifyReader('暂时无法读取', 'error');

    const bar = fakeDocument.body.children[0];
    assert.ok(bar);
    assert.equal(toastCalls, 0);
    assert.equal(bar.style.backgroundColor, '#b02a37');
    assert.equal(bar.getAttribute('role'), 'alert');
    assert.equal(bar.popoverShown, true);

    timer.timers[0]?.callback();
  } finally {
    timer.restore();
    restoreToastr();
    restoreDocument();
  }
});

test('keeps a visible fixed fallback if entering the popover top layer fails', () => {
  const fakeDocument = new FakeDocument();
  fakeDocument.modalOpen = true;
  fakeDocument.throwOnPopover = true;
  const restoreDocument = replaceGlobal('document', fakeDocument);
  const restoreToastr = replaceGlobal('toastr', undefined);
  const timer = useFakeTimer();

  try {
    notifyReader('仍可看见的提示');

    const bar = fakeDocument.body.children[0];
    assert.ok(bar);
    assert.equal(bar.getAttribute('popover'), null);
    assert.equal(bar.style.display, 'block');
    assert.equal(bar.textContent, '仍可看见的提示');
    timer.timers[0]?.callback();
  } finally {
    timer.restore();
    restoreToastr();
    restoreDocument();
  }
});
