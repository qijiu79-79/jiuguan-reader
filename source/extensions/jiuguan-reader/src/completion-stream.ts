/** Read raw SSE so stop reasons remain verifiable (the host's text generator drops them). */
export async function readCompletionResponse(response: Response, signal: AbortSignal, onText?: (text: string) => void): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  if (response.headers.get('content-type')?.includes('application/json')) {
    const data = await response.json() as Record<string, unknown>;
    signal.throwIfAborted();
    return data;
  }
  if (!response.body) throw new Error('流式接口没有返回响应正文。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = '';
  let doneEvent = false;
  let format: 'sse' | 'json' | undefined = response.headers.get('content-type')?.includes('text/event-stream') ? 'sse' : undefined;
  const abort = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const consume = (event: string): void => {
    const data = event.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!data) return;
    if (data === '[DONE]') { doneEvent = true; return; }
    let record: Record<string, unknown>;
    try { record = JSON.parse(data) as Record<string, unknown>; } catch { throw new Error('流式接口返回了无法解析的数据；未采用未完成结果。'); }
    if (record.error || record.type === 'error') throw new Error(providerErrorMessage(record));
    const choice = Array.isArray(record.choices) ? asRecord(record.choices.find((item) => {
      const index = asRecord(item)?.index;
      return index === 0 || index === undefined;
    })) : null;
    const delta = asRecord(choice?.delta);
    const candidate = Array.isArray(record.candidates) ? asRecord(record.candidates[0]) : null;
    const nativeDelta = asRecord(record.delta);
    const nativeContent = asRecord(record.content_block);
    const addition = choice ? textContent(delta?.content ?? delta?.refusal ?? choice.text)
      : candidate ? textContent(asRecord(candidate.content)?.parts)
        : record.type === 'content_block_delta' && nativeDelta?.type === 'text_delta' ? textContent(nativeDelta.text)
          : record.type === 'content_block_start' && nativeContent?.type === 'text' ? textContent(nativeContent.text) : '';
    if (addition) { text += addition; onText?.(text); }
    const reason = choice?.finish_reason ?? candidate?.finishReason ?? nativeDelta?.stop_reason ?? asRecord(record.message)?.stop_reason;
    if (typeof reason === 'string' && reason) finishReason = reason;
  };
  const flush = (last = false): void => {
    // Decode before normalizing CRLF: both UTF-8 characters and delimiters may span packets.
    buffer = buffer.replace(/\r\n/gu, '\n');
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      consume(event);
      if (doneEvent) return;
    }
    if (last && buffer.trim()) consume(buffer);
  };
  try {
    while (!doneEvent) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      // SillyTavern forwards SSE bytes without retaining Content-Type. Sniff the
      // first non-whitespace character, while still allowing ignored-stream JSON.
      if (!format && buffer.trimStart()) format = /^[\[{]/u.test(buffer.trimStart()) ? 'json' : 'sse';
      if (format === 'sse') flush(chunk.done);
      if (chunk.done) break;
    }
    signal.throwIfAborted();
    if (format === 'json') return JSON.parse(buffer) as Record<string, unknown>;
    return { choices: [{ message: { content: text }, finish_reason: finishReason || undefined }] };
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function providerErrorMessage(value: unknown): string {
  const record = asRecord(value);
  const nested = record?.error;
  if (nested && nested !== value && typeof nested !== 'boolean') return providerErrorMessage(nested);
  return typeof value === 'string' ? value
    : typeof record?.message === 'string' ? record.message
      : typeof record?.detail === 'string' ? record.detail
        : typeof record?.error_description === 'string' ? record.error_description : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    const item = asRecord(part);
    return item?.thought !== true && (item?.type === 'text' || item?.type === undefined) && typeof item?.text === 'string' ? item.text : '';
  }).join('');
}
