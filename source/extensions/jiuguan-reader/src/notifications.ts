export type ReaderNotificationTone = 'success' | 'warning' | 'error' | 'info';

interface ReaderToastOptions {
  positionClass: 'toast-top-center';
  timeOut: number;
  extendedTimeOut: number;
  closeButton: false;
  escapeHtml: true;
}

type ToastrMethod = (message: string, title?: string, optionsOverride?: ReaderToastOptions) => unknown;
type ToastrApi = Partial<Record<ReaderNotificationTone, unknown>>;

const TOAST_OPTIONS: ReaderToastOptions = {
  positionClass: 'toast-top-center',
  timeOut: 5000,
  extendedTimeOut: 1000,
  closeButton: false,
  escapeHtml: true,
};
const FALLBACK_TIMEOUT_MS = 6000;
const FALLBACK_COLORS: Record<ReaderNotificationTone, string> = {
  success: '#2e7d32',
  warning: '#a15c00',
  error: '#b02a37',
  info: '#176b80',
};

let fallbackElement: HTMLElement | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a short, non-blocking status message without changing SillyTavern's global toast settings. */
export function notifyReader(message: string, tone: ReaderNotificationTone = 'success'): void {
  const text = String(message);
  const safeTone = normalizeTone(tone);
  const hasOpenDialog = hasNativeDialogOpen();
  const toastr = getToastr();
  const method = toastr?.[safeTone];

  // A native modal dialog is in the browser's top layer, above SillyTavern's
  // ordinary toast container. Use a top-layer popover in that case instead.
  if (!hasOpenDialog && typeof method === 'function') {
    try {
      (method as ToastrMethod).call(toastr, text, undefined, { ...TOAST_OPTIONS });
      removeFallback();
      return;
    } catch {
      // Some host versions may expose a partial toastr API; keep a safe local fallback.
    }
  }

  showFallback(text, safeTone);
}

function normalizeTone(tone: ReaderNotificationTone): ReaderNotificationTone {
  return tone === 'success' || tone === 'warning' || tone === 'error' || tone === 'info'
    ? tone
    : 'success';
}

function getToastr(): ToastrApi | null {
  const value = (globalThis as typeof globalThis & { toastr?: unknown }).toastr;
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  return value as ToastrApi;
}

function hasNativeDialogOpen(): boolean {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false;
  try {
    return document.querySelector('dialog[open]') !== null;
  } catch {
    return false;
  }
}

function showFallback(message: string, tone: ReaderNotificationTone): void {
  if (typeof document === 'undefined') return;
  const parent = document.body ?? document.documentElement;
  if (!parent) return;

  removeFallback();

  const bar = document.createElement('div');
  bar.className = 'jgr-reader-notification';
  bar.setAttribute('role', tone === 'error' || tone === 'warning' ? 'alert' : 'status');
  bar.setAttribute('aria-live', tone === 'error' || tone === 'warning' ? 'assertive' : 'polite');
  bar.setAttribute('aria-atomic', 'true');
  bar.setAttribute('popover', 'manual');
  bar.textContent = message;
  Object.assign(bar.style, {
    position: 'fixed',
    inset: 'auto',
    top: '12px',
    right: 'auto',
    bottom: 'auto',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483647',
    boxSizing: 'border-box',
    width: 'max-content',
    maxWidth: 'min(560px, calc(100vw - 24px))',
    margin: '0',
    padding: '10px 16px',
    border: '1px solid #ffffff55',
    borderRadius: '8px',
    backgroundColor: FALLBACK_COLORS[tone],
    color: '#fff',
    boxShadow: '0 4px 16px #0008',
    font: 'inherit',
    lineHeight: '1.45',
    textAlign: 'center',
    overflowWrap: 'anywhere',
    pointerEvents: 'none',
  });
  parent.appendChild(bar);

  // Popovers enter the browser top layer, so this notice remains visible above
  // native modal dialogs. Older browsers keep the same bar as a fixed element.
  let shownInTopLayer = false;
  if (typeof bar.showPopover === 'function') {
    try {
      bar.showPopover();
      shownInTopLayer = true;
    } catch {
      // The fixed-position element remains usable if the host blocks popovers.
    }
  }
  if (!shownInTopLayer) {
    // A closed popover is hidden by browser defaults, so restore ordinary
    // fixed-bar behavior when the API is missing or cannot enter the top layer.
    bar.removeAttribute('popover');
    bar.style.display = 'block';
  }

  fallbackElement = bar;
  fallbackTimer = setTimeout(() => {
    if (fallbackElement !== bar) return;
    bar.remove();
    fallbackElement = null;
    fallbackTimer = undefined;
  }, FALLBACK_TIMEOUT_MS);
}

function removeFallback(): void {
  if (fallbackTimer !== undefined) {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  }
  fallbackElement?.remove();
  fallbackElement = null;
}
