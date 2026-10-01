import type { ReaderSource } from './types.js';

/** Text-only Markdown: never evaluates card HTML, loads remote images, or creates model links. */
export function renderReadingText(text: string, sources: readonly ReaderSource[], showSource: (source: ReaderSource) => void): HTMLElement {
  const root = document.createElement('div');
  root.className = 'jgr-reading-text';
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const line of text.split('\n')) {
    const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
    const element = document.createElement(heading ? 'h4' : 'div');
    element.className = heading ? 'jgr-text-heading' : 'jgr-text-line';
    appendInline(element, heading?.[2] ?? line, byId, showSource);
    if (!line) element.append(document.createElement('br'));
    root.append(element);
  }
  return root;
}

function appendInline(parent: HTMLElement, text: string, sources: ReadonlyMap<string, ReaderSource>, showSource: (source: ReaderSource) => void): void {
  const tokens = text.split(/(\[S\d+\]|\*\*[^*\n]+\*\*)/gu);
  for (const token of tokens) {
    const source = sources.get(token);
    if (source) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jgr-citation';
      button.textContent = token;
      button.title = `查看原文：${source.label}`;
      button.addEventListener('click', () => showSource(source));
      parent.append(button);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else {
      parent.append(document.createTextNode(token));
    }
  }
}
