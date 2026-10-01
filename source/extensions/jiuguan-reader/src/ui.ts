import { DEFAULT_ANALYSIS_PROMPT, DEFAULT_QUICK_QUESTIONS, normalizeReaderSettings } from './settings.js';
import { renderReadingText } from './render.js';
import { READER_EXTENSION_VERSION } from './updater.js';
import type { ReaderController, ReaderState } from './controller.js';
import type { ExtensionUpdater } from './updater.js';
import type { ReaderHost, ReaderSettings, ReaderSource } from './types.js';

export class ReaderView {
  private readonly panel = makeDialog('jgr-reader-dialog', '角色卡解读');
  private readonly settingsPanel = makeDialog('jgr-settings-dialog', '读卡设置');
  private readonly sourcePanel = makeDialog('jgr-source-dialog', '原文来源');
  private readonly title = element('strong', 'jgr-title', '酒馆读卡');
  private readonly status = element('div', 'jgr-status');
  private readonly error = element('div', 'jgr-error');
  private readonly scope = element('details', 'jgr-scope');
  private readonly scopeSummary = element('summary', '', '读取范围');
  private readonly scopeBody = element('div', 'jgr-scope-body');
  private readonly metadata = element('div', 'jgr-muted');
  private readonly readButton = button('生成解读', 'jgr-primary');
  private readonly cancelButton = button('停止');
  private readonly saveButton = button('保存');
  private readonly tabs = element('div', 'jgr-tabs');
  private readonly analysisTab = button('解读');
  private readonly answersTab = button('追问');
  private readonly analysisBody = element('div', 'jgr-output');
  private readonly answersBody = element('div', 'jgr-output');
  private readonly questions = element('div', 'jgr-quick-questions');
  private readonly questionInput = element('textarea', 'jgr-question-input');
  private readonly askButton = button('提问', 'jgr-primary');
  private readonly systemInput = element('textarea', 'jgr-prompt-input');
  private readonly analysisInput = element('textarea', 'jgr-prompt-input');
  private readonly connectionMode = element('select');
  private readonly profileInput = element('select');
  private readonly contextInput = element('input');
  private readonly outputInput = element('input');
  private readonly shortcutsInput = element('textarea');
  private readonly settingsStatus = element('div', 'jgr-status');
  private settingsDirty = false;
  private view: 'analysis' | 'answers' = 'analysis';
  private previousRecord: ReaderState['record'] | undefined;
  private previousDocument: ReaderState['document'] = null;
  private currentCharacter = '';
  private readonly questionDrafts = new Map<string, string>();
  private updateRequestPending = false;
  private readonly updateControlRenderers = new Set<() => void>();

