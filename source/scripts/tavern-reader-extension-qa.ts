/**
 * Local deterministic OpenAI-compatible model and optional isolated SillyTavern seed.
 * The mock binds only to loopback, never prints prompts or authorization headers, and
 * refuses seed writes except to the explicitly isolated SillyTavern 1.19.0 QA instance.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

const MOCK_MODEL = 'reader-qa-mock';
const MOCK_ALTERNATE_MODEL = 'reader-qa-alternate-with-a-long-model-identifier-2026-10-01';
const MOCK_SERVICE = 'jiuguan-reader-qa-mock';
const MOCK_INDEPENDENT_KEY = 'reader-qa-independent-only-fake';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const GREETING_MARKER = 'GREETING_MUST_NOT_BE_SENT';
const UNRELATED_WORLD_MARKER = 'UNRELATED_WORLD_MUST_NOT_BE_SENT';
const AUTHOR_NOTES_MARKER = 'AUTHOR_NOTES_MUST_NOT_BE_SENT';
const METADATA_TAGS_MARKER = 'METADATA_TAGS_MUST_NOT_BE_SENT';
const EXPERIENCE_BODY_SENTENCE = 'Years ago, her closest friend Storm disappeared while checking the outer reef during a winter gale.';
const PRIMARY_WORLD_SENTENCE = 'The lighthouse lamp must stay lit after sunset. Mara tends it herself; this is a standing rule, not a rumor or a conditional event.';
const EXTRA_WORLD_SENTENCE = 'Only when the brass storm bell rings three times can the old rescue route across the outer reef be used, and then only for one night. This rule does not reveal what happened to Storm.';
const STATIC_QA_SYSTEM_PROMPT = '  读卡 QA 唯一系统提示词 {{char}}\n保持原样。  ';
const ALLOWED_ST_BASE = 'http://127.0.0.1:52271';
const EXPECTED_ST_VERSION = '1.19.0';
const EXPECTED_ST_REVISION_PREFIX = '06bde93';
const ALLOWED_ST_ORIGIN = 'http://127.0.0.1:52271';

type ControlMode = 'normal' | 'length' | 'failure' | 'delay';

interface SafeStats {
  requestCount: number;
  modelListRequests: number;
  lastModelListUsedIndependentKey: boolean | null;
  lastGenerationUsedIndependentKey: boolean | null;
  greetingMarkerSeen: boolean;
  unrelatedWorldMarkerSeen: boolean;
  authorNotesMarkerSeen: boolean;
  metadataTagsMarkerSeen: boolean;
  markerViolationRequests: number;
  experienceBodySeen: boolean;
  primaryWorldbookBodySeen: boolean;
  extraWorldbookBodySeen: boolean;
  userPlaceholderSeen: boolean;
  charPlaceholderSeen: boolean;
  exactSystemPromptSeen: boolean;
  systemMessageCountByRequest: number[];
  failureResponses: number;
  delayedResponses: number;
  stopResponses: number;
  lengthResponses: number;
  lastRequestUsedExpectedModel: boolean | null;
  lastGeneration: {
    model: string | null;
    temperature: number | null;
    topP: number | null;
    frequencyPenalty: number | null;
    presencePenalty: number | null;
    maxTokens: number | null;
  } | null;
}

interface MockControl {
  mode: ControlMode;
  delayMs: number;
  failureStatus: 429 | 500 | 503;
}

interface MockOptions {
  port: number;
  seedSt?: string;
}

interface STSession {
  cookies: Map<string, string>;
  csrfToken: string;
}

interface STVersion {
  pkgVersion?: string;
  gitRevision?: string;
}

interface SourceBlock {
  id: string;
  label: string;
  status: string;
  text: string;
}

interface ImportWorldbookResult {
  name?: string;
}

interface ImportCharacterResult {
  file_name?: string;
}

const stats: SafeStats = {
  requestCount: 0,
  modelListRequests: 0,
  lastModelListUsedIndependentKey: null,
  lastGenerationUsedIndependentKey: null,
  greetingMarkerSeen: false,
  unrelatedWorldMarkerSeen: false,
  authorNotesMarkerSeen: false,
  metadataTagsMarkerSeen: false,
  markerViolationRequests: 0,
  experienceBodySeen: false,
  primaryWorldbookBodySeen: false,
  extraWorldbookBodySeen: false,
  userPlaceholderSeen: false,
  charPlaceholderSeen: false,
  exactSystemPromptSeen: false,
  systemMessageCountByRequest: [],
  failureResponses: 0,
  delayedResponses: 0,
  stopResponses: 0,
  lengthResponses: 0,
  lastRequestUsedExpectedModel: null,
  lastGeneration: null,
};

const control: MockControl = { mode: 'normal', delayMs: 0, failureStatus: 503 };
let mockOrigin = '';
let stopping = false;

const server = createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    sendJson(response, 500, { error: { message: 'Local QA mock failed safely.', type: 'server_error' } });
  });
});

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.seedSt) assertAllowedSeedTarget(options.seedSt);

  await listen(options.port);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve the local mock address.');
  mockOrigin = `http://127.0.0.1:${address.port}`;

  process.stdout.write(`MOCK_BASE_URL=${mockOrigin}/v1\n`);
  process.stdout.write(`MOCK_MODEL=${MOCK_MODEL}\n`);
  process.stdout.write(`MOCK_HEALTH=${mockOrigin}/qa/health\n`);
  process.stdout.write(`MOCK_STATS=${mockOrigin}/qa/stats\n`);
  process.stdout.write(`MOCK_STATUS=${mockOrigin}/mock-status\n`);
  process.stdout.write(`MOCK_CONTROL=${mockOrigin}/qa/control\n`);

  process.on('SIGINT', stopServer);
  process.on('SIGTERM', stopServer);

  if (options.seedSt) {
    try {
      const seeded = await seedIsolatedSillyTavern(options.seedSt);
      process.stdout.write(`${JSON.stringify(seeded, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`ST seed failed: ${safeErrorMessage(error)}\n`);
      await closeServer();
      process.exitCode = 1;
    }
  }
}

function parseOptions(args: string[]): MockOptions {
  let port = 0;
  let seedSt: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') {
      process.stdout.write([
        'Usage: npx tsx scripts/tavern-reader-extension-qa.ts [--port=0] [--seed-st=http://127.0.0.1:52271]',
        'Default port 0 asks the OS for a random available loopback port.',
        'Seed writes are refused for every target except the isolated ST QA instance on 127.0.0.1:52271.',
      ].join('\n') + '\n');
      process.exit(0);
    }

    if (argument === '--seed-st') {
      seedSt = args[index + 1];
      index += 1;
      if (!seedSt) throw new Error('--seed-st requires the exact isolated QA URL.');
      continue;
    }
    if (argument.startsWith('--seed-st=')) {
      seedSt = argument.slice('--seed-st='.length);
      continue;
    }
    if (argument === '--port') {
      const value = args[index + 1];
      index += 1;
      if (!value) throw new Error('--port requires a number.');
      port = parsePort(value);
      continue;
    }
    if (argument.startsWith('--port=')) {
      port = parsePort(argument.slice('--port='.length));
      continue;
    }
    throw new Error('Unsupported argument. Use --help to see the safe QA options.');
  }

  return { port, ...(seedSt ? { seedSt } : {}) };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer from 0 to 65535.');
  }
  return port;
}

function assertAllowedSeedTarget(value: string): asserts value is typeof ALLOWED_ST_BASE {
  if (value !== ALLOWED_ST_BASE) {
    throw new Error(`Refusing to seed ${value}: only ${ALLOWED_ST_BASE} is allowed for this isolated QA run.`);
  }
  const target = new URL(value);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.port !== '52271'
    || target.pathname !== '/' || target.search || target.hash || target.username || target.password) {
    throw new Error('Refusing seed target: it must be the exact loopback QA address with no path or credentials.');
  }
}

async function listen(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  applyLocalCors(request, response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    stats.modelListRequests += 1;
    stats.lastModelListUsedIndependentKey = request.headers.authorization === `Bearer ${MOCK_INDEPENDENT_KEY}`;
    sendJson(response, 200, {
      object: 'list',
      data: [MOCK_MODEL, MOCK_ALTERNATE_MODEL].map((id) => ({ id, object: 'model', created: 1_791_000_000, owned_by: 'local-qa' })),
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/qa/health') {
    sendJson(response, 200, { ok: true, service: MOCK_SERVICE, modelName: MOCK_MODEL, bind: '127.0.0.1' });
    return;
  }

  if (request.method === 'GET' && (pathname === '/qa/stats' || pathname === '/mock-status')) {
    sendJson(response, 200, {
      service: MOCK_SERVICE,
      mockModelName: MOCK_MODEL,
      requestCount: stats.requestCount,
      modelListRequests: stats.modelListRequests,
      lastModelListUsedIndependentKey: stats.lastModelListUsedIndependentKey,
      lastGenerationUsedIndependentKey: stats.lastGenerationUsedIndependentKey,
      greetingMarkerSeen: stats.greetingMarkerSeen,
      unrelatedWorldMarkerSeen: stats.unrelatedWorldMarkerSeen,
      authorNotesMarkerSeen: stats.authorNotesMarkerSeen,
      metadataTagsMarkerSeen: stats.metadataTagsMarkerSeen,
      markerViolationRequests: stats.markerViolationRequests,
      experienceBodySeen: stats.experienceBodySeen,
      primaryWorldbookBodySeen: stats.primaryWorldbookBodySeen,
      extraWorldbookBodySeen: stats.extraWorldbookBodySeen,
      userPlaceholderSeen: stats.userPlaceholderSeen,
      charPlaceholderSeen: stats.charPlaceholderSeen,
      exactSystemPromptSeen: stats.exactSystemPromptSeen,
      systemMessageCountByRequest: stats.systemMessageCountByRequest,
      failureResponses: stats.failureResponses,
      delayedResponses: stats.delayedResponses,
      stopResponses: stats.stopResponses,
      lengthResponses: stats.lengthResponses,
      lastRequestUsedExpectedModel: stats.lastRequestUsedExpectedModel,
      lastGeneration: stats.lastGeneration,
      control: { mode: control.mode, delayMs: control.delayMs, failureStatus: control.failureStatus },
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/qa/control') {
    await handleControl(request, response);
    return;
  }

  if (request.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
    await handleCompletion(request, response);
    return;
  }

  sendJson(response, 404, { error: { message: 'Unknown local QA endpoint.', type: 'invalid_request_error' } });
}

function applyLocalCors(request: IncomingMessage, response: ServerResponse): void {
  if (request.headers.origin === ALLOWED_ST_ORIGIN) {
    response.setHeader('Access-Control-Allow-Origin', ALLOWED_ST_ORIGIN);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}

async function handleControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(await readBody(request));
  } catch {
    sendJson(response, 400, { error: { message: 'Control body must be a small JSON object.', type: 'invalid_request_error' } });
    return;
  }

  const mode = payload.mode;
  if (mode !== 'normal' && mode !== 'length' && mode !== 'failure' && mode !== 'delay') {
    sendJson(response, 400, { error: { message: 'mode must be normal, length, failure, or delay.', type: 'invalid_request_error' } });
    return;
  }

  const requestedDelay = payload.delayMs === undefined ? 1_500 : Number(payload.delayMs);
  if (!Number.isInteger(requestedDelay) || requestedDelay < 0 || requestedDelay > 30_000) {
    sendJson(response, 400, { error: { message: 'delayMs must be an integer from 0 to 30000.', type: 'invalid_request_error' } });
    return;
  }

  const requestedStatus = payload.failureStatus === undefined ? 503 : Number(payload.failureStatus);
  if (requestedStatus !== 429 && requestedStatus !== 500 && requestedStatus !== 503) {
    sendJson(response, 400, { error: { message: 'failureStatus must be 429, 500, or 503.', type: 'invalid_request_error' } });
    return;
  }

  if (payload.resetStats === true) resetStats();
  control.mode = mode;
  control.delayMs = mode === 'delay' ? requestedDelay : 0;
  control.failureStatus = requestedStatus;
  sendJson(response, 200, {
    ok: true,
    mode: control.mode,
    delayMs: control.delayMs,
    failureStatus: control.failureStatus,
    statsReset: payload.resetStats === true,
  });
}

function resetStats(): void {
  stats.requestCount = 0;
  stats.modelListRequests = 0;
  stats.lastModelListUsedIndependentKey = null;
  stats.lastGenerationUsedIndependentKey = null;
  stats.greetingMarkerSeen = false;
  stats.unrelatedWorldMarkerSeen = false;
  stats.authorNotesMarkerSeen = false;
  stats.metadataTagsMarkerSeen = false;
  stats.markerViolationRequests = 0;
  stats.experienceBodySeen = false;
  stats.primaryWorldbookBodySeen = false;
  stats.extraWorldbookBodySeen = false;
  stats.userPlaceholderSeen = false;
  stats.charPlaceholderSeen = false;
  stats.exactSystemPromptSeen = false;
  stats.systemMessageCountByRequest = [];
  stats.failureResponses = 0;
  stats.delayedResponses = 0;
  stats.stopResponses = 0;
  stats.lengthResponses = 0;
  stats.lastRequestUsedExpectedModel = null;
  stats.lastGeneration = null;
}

async function handleCompletion(request: IncomingMessage, response: ServerResponse): Promise<void> {
  stats.requestCount += 1;
  stats.lastGenerationUsedIndependentKey = request.headers.authorization === `Bearer ${MOCK_INDEPENDENT_KEY}`;
  let rawBody: string;
  try {
    rawBody = await readBody(request);
  } catch {
    sendJson(response, 413, { error: { message: 'Local QA request is too large.', type: 'invalid_request_error' } });
    return;
  }

  const hasGreetingMarker = rawBody.includes(GREETING_MARKER);
  const hasUnrelatedMarker = rawBody.includes(UNRELATED_WORLD_MARKER);
  const hasAuthorNotesMarker = rawBody.includes(AUTHOR_NOTES_MARKER);
  const hasMetadataTagsMarker = rawBody.includes(METADATA_TAGS_MARKER);
  const hasExcludedMarker = hasGreetingMarker || hasUnrelatedMarker || hasAuthorNotesMarker || hasMetadataTagsMarker;
  stats.greetingMarkerSeen ||= hasGreetingMarker;
  stats.unrelatedWorldMarkerSeen ||= hasUnrelatedMarker;
  stats.authorNotesMarkerSeen ||= hasAuthorNotesMarker;
  stats.metadataTagsMarkerSeen ||= hasMetadataTagsMarker;
  stats.experienceBodySeen ||= rawBody.includes(EXPERIENCE_BODY_SENTENCE);
  stats.primaryWorldbookBodySeen ||= rawBody.includes(PRIMARY_WORLD_SENTENCE);
  stats.extraWorldbookBodySeen ||= rawBody.includes(EXTRA_WORLD_SENTENCE);

  let body: Record<string, unknown>;
  try {
    body = parseJsonObject(rawBody);
  } catch {
    if (hasExcludedMarker) {
      stats.markerViolationRequests += 1;
      stats.failureResponses += 1;
      sendMarkerLeak(response);
      return;
    }
    sendJson(response, 400, { error: { message: 'Completion request must be valid JSON.', type: 'invalid_request_error' } });
    return;
  }
  const systemMessages = Array.isArray(body.messages)
    ? body.messages.filter(isRecord).filter((message) => message.role === 'system')
    : [];
  const userText = userMessageText(body.messages);
  stats.systemMessageCountByRequest.push(systemMessages.length);
  stats.exactSystemPromptSeen ||= systemMessages.some((message) => message.content === STATIC_QA_SYSTEM_PROMPT);
  stats.userPlaceholderSeen ||= userText.includes('{{user}}');
  stats.charPlaceholderSeen ||= userText.includes('{{char}}');

  if (hasExcludedMarker) {
    stats.markerViolationRequests += 1;
    stats.failureResponses += 1;
    sendMarkerLeak(response);
    return;
  }

  stats.lastRequestUsedExpectedModel = body.model === MOCK_MODEL;
  const safeNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
  stats.lastGeneration = {
    model: typeof body.model === 'string' ? body.model : null,
    temperature: safeNumber(body.temperature), topP: safeNumber(body.top_p),
    frequencyPenalty: safeNumber(body.frequency_penalty), presencePenalty: safeNumber(body.presence_penalty),
    maxTokens: safeNumber(body.max_tokens),
  };

  if (control.mode === 'failure') {
    stats.failureResponses += 1;
    sendJson(response, control.failureStatus, {
      error: { message: 'Synthetic local QA failure.', type: 'server_error', code: 'qa_mock_failure' },
    });
    return;
  }
  if (control.mode === 'delay') {
    stats.delayedResponses += 1;
    await new Promise((resolve) => setTimeout(resolve, control.delayMs));
    if (response.destroyed) return;
  }

  const generated = buildMockAnswer(userText);
  const truncated = control.mode === 'length';
  const completion = truncated ? generated.slice(0, Math.min(generated.length, 96)) : generated;
  if (truncated) stats.lengthResponses += 1;
  else stats.stopResponses += 1;
  sendJson(response, 200, {
    id: `chatcmpl-qa-${stats.requestCount}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1_000),
    model: MOCK_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: completion }, finish_reason: truncated ? 'length' : 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

function sendMarkerLeak(response: ServerResponse): void {
  sendJson(response, 422, {
    error: {
      message: 'An excluded synthetic QA marker reached the local model request.',
      type: 'invalid_request_error',
      code: 'qa_exclusion_marker_leak',
    },
  });
}

function buildMockAnswer(userText: string): string {
  const availableRefs = [...new Set(userText.match(/\[S\d+\]/gu) ?? [])];
  const blocks = parseSourceBlocks(userText);
  const question = findUserQuestion(userText);
  if (question) return buildFollowUpAnswer(userText, question, blocks, availableRefs);

  const lines = ['【本地模拟模型回复，仅用于软件验收，不代表真实模型效果】'];
  const keeperBlock = blocks.find((block) => /角色设定与经历/u.test(block.label))
    ?? blocks.find((block) => /lighthouse keeper|灯塔看守|灯塔守望/iu.test(block.text));
  const scenarioBlock = blocks.find((block) => /背景与当前情境/u.test(block.label));
  const personalityBlock = blocks.find((block) => /性格/u.test(block.label));
  const worldBlocks = blocks.filter((block) => /世界书/u.test(block.label));
  const allText = userText;

  if (/lighthouse keeper|keeper of the .*lighthouse|灯塔看守|灯塔守望/iu.test(allText)) {
    lines.push(`**人物与经历：**Mara 是 Greyglass 灯塔的看守人；她离开海岸救援队后接下这份工作，并用守望日志保存日期和旧事。${citationFor(keeperBlock, allText, /lighthouse keeper|灯塔看守|灯塔守望/iu, availableRefs)}`);
  }
  if (/\bStorm\b/iu.test(allText) && /disappeared|vanished|missing|失踪/iu.test(allText)) {
    lines.push(`**重要经历：**Storm 是 Mara 过去的亲密朋友，在一次冬季风暴中失踪；资料没有确认 Storm 后来的下落或生死，不应把猜测说成事实。${citationFor(keeperBlock, allText, /Storm|失踪/iu, availableRefs)}`);
  }
  if (/old colleague|former colleague|旧同事|以前的同事/iu.test(allText)) {
    lines.push(`**玩家身份与关系：**{{user}} 是 Mara 曾在海岸救援队共事的旧同事，不是初次见面的陌生人。${citationFor(scenarioBlock, allText, /old colleague|旧同事/iu, availableRefs)}`);
  }
  if (personalityBlock && /reserved|observant|records|blames herself|克制|观察|日志/iu.test(personalityBlock.text)) {
    lines.push(`**性格线索：**她谨慎、重视日期记录；谈到 Storm 失踪的那晚时会回避，但仍保留着对方的位置。${citationFor(personalityBlock, allText, /性格/u, availableRefs)}`);
  }

  const permanent = worldBlocks.find((block) => /常驻|始终启用/u.test(block.status));
  const disabled = worldBlocks.find((block) => /已禁用/u.test(block.status));
  const conditional = worldBlocks.find((block) => /条件|关键词触发/u.test(block.status));
  if (permanent) {
    lines.push(`**常驻规则：**灯塔的灯日落后必须持续点亮，这是始终启用的规则。${citationFor(permanent, allText, /常驻规则|灯塔的灯/iu, availableRefs)}`);
  }
  if (disabled) {
    lines.push(`**禁用草稿：**其中有“幽灵带走 Storm”的传闻，但对应条目已禁用，不能当作当前设定或事实。${citationFor(disabled, allText, /禁用草稿|幽灵|disabled/iu, availableRefs)}`);
  }
  if (conditional) {
    lines.push(`**条件设定：**风暴铃连续响三次时，旧礁石救援路线才会开放一晚；这是有条件的分支，不是一直生效的规则，也不能据此推断 Storm 的命运。${citationFor(conditional, allText, /条件设定|风暴铃|conditional/iu, availableRefs)}`);
  }

  if (lines.length === 1) {
    const fallback = availableRefs[0];
    lines.push(`本段已收到资料，但没有包含灯塔经历、关系或世界书规则；模拟器不补写未出现在本段的设定。${fallback ? ` ${fallback}` : ''}`);
  }
  return lines.join('\n\n');
}

function buildFollowUpAnswer(
  userText: string,
  question: string,
  blocks: SourceBlock[],
  availableRefs: string[],
): string {
  const normalizedQuestion = question.toLocaleLowerCase();
  const lines = ['【本地模拟模型回复，仅用于软件验收，不代表真实模型效果】'];
  const keeperBlock = blocks.find((block) => /角色设定与经历/u.test(block.label))
    ?? blocks.find((block) => /Storm|lighthouse keeper|灯塔/iu.test(block.text));
  const scenarioBlock = blocks.find((block) => /背景与当前情境/u.test(block.label));

  if (/storm|朋友|friend|失踪|下落|生死/iu.test(normalizedQuestion)) {
    if (/\bStorm\b/iu.test(userText) && /disappeared|vanished|missing|失踪/iu.test(userText)) {
      lines.push(`Storm 是 Mara 的旧友，曾与她一起参与海岸救援；Storm 在冬季风暴中失踪。原文没有说明后续，因此不能断言 Storm 已死亡或获救。${citationFor(keeperBlock, userText, /Storm|失踪/iu, availableRefs)}`);
    } else {
      lines.push('本次送到模型的原文分段没有找到关于 Storm 失踪或下落的依据；模拟器不从其他未送入的分段补答案。');
    }
  } else if (/我是谁|玩家|user|旧同事|关系|关系是什么/iu.test(normalizedQuestion)) {
    if (/old colleague|former colleague|旧同事|以前的同事/iu.test(userText)) {
      lines.push(`你是 Mara 在海岸救援队时的旧同事；重逢时她认得你，但还不确定能否把 Storm 的事告诉你。${citationFor(scenarioBlock, userText, /old colleague|旧同事/iu, availableRefs)}`);
    } else {
      lines.push('本次送到模型的原文分段没有交代玩家与角色的关系。');
    }
  } else if (/常驻|禁用|条件|世界书|规则/iu.test(normalizedQuestion)) {
    const ruleBlock = blocks.find((block) => /世界书/u.test(block.label));
    if (/常驻|始终/u.test(userText)) lines.push(`常驻规则是灯塔的灯必须在日落后持续点亮。${citationFor(ruleBlock, userText, /常驻|始终启用/iu, availableRefs)}`);
    if (/已禁用|disabled/iu.test(userText)) lines.push(`幽灵传闻所在条目已禁用，不应当作为当前生效设定。${citationFor(ruleBlock, userText, /已禁用|disabled/iu, availableRefs)}`);
    if (/条件|关键词触发/iu.test(userText)) lines.push(`风暴铃连续响三次时，旧礁石救援路线才开放一晚；它是条件分支。${citationFor(ruleBlock, userText, /条件|关键词触发/iu, availableRefs)}`);
  } else {
    const fallback = availableRefs[0];
    lines.push(`就目前送入的原文，Mara 的核心牵挂是朋友 Storm 失踪一事；没有依据的部分会明确留空。${fallback ? ` ${fallback}` : ''}`);
  }

  return lines.join('\n\n');
}

function parseSourceBlocks(text: string): SourceBlock[] {
  const pattern = /(?:^|\n)\[(S\d+)\]\s+([^\n]*)(?:\n资料状态：([^\n]*))?\n/gu;
  const matches = [...text.matchAll(pattern)];
  return matches.map((match, index) => {
    const full = match[0] ?? '';
    const start = (match.index ?? 0) + (full.startsWith('\n') ? 1 : 0);
    const bodyStart = (match.index ?? 0) + full.length;
    const nextFull = matches[index + 1];
    const next = nextFull?.index ?? text.length;
    const label = match[2] ?? '';
    return {
      id: match[1] ?? '',
      label,
      status: match[3] ?? '',
      text: text.slice(bodyStart, next).trim(),
      start,
    } as SourceBlock & { start: number };
  });
}

function citationFor(
  block: SourceBlock | undefined,
  fullText: string,
  nearbyFact: RegExp,
  availableRefs: string[],
): string {
  if (block) {
    const reference = `[${block.id}]`;
    if (availableRefs.includes(reference)) return ` ${reference}`;
  }
  const nearby = citationNearLastMatch(fullText, nearbyFact, availableRefs);
  return nearby ? ` ${nearby}` : '';
}

function citationNearLastMatch(text: string, pattern: RegExp, availableRefs: string[]): string {
  const flags = [...new Set(`${pattern.flags.replace(/[gy]/gu, '')}g`)].join('');
  const globalPattern = new RegExp(pattern.source, flags);
  const matches = [...text.matchAll(globalPattern)];
  const match = matches.at(-1);
  if (!match || match.index === undefined) return '';
  const start = match.index;
  const paragraphEnd = text.indexOf('\n\n', start);
  const snippet = text.slice(start, paragraphEnd < 0 ? Math.min(text.length, start + 700) : paragraphEnd);
  const references = snippet.match(/\[S\d+\]/gu) ?? [];
  return references.find((reference) => availableRefs.includes(reference)) ?? '';
}

function findUserQuestion(text: string): string {
  const direct = text.match(/用户问题：([^\n]+)/u)?.[1];
  if (direct) return direct.trim();
  const summary = text.match(/请根据用户问题[“"]([^”"\n]+)[”"]/u)?.[1];
  return summary?.trim() ?? '';
}

function userMessageText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter(isRecord)
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .filter(Boolean)
    .join('\n\n');
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (typeof part.text === 'string') return [part.text];
    if (typeof part.content === 'string') return [part.content];
    return [];
  }).join('\n');
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('not-an-object');
  return value;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function seedIsolatedSillyTavern(baseUrl: string): Promise<Record<string, unknown>> {
  assertAllowedSeedTarget(baseUrl);
  const versionResponse = await fetch(`${baseUrl}/version`);
  const version = await readJsonResponse<STVersion>(versionResponse, '读到指定隔离酒馆的版本');
  if (version.pkgVersion !== EXPECTED_ST_VERSION || !version.gitRevision?.startsWith(EXPECTED_ST_REVISION_PREFIX)) {
    throw new Error('Seed target did not match the expected isolated SillyTavern version and release revision. No seed writes were made.');
  }

  const session = await getSTSession(baseUrl);
  const suffix = new Date().toISOString().replace(/[-:.TZ]/gu, '') + `-${process.pid}`;
  const primaryName = `Reader QA Primary ${suffix}`;
  const extraName = `Reader QA Extra ${suffix}`;
  const unrelatedName = `Reader QA Unlinked ${suffix}`;

  const primary = await importWorldbookFixture(baseUrl, primaryName, '../tests/fixtures/tavern/reader-extension-primary-worldbook.json', session);
  const extra = await importWorldbookFixture(baseUrl, extraName, '../tests/fixtures/tavern/reader-extension-extra-worldbook.json', session);
  const unrelated = await importWorldbookFixture(baseUrl, unrelatedName, '../tests/fixtures/tavern/reader-extension-unrelated-worldbook.json', session);

  const card = readFixture('../tests/fixtures/tavern/reader-extension-card.json');
  const data = requireRecord(card.data, 'Synthetic fixture card data');
  const cardName = `Mara Reader QA ${suffix}`;
  data.name = cardName;
  const extensions = isRecord(data.extensions) ? data.extensions : {};
  extensions.world = primary;
  data.extensions = extensions;
  card.data = data;

  const form = new FormData();
  form.append('file_type', 'json');
  form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), `${cardName}.json`);
  const importedCard = await postForm<ImportCharacterResult>(baseUrl, '/api/characters/import', form, session, '导入虚构验收角色卡');
  if (!importedCard.file_name) throw new Error('SillyTavern did not return the synthetic card file name.');
  const avatarBase = path.parse(importedCard.file_name).name;
  const avatarUrl = importedCard.file_name.endsWith('.png') ? importedCard.file_name : `${importedCard.file_name}.png`;

  await bindExtraWorldbook(baseUrl, avatarBase, extra, session);
  await verifySeed(baseUrl, avatarUrl, avatarBase, primary, extra, unrelated, session);

  return {
    seedResult: 'PASS',
    sillyTavern: `${version.pkgVersion} (${version.gitRevision})`,
    isolatedTarget: baseUrl,
    syntheticCard: cardName,
    avatarFile: avatarUrl,
    primaryWorldbook: primary,
    extraWorldbook: extra,
    intentionallyUnlinkedWorldbook: unrelated,
    contents: 'fictional lighthouse setting only',
    bindings: ['primary via card data.extensions.world', 'extra via QA user world_info_settings.world_info.charLore', 'unlinked book intentionally not attached'],
  };
}

async function importWorldbookFixture(
  baseUrl: string,
  name: string,
  fixturePath: string,
  session: STSession,
): Promise<string> {
  const worldbook = readFixture(fixturePath);
  worldbook.name = name;
  const form = new FormData();
  form.append('avatar', new Blob([JSON.stringify(worldbook)], { type: 'application/json' }), `${name}.json`);
  const result = await postForm<ImportWorldbookResult>(baseUrl, '/api/worldinfo/import', form, session, '导入虚构验收世界书');
  if (!result.name) throw new Error('SillyTavern did not return an imported worldbook name.');
  return result.name;
}

async function bindExtraWorldbook(
  baseUrl: string,
  avatarBase: string,
  extraWorldbook: string,
  session: STSession,
): Promise<void> {
  const response = await postJson<{ settings?: string }>(baseUrl, '/api/settings/get', {}, session, '读取隔离 QA 用户设置');
  if (typeof response.settings !== 'string') throw new Error('QA SillyTavern user settings were not returned as JSON text.');
  const settings = requireRecord(JSON.parse(response.settings) as unknown, 'QA SillyTavern user settings');
  const worldInfoSettings = worldInfoSettingsFor(settings);
  const worldInfo = requireWorldInfoObject(worldInfoSettings);
  const charLore = Array.isArray(worldInfo.charLore) ? worldInfo.charLore.filter(isRecord) : [];
  const existing = charLore.find((entry) => entry.name === avatarBase);
  const existingBooks = Array.isArray(existing?.extraBooks)
    ? existing.extraBooks.filter((value): value is string => typeof value === 'string')
    : [];
  const nextEntry = { ...(existing ?? {}), name: avatarBase, extraBooks: [...new Set([...existingBooks, extraWorldbook])] };
  worldInfo.charLore = [...charLore.filter((entry) => entry.name !== avatarBase), nextEntry];
  worldInfoSettings.world_info = worldInfo;
  if (worldInfoSettings !== settings && isRecord(settings.world_info) && Array.isArray(settings.world_info.charLore)) {
    settings.world_info.charLore = settings.world_info.charLore.filter(
      (entry) => !isRecord(entry) || entry.name !== avatarBase,
    );
  }
  await postJson(baseUrl, '/api/settings/save', settings, session, '绑定额外世界书到虚构验收卡');
}

async function verifySeed(
  baseUrl: string,
  avatarUrl: string,
  avatarBase: string,
  primaryWorldbook: string,
  extraWorldbook: string,
  unrelatedWorldbook: string,
  session: STSession,
): Promise<void> {
  const cardResult = await postJson<Record<string, unknown>>(
    baseUrl,
    '/api/characters/get',
    { avatar_url: avatarUrl },
    session,
    '确认虚构验收卡主世界书绑定',
  );
  const card = typeof cardResult.json_data === 'string'
    ? requireRecord(JSON.parse(cardResult.json_data) as unknown, 'Imported QA card')
    : cardResult;
  const data = isRecord(card.data) ? card.data : {};
  const extensions = isRecord(data.extensions) ? data.extensions : {};
  if (extensions.world !== primaryWorldbook) throw new Error('The synthetic card did not retain its primary worldbook binding.');
  if (typeof data.creator_notes !== 'string' || !data.creator_notes.includes(AUTHOR_NOTES_MARKER)) {
    throw new Error('The synthetic card is missing its author-notes exclusion marker.');
  }
  if (!Array.isArray(data.tags) || !data.tags.includes(METADATA_TAGS_MARKER)) {
    throw new Error('The synthetic card is missing its metadata-tags exclusion marker.');
  }

  const settingsResult = await postJson<{ settings?: string }>(baseUrl, '/api/settings/get', {}, session, '确认 QA 额外世界书绑定');
  if (typeof settingsResult.settings !== 'string') throw new Error('Could not verify QA worldbook bindings.');
  const settings = requireRecord(JSON.parse(settingsResult.settings) as unknown, 'QA SillyTavern user settings');
  const worldInfoSettings = worldInfoSettingsFor(settings);
  const worldInfo = requireWorldInfoObject(worldInfoSettings);
  const charLore = Array.isArray(worldInfo.charLore) ? worldInfo.charLore.filter(isRecord) : [];
  const binding = charLore.find((entry) => entry.name === avatarBase);
  const extraBooks = Array.isArray(binding?.extraBooks) ? binding.extraBooks : [];
  if (!extraBooks.includes(extraWorldbook)) throw new Error('The synthetic card did not retain its extra worldbook binding.');
  if (extraBooks.includes(unrelatedWorldbook)) throw new Error('The unrelated QA worldbook was unexpectedly linked.');

  for (const name of [primaryWorldbook, extraWorldbook, unrelatedWorldbook]) {
    const result = await postJson<Record<string, unknown>>(baseUrl, '/api/worldinfo/get', { name }, session, '确认虚构验收世界书已导入');
    if (!isRecord(result.entries) || Object.keys(result.entries).length === 0) {
      throw new Error('An expected synthetic QA worldbook is missing its entries.');
    }
  }
}

async function getSTSession(baseUrl: string): Promise<STSession> {
  const response = await fetch(`${baseUrl}/csrf-token`);
  const payload = await readJsonResponse<{ token?: string }>(response, '读取隔离酒馆 CSRF token');
  if (!payload.token) throw new Error('Isolated SillyTavern did not return a CSRF token.');
  const cookies = new Map<string, string>();
  mergeResponseCookies(response, cookies);
  if (cookies.size === 0) throw new Error('Isolated SillyTavern did not return a temporary session cookie.');
  return { cookies, csrfToken: payload.token };
}

async function postJson<T>(
  baseUrl: string,
  pathname: string,
  payload: unknown,
  session: STSession,
  label: string,
): Promise<T> {
  return await post<T>(baseUrl, pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, session, label);
}

async function postForm<T>(
  baseUrl: string,
  pathname: string,
  form: FormData,
  session: STSession,
  label: string,
): Promise<T> {
  return await post<T>(baseUrl, pathname, { method: 'POST', body: form }, session, label);
}

async function post<T>(
  baseUrl: string,
  pathname: string,
  init: RequestInit,
  session: STSession,
  label: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', [...session.cookies.values()].join('; '));
  headers.set('x-csrf-token', session.csrfToken);
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  mergeResponseCookies(response, session.cookies);
  return await readJsonResponse<T>(response, label);
}

async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function mergeResponseCookies(response: Response, target: Map<string, string>): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  for (const header of setCookies) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) target.set(pair.slice(0, separator), pair);
  }
}

function readFixture(relativePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
  return requireRecord(parsed, 'Synthetic QA fixture');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object.`);
  return value;
}

function worldInfoSettingsFor(settings: Record<string, unknown>): Record<string, unknown> {
  return isRecord(settings.world_info_settings) ? settings.world_info_settings : settings;
}

function requireWorldInfoObject(settings: Record<string, unknown>): Record<string, unknown> {
  if (settings.world_info === undefined) {
    const worldInfo: Record<string, unknown> = {};
    settings.world_info = worldInfo;
    return worldInfo;
  }
  return requireRecord(settings.world_info, 'SillyTavern world_info settings');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stopServer(): void {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
}

async function closeServer(): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 240);
}

await main();
