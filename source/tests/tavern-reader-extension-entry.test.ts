import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const entrySource = readFileSync(new URL('../extensions/jiuguan-reader/src/index.ts', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../extensions/jiuguan-reader/src/style.css', import.meta.url), 'utf8');

const mountSource = entrySource.match(/const mount = \(\): void => \{([\s\S]*?)\n  \};/u)?.[1] ?? '';
const observerSource = entrySource.match(/let mountPending = false;[\s\S]*?observer\.observe\(document\.body, \{ childList: true, subtree: true \}\);/u)?.[0] ?? '';

test('读卡入口插在角色区最左侧，重复挂载时复用并保持幂等', () => {
  assert.ok(mountSource, '应能定位角色区的 mount 逻辑');
  assert.match(mountSource, /document\.getElementById\('jgr-character-entry'\)/u);
  assert.match(mountSource, /if \(toolbar && !entry\)/u, '只有入口不存在时才创建按钮');
  assert.match(mountSource, /if \(toolbar && entry && toolbar\.firstElementChild !== entry\)\s*\{\s*toolbar\.prepend\(entry\);\s*\}/u);
  assert.equal((mountSource.match(/toolbar\.prepend\(entry\)/gu) ?? []).length, 1);
  assert.doesNotMatch(mountSource, /worldButton\.after\(entry\)|toolbar\.append\(entry\)/u);
});

test('已保存角色可启用读卡；创建中或没有已选角色时入口禁用', () => {
  const cardKeySource = entrySource.match(/function currentCardKey\(\): string \{([\s\S]*?)\n\}/u)?.[1] ?? '';

  assert.match(cardKeySource, /context\.menuType === 'create'/u);
  assert.match(cardKeySource, /context\.characterId === undefined \|\| context\.characterId === ''/u);
  assert.match(cardKeySource, /context\.characters\?\.\[Number\(context\.characterId\)\]\?\.avatar \?\? ''/u);
  assert.match(mountSource, /const key = currentCardKey\(\);/u);
  assert.match(mountSource, /if \(entry\) entry\.disabled = !key;/u);
});

test('MutationObserver 重复触发会合并，入口已经最左时不再改 DOM', () => {
  assert.match(observerSource, /if \(mountPending\) return;/u);
  assert.match(observerSource, /mountPending = true;\s*requestAnimationFrame\(\(\) => \{\s*mountPending = false;\s*mount\(\);\s*\}\);/u);
  assert.match(mountSource, /toolbar\.firstElementChild !== entry/u, '入口已在最左时不得再次 prepend，避免观察器空转');
});

test('所有读卡弹窗和滚动表单使用不透明深色背景与高对比文字', () => {
  const dialogRule = styleSource.match(/\.jgr-dialog\s*\{([^}]*)\}/u)?.[1] ?? '';
  const scrollRule = styleSource.match(/\.jgr-dialog \.jgr-scroll\s*\{([^}]*)\}/u)?.[1] ?? '';
  const fieldsRule = styleSource.match(/\.jgr-dialog textarea, \.jgr-dialog select, \.jgr-dialog input\s*\{([^}]*)\}/u)?.[1] ?? '';

  assert.match(dialogRule, /background:\s*#202127\s*!important/u);
  assert.match(dialogRule, /color:\s*#f2f3f5\s*!important/u);
  assert.match(dialogRule, /color-scheme:\s*dark/u);
  assert.match(scrollRule, /background:\s*#202127\s*!important/u);
  assert.match(scrollRule, /color:\s*#f2f3f5\s*!important/u);
  assert.match(fieldsRule, /background:\s*#15171c\s*!important/u);
  assert.match(fieldsRule, /color:\s*#f2f3f5\s*!important/u);
  assert.doesNotMatch(styleSource, /SmartThemeBlurTintColor/u);
});

test('手机窄屏和横屏继续保留安全区、滚动、44px 操作、16px 输入和键盘焦点', () => {
  assert.match(styleSource, /@media \(max-width: 600px\), \(max-height: 480px\) and \(orientation: landscape\)/u);
  assert.match(styleSource, /width: min\(510px, calc\(100vw - 20px - env\(safe-area-inset-left, 0px\) - env\(safe-area-inset-right, 0px\)\)\)/u);
  assert.match(styleSource, /max-height: calc\(100dvh - 20px - env\(safe-area-inset-top, 0px\) - env\(safe-area-inset-bottom, 0px\)\)/u);
  assert.match(styleSource, /\.jgr-scroll\s*\{[^}]*overflow-y: auto/su);
  assert.match(styleSource, /\.jgr-button\s*\{[^}]*min-height: 44px/su);
  assert.match(styleSource, /\.jgr-close\s*\{[^}]*min-width: 44px/su);
  assert.match(styleSource, /\.jgr-entry\s*\{[^}]*min-height: 44px/su);
  assert.match(styleSource, /\.jgr-source-link\s*\{[^}]*min-height: 44px/su);
  assert.match(styleSource, /\.jgr-dialog textarea, \.jgr-dialog input, \.jgr-dialog select\s*\{[^}]*font-size: 16px/su);
  assert.match(styleSource, /\.jgr-dialog \.jgr-button:focus-visible[^{]*\{[^}]*outline: 2px solid/su);
});