  constructor(
    private readonly controller: ReaderController,
    private readonly host: ReaderHost,
    private readonly updater: ExtensionUpdater,
  ) {
    this.buildPanel();
    this.buildSettings();
    this.buildSourcePanel();
    document.body.append(this.panel, this.settingsPanel, this.sourcePanel);
    controller.subscribe((state) => this.render(state));
    window.addEventListener('beforeunload', (event) => {
      if (!this.hasUnsavedInput()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  isOpen(): boolean { return this.panel.open; }

  async open(): Promise<void> {
    if (!this.panel.open) this.panel.showModal();
    await this.controller.loadCurrent();
  }

  openSettings(): void {
    this.updateProfiles();
    if (!this.settingsDirty) this.fillSettings(this.host.getSettings());
    if (!this.settingsPanel.open) this.settingsPanel.showModal();
  }

  createUpdateControls(): HTMLElement {
    const controls = element('section', 'jgr-update-controls');
    controls.append(element('p', 'jgr-muted', `当前版本：${READER_EXTENSION_VERSION}`));
    controls.append(element('p', 'jgr-muted', '更新直接在这里下载，不另开弹窗。刷新前请保存酒馆其他未提交的输入。'));

    const actions = element('div', 'jgr-update-actions');
    const updateButton = button('一键更新', 'jgr-primary');
    const reloadButton = button('刷新页面', 'jgr-primary');
    reloadButton.title = '重新载入整个酒馆页面，应用已下载的更新；请先保存其他输入。';
    reloadButton.hidden = true;
    actions.append(updateButton, reloadButton);
    const status = element('p', 'jgr-update-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    const feedback = element('p', 'jgr-update-warning');
    feedback.setAttribute('role', 'alert');
    feedback.hidden = true;
    controls.append(actions, status, feedback);

    const render = (state: ReturnType<ExtensionUpdater['getState']> = this.updater.getState()): void => {
      updateButton.disabled = this.updateRequestPending || state.phase === 'checking' || state.phase === 'updating' || state.phase === 'updated';
      updateButton.textContent = state.phase === 'checking' ? '正在检查更新…'
        : state.phase === 'updating' ? '正在下载更新…'
          : state.phase === 'current' ? '重新检查更新'
            : state.phase === 'updated' ? '已下载更新'
              : state.phase === 'error' ? '重试更新' : '一键更新';
      reloadButton.hidden = state.phase !== 'updated';
      reloadButton.disabled = this.updateRequestPending;
      status.textContent = state.message;
      status.hidden = !state.message.trim();
    };
    this.updateControlRenderers.add(render);
    this.updater.subscribe((state) => render(state));
    render();

    updateButton.addEventListener('click', () => { void this.requestExtensionUpdate(feedback); });
    reloadButton.addEventListener('click', () => this.reloadAfterUpdate(feedback));
    return controls;
  }

  private buildPanel(): void {
    const header = element('div', 'jgr-header');
    const settings = button('设置');
    settings.addEventListener('click', () => this.openSettings());
    header.append(this.title, settings, closeButton(this.panel));
    const scroll = element('div', 'jgr-scroll');
    const intro = element('div', 'jgr-muted', '读人物设定、经历与关联世界书 · 不读开场白或作者注释');
    this.scope.append(this.scopeSummary, this.scopeBody);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.error.setAttribute('role', 'alert');
    const actions = element('div', 'jgr-actions');
    this.readButton.addEventListener('click', () => { this.view = 'analysis'; void this.controller.read(); });
    this.cancelButton.addEventListener('click', () => this.controller.cancel());
    this.saveButton.addEventListener('click', () => { void this.controller.save(); });
    actions.append(this.readButton, this.cancelButton, this.saveButton);
    this.analysisTab.addEventListener('click', () => { this.view = 'analysis'; this.renderTabs(); });
    this.answersTab.addEventListener('click', () => { this.view = 'answers'; this.renderTabs(); });
    this.tabs.append(this.analysisTab, this.answersTab);
    this.questionInput.rows = 2;
    this.questionInput.placeholder = '还想知道什么？可以直接问…';
    this.questionInput.setAttribute('aria-label', '向读卡助手提问');
    this.questionInput.addEventListener('input', () => { this.questionDrafts.set(this.currentCharacter, this.questionInput.value); });
    this.questionInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.askCurrent();
      }
    });
    this.askButton.addEventListener('click', () => this.askCurrent());
    const askRow = element('div', 'jgr-ask-row');
    askRow.append(this.questionInput, this.askButton);
    const questionArea = element('div', 'jgr-question-area');
    questionArea.append(this.questions, askRow, element('div', 'jgr-muted', '解读和回答自动保存，不会写入聊天。⌘ / Ctrl + Enter 提问。'));
    scroll.append(intro, this.scope, actions, this.status, this.error, this.metadata, this.tabs, this.analysisBody, this.answersBody, questionArea);
    this.panel.append(header, scroll);
  }

  private buildSettings(): void {
    const header = element('div', 'jgr-header');
    header.append(element('strong', 'jgr-title', '读卡设置'), closeButton(this.settingsPanel));
    const form = element('form', 'jgr-scroll jgr-settings-form');
    this.connectionMode.id = 'jgr-connection-mode';
    this.connectionMode.append(option('current', '跟随酒馆当前 API'), option('profile', '独立连接：酒馆已保存的配置'));
    this.profileInput.id = 'jgr-connection-profile';
    this.connectionMode.addEventListener('change', () => { this.settingsDirty = true; this.updateProfileVisibility(); });
    form.append(field('API 连接', this.connectionMode));
    form.append(field('独立连接配置', this.profileInput));
    form.append(element('p', 'jgr-muted', '独立连接请先在酒馆“连接配置”中保存，再在这里选用。读卡不会切换聊天连接，也不复制或保存 API Key。'));
    this.systemInput.id = 'jgr-system-prompt';
    this.systemInput.rows = 5;
    this.analysisInput.id = 'jgr-analysis-prompt';
    this.analysisInput.rows = 8;
    form.append(field('系统提示词', this.systemInput));
    form.append(element('p', 'jgr-muted', '非空时原样作为唯一 system 消息；清空则不发送系统提示词。不会写入角色卡。'));
    const promptLabel = field('读卡提示词', this.analysisInput);
    const restore = button('恢复默认读卡提示词');
    restore.id = 'jgr-restore-prompt';
    restore.addEventListener('click', () => {
      this.analysisInput.value = DEFAULT_ANALYSIS_PROMPT;
      this.settingsDirty = true;
      this.settingsStatus.textContent = '已恢复默认读卡提示词，点击“保存设置”后生效。系统提示词没有改动。';
    });
    promptLabel.append(restore);
    form.append(promptLabel);
    const advanced = element('details', 'jgr-scope');
    advanced.append(element('summary', '', '分块与快捷问题'));
    for (const input of [this.contextInput, this.outputInput]) { input.type = 'number'; input.min = '1'; input.step = '1'; }
    this.contextInput.id = 'jgr-context-chars';
    this.outputInput.id = 'jgr-output-tokens';
    this.shortcutsInput.id = 'jgr-shortcuts';
    this.shortcutsInput.rows = 4;
    advanced.append(field('单次请求文字预算（字符，非精确 token）', this.contextInput), field('单次最大输出 token', this.outputInput), field('快捷问题（每行一个，可自由修改）', this.shortcutsInput));
    advanced.append(element('p', 'jgr-muted', '长卡与大世界书会完整分段读取，可能产生多次请求。不自动截断资料或提示词。'));
    const save = button('保存设置', 'jgr-primary');
    save.type = 'submit';
    save.id = 'jgr-save-settings';
    form.append(advanced, this.settingsStatus, save);
    form.addEventListener('input', () => { this.settingsDirty = true; this.settingsStatus.textContent = '有未保存的修改；关闭设置后输入仍保留。'; });
    form.addEventListener('change', () => { this.settingsDirty = true; });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveSettings(save);
    });
    this.fillSettings(this.host.getSettings());
    this.settingsPanel.append(header, form);
  }

  private buildSourcePanel(): void {
    const header = element('div', 'jgr-header');
    header.append(element('strong', 'jgr-title', '原文来源'), closeButton(this.sourcePanel));
    this.sourcePanel.append(header, element('div', 'jgr-scroll jgr-source-content'));
  }

  private render(state: ReaderState): void {
    this.title.textContent = state.document
      ? `读卡 · ${state.document.characterName}`
      : state.record ? `已存解读 · ${state.record.characterName}` : '酒馆读卡';
    this.readButton.textContent = state.record ? '重新解读' : '生成解读';
    this.readButton.title = state.record ? '成功后替换当前解读及追问；失败或停止保留旧结果。' : '主动生成才会调用模型，完成后自动保存。';
    this.readButton.disabled = !state.document || state.loading || state.busy || state.unsaved;
    this.cancelButton.hidden = !state.busy || state.unsaved;
    this.saveButton.hidden = !state.unsaved;
    this.saveButton.disabled = state.busy;
    const progress = state.progress;
    this.status.textContent = progress
      ? `${progress.phase === 'reading' ? '读取资料' : '汇总解读'}：${progress.completed} / ${progress.total} 段，${progress.sourceCount} 项来源`
      : state.status;
    this.error.textContent = state.error;
    this.error.hidden = !state.error;
    this.metadata.textContent = state.record
      ? `${state.unsaved ? '尚未保存' : '已保存'} · ${new Date(state.record.readAt).toLocaleString()} · ${state.record.model}`
      : '';
    const stale = Boolean(state.document && state.record && state.document.fingerprint !== state.record.fingerprint);
    if (stale) this.metadata.textContent += ' · 设定已变化，当前显示旧解读';
    if (state.document !== this.previousDocument) {
      const characterKey = state.document?.characterKey ?? '';
      if (characterKey !== this.currentCharacter) {
        this.questionDrafts.set(this.currentCharacter, this.questionInput.value);
        this.currentCharacter = characterKey;
        this.questionInput.value = this.questionDrafts.get(characterKey) ?? '';
        this.view = 'analysis';
      }
      this.renderScope(state);
      this.previousDocument = state.document;
    }
    if (state.record !== this.previousRecord) {
      this.renderRecord(state);
      this.previousRecord = state.record;
    }
    const canAsk = Boolean(state.record && state.document && !state.loading && !state.busy && !state.unsaved && !stale);
    this.askButton.disabled = !canAsk;
    this.questionInput.disabled = !canAsk;
    this.renderQuestions(canAsk);
    this.tabs.hidden = !state.record;
    this.answersTab.textContent = `追问${state.record?.answers.length ? ` · ${state.record.answers.length}` : ''}`;
    this.renderTabs();
  }

  private renderScope(state: ReaderState): void {
    const document = state.document;
    this.scopeSummary.textContent = document ? `读取范围：${document.sources.length} 项资料 · ${document.worldbooks.length} 本关联世界书` : '读取范围';
    this.scopeBody.replaceChildren();
    if (!document) return;
    const books = document.worldbooks.length ? `关联世界书：${document.worldbooks.join('、')}` : '未找到角色关联的外部世界书；卡内世界书仍会读取。';
    this.scopeBody.append(element('p', '', books), element('p', '', '不读取开场白、作者注释、标签等管理信息、聊天记录或无关的全局世界书；不执行卡片脚本。'));
    for (const warning of document.warnings) this.scopeBody.append(element('p', 'jgr-warning', warning));
    const list = element('ul');
    for (const source of document.sources) {
      const item = element('li');
      const open = button(`${source.id} ${source.label}`, 'jgr-source-link');
      open.addEventListener('click', () => this.showSource(source));
      item.append(open);
      list.append(item);
    }
    this.scopeBody.append(list);
  }

  private renderRecord(state: ReaderState): void {
    const record = state.record;
    this.analysisBody.replaceChildren();
    this.answersBody.replaceChildren();
    if (!record) {
      this.analysisBody.append(element('div', 'jgr-empty', '生成一份中文说明，了解这张卡的人物经历、关系和玩法。读过后，下次直接查看。'));
      return;
    }
    this.analysisBody.append(renderReadingText(record.analysis, record.sources, (source) => this.showSource(source)));
    if (!record.answers.length) this.answersBody.append(element('p', 'jgr-muted', '可以点下面的快捷问题，也可以自己提问。'));
    for (const answer of record.answers) {
      const item = element('section', 'jgr-answer');
      item.append(element('strong', '', answer.question), renderReadingText(answer.answer, record.sources, (source) => this.showSource(source)));
      this.answersBody.append(item);
    }
  }

  private renderQuestions(enabled: boolean): void {
    const questions = this.host.getSettings().quickQuestions;
    const signature = JSON.stringify(questions);
    if (this.questions.dataset.questions !== signature) {
      this.questions.dataset.questions = signature;
      this.questions.replaceChildren();
      questions.forEach((question, index) => {
        const labels = ['重要经历', '人物关系', '隐藏设定', '玩法规则'];
        const label = question === DEFAULT_QUICK_QUESTIONS[index] ? labels[index] : question.length > 18 ? `${question.slice(0, 18)}…` : question;
        const shortcut = button(label, 'jgr-question-chip');
        shortcut.title = question;
        shortcut.addEventListener('click', () => {
          this.questionInput.value = question;
          this.questionDrafts.set(this.currentCharacter, question);
          this.askCurrent();
        });
        this.questions.append(shortcut);
      });
    }
    this.questions.querySelectorAll('button').forEach((button) => { button.disabled = !enabled; });
  }

  private renderTabs(): void {
    this.analysisTab.setAttribute('aria-pressed', String(this.view === 'analysis'));
    this.answersTab.setAttribute('aria-pressed', String(this.view === 'answers'));
    this.analysisBody.hidden = this.view !== 'analysis';
    this.answersBody.hidden = this.view !== 'answers';
  }

  private askCurrent(): void {
    if (this.askButton.disabled || !this.questionInput.value.trim()) return;
    const question = this.questionInput.value;
    const character = this.currentCharacter;
    const previousCount = this.controller.getState().record?.answers.length ?? 0;
    this.view = 'answers';
    void this.controller.question(question).then(() => {
      const state = this.controller.getState();
      if (state.document?.characterKey === character && (state.record?.answers.length ?? 0) > previousCount && this.questionInput.value === question) {
        this.questionInput.value = '';
        this.questionDrafts.set(character, '');
      }
    });
  }

  private showSource(source: ReaderSource): void {
    const content = this.sourcePanel.querySelector('.jgr-source-content')!;
    content.replaceChildren(element('h4', '', `${source.id} ${source.label}`));
    if (source.note) content.append(element('p', 'jgr-muted', source.note));
    content.append(element('pre', 'jgr-original', source.text));
    if (!this.sourcePanel.open) this.sourcePanel.showModal();
  }

  private fillSettings(settings: ReaderSettings): void {
    this.systemInput.value = settings.systemPrompt;
    this.analysisInput.value = settings.analysisPrompt;
    this.connectionMode.value = settings.connection.mode;
    this.updateProfiles();
    this.profileInput.value = settings.connection.profileId;
    this.contextInput.value = String(settings.contextChars);
    this.outputInput.value = String(settings.maxOutputTokens);
    this.shortcutsInput.value = settings.quickQuestions.join('\n');
    this.settingsDirty = false;
    this.updateProfileVisibility();
  }

  private updateProfiles(): void {
    const selection = this.profileInput.value || this.host.getSettings().connection.profileId;
    this.profileInput.replaceChildren(option('', '请选择酒馆已保存的连接'));
    const profiles = this.host.getProfiles();
    for (const profile of profiles) this.profileInput.append(option(profile.id, profile.name));
    if (selection && !profiles.some((profile) => profile.id === selection)) this.profileInput.append(option(selection, '原连接已不存在，请重新选择'));
    this.profileInput.value = selection;
  }

  private updateProfileVisibility(): void {
    this.profileInput.closest('label')!.hidden = this.connectionMode.value !== 'profile';
  }

  private async saveSettings(save: HTMLButtonElement): Promise<void> {
    if (!this.contextInput.checkValidity() || !this.outputInput.checkValidity()) {
      this.settingsStatus.textContent = '分块预算和输出 token 请填写正整数。';
      return;
    }
    const raw = {
      systemPrompt: this.systemInput.value,
      analysisPrompt: this.analysisInput.value,
      connection: { mode: this.connectionMode.value, profileId: this.profileInput.value },
      contextChars: Number(this.contextInput.value),
      maxOutputTokens: Number(this.outputInput.value),
      quickQuestions: this.shortcutsInput.value.split('\n'),
    };
    if (!Number.isSafeInteger(raw.contextChars) || raw.contextChars <= 0 || !Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens <= 0) {
      this.settingsStatus.textContent = '分块预算和输出 token 请填写正整数。';
      return;
    }
    if (raw.connection.mode === 'profile' && !this.host.getProfiles().some((profile) => profile.id === raw.connection.profileId)) {
      this.settingsStatus.textContent = '请先在酒馆保存连接配置，再选择有效的独立连接。';
      return;
    }
    save.disabled = true;
    try {
      await this.host.saveSettings(normalizeReaderSettings(raw));
      this.settingsDirty = false;
      this.settingsStatus.textContent = '设置已保存。只影响之后发起的读卡或追问，不会自动调用 AI。';
      this.render(this.controller.getState());
    } catch (error) {
      this.settingsStatus.textContent = error instanceof Error ? `设置保存失败：${error.message}` : '设置保存失败，输入仍保留。';
    } finally {
      save.disabled = false;
    }
  }

  private hasUnsavedInput(): boolean {
    return this.settingsDirty || this.controller.getState().unsaved || Boolean(this.questionInput.value.trim()) || [...this.questionDrafts.values()].some((draft) => Boolean(draft.trim()));
  }

  private async requestExtensionUpdate(feedback: HTMLElement): Promise<void> {
    const blocked = this.getUpdateBlockReason();
    if (blocked) {
      feedback.textContent = blocked;
      feedback.hidden = false;
      return;
    }
    const phase = this.updater.getState().phase;
    if (phase === 'checking' || phase === 'updating') {
      feedback.textContent = '更新已在进行中，请稍候。';
      feedback.hidden = false;
      return;
    }
    if (phase === 'updated') {
      feedback.textContent = '更新已下载，请点击这里的“刷新页面”按钮生效。';
      feedback.hidden = false;
      return;
    }

    feedback.hidden = true;
    this.updateRequestPending = true;
    this.renderUpdateControls();
    try {
      await this.updater.update();
    } catch (error) {
      const state = this.updater.getState();
      if (state.phase !== 'error' || !state.message.trim()) {
        feedback.textContent = error instanceof Error ? error.message : '插件更新失败，请稍后重试。';
        feedback.hidden = false;
      }
    } finally {
      this.updateRequestPending = false;
      this.renderUpdateControls();
    }
  }

  private reloadAfterUpdate(feedback: HTMLElement): void {
    const blocked = this.getUpdateBlockReason();
    if (blocked) {
      feedback.textContent = blocked;
      feedback.hidden = false;
      return;
    }
    if (this.updater.getState().phase !== 'updated') {
      feedback.textContent = '请先成功下载插件更新，再刷新应用。';
      feedback.hidden = false;
      return;
    }
    window.location.reload();
  }

  private getUpdateBlockReason(): string {
    if (this.updateRequestPending) return '更新操作仍在完成，请稍候。';
    const state = this.controller.getState();
    if (state.loading) return '正在读取角色卡资料，请完成后再更新。';
    if (state.busy) return '读卡、追问或保存正在进行，请等待结束后再更新。';
    if (this.hasUnsavedInput()) return '检测到未保存的读卡设置、问题草稿或解读结果。请先保存设置和结果，或清空问题草稿；输入仍保留。';
    return '';
  }

  private renderUpdateControls(): void {
    this.updateControlRenderers.forEach((render) => render());
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text: string, className = ''): HTMLButtonElement {
  const node = element('button', `jgr-button ${className}`, text);
  node.type = 'button';
  return node;
}

function option(value: string, label: string): HTMLOptionElement {
  const node = element('option', '', label);
  node.value = value;
  return node;
}

function field(label: string, input: HTMLElement): HTMLLabelElement {
  const node = element('label', 'jgr-field');
  if (input.id) node.htmlFor = input.id;
  node.append(element('span', '', label), input);
  return node;
}

function makeDialog(id: string, label: string): HTMLDialogElement {
  const node = element('dialog', 'jgr-dialog');
  node.id = id;
  node.setAttribute('aria-label', label);
  return node;
}

function closeButton(dialog: HTMLDialogElement): HTMLButtonElement {
  const node = button('×', 'jgr-close');
  node.setAttribute('aria-label', '关闭');
  node.title = '关闭（未保存的设置输入仍保留）';
  node.addEventListener('click', () => dialog.close());
  return node;
}
