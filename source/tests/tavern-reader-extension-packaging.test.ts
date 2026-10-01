import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import {
  assertManifestVersion,
  createPublishDirectory,
  installFiles,
  sourceFiles,
} from '../scripts/package-reader-extension.mjs';

const installPrefix = 'jiuguan-reader';

test('publish manifest version must match the built manifest version', () => {
  assert.doesNotThrow(() => assertManifestVersion({ version: '0.1.1' }, { version: '0.1.1' }));
  assert.throws(
    () => assertManifestVersion({ version: '0.1.1' }, { version: '0.1.0' }),
    /构建输出版本不一致/u,
  );
  assert.throws(
    () => assertManifestVersion({ version: '0.1' }, { version: '0.1' }),
    /扩展版本必须是三段数字/u,
  );
});

test('publish directory is fresh, root contains only install files, and source is allowlist-only', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'jiuguan-reader-packaging-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const outputDirectory = join(tempRoot, 'publish');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'previous-output.txt'), 'leave prior outputs untouched');

  const version = '0.1.1';
  const sourcePrefix = `jiuguan-reader-${version}-source`;
  const installEntries = makeEntries(installPrefix, installFiles, version);
  const sourceEntries = makeEntries(sourcePrefix, sourceFiles, version);
  sourceEntries[`${sourcePrefix}/SOURCE-README.md`] = new TextEncoder().encode('Rebuild instructions');

  assert.ok(sourceFiles.includes('extensions/jiuguan-reader/src/updater.ts'));
  assert.ok(sourceFiles.includes('tests/tavern-reader-extension-updater.test.ts'));
  assert.ok(sourceFiles.includes('tests/tavern-reader-extension-ui.test.ts'));
  assert.ok(sourceFiles.includes('tests/tavern-reader-extension-packaging.test.ts'));

  const firstDirectory = await createPublishDirectory({
    outputDirectory,
    version,
    installEntries,
    sourceEntries,
  });

  const rootEntries = (await readdir(firstDirectory)).sort();
  assert.deepEqual(rootEntries, ['.gitignore', ...installFiles, 'source'].sort());
  assert.equal(JSON.parse(await readFile(join(firstDirectory, 'manifest.json'), 'utf8')).version, version);

  const sourceRoot = join(firstDirectory, 'source');
  const sourcePaths = (await listFiles(sourceRoot)).sort();
  assert.deepEqual(sourcePaths, [...sourceFiles, 'SOURCE-README.md'].sort());
  assert.equal(JSON.parse(await readFile(join(sourceRoot, 'extensions/jiuguan-reader/manifest.json'), 'utf8')).version, version);
  for (const [archivePath, expected] of Object.entries(sourceEntries)) {
    const sourcePath = archivePath.slice(`${sourcePrefix}/`.length);
    assert.deepEqual(await readFile(join(sourceRoot, sourcePath)), Buffer.from(expected), sourcePath);
  }

  const ignoreRules = await readFile(join(firstDirectory, '.gitignore'), 'utf8');
  assert.match(ignoreRules, /source\/node_modules\//u);
  assert.match(ignoreRules, /source\/dist-extensions\//u);
  assert.match(ignoreRules, /source\/\.env/u);
  assert.match(ignoreRules, /source\/data\//u);
  assert.match(ignoreRules, /source\/backups\//u);

  const secondDirectory = await createPublishDirectory({
    outputDirectory,
    version,
    installEntries,
    sourceEntries,
  });
  assert.notEqual(firstDirectory, secondDirectory);
  assert.equal(await readFile(join(outputDirectory, 'previous-output.txt'), 'utf8'), 'leave prior outputs untouched');
  assert.deepEqual((await readdir(secondDirectory)).sort(), rootEntries);
});

test('publish directory refuses a root manifest version mismatch before writing', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'jiuguan-reader-packaging-version-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const outputDirectory = join(tempRoot, 'publish');
  const installEntries = makeEntries(installPrefix, installFiles, '0.1.0');
  const sourceEntries = makeEntries('jiuguan-reader-0.1.1-source', sourceFiles, '0.1.1');

  await assert.rejects(
    createPublishDirectory({ outputDirectory, version: '0.1.1', installEntries, sourceEntries }),
    /发布目录根 manifest 版本与扩展版本不一致/u,
  );
});

function makeEntries(prefix: string, paths: string[], version: string): Record<string, Uint8Array> {
  return Object.fromEntries(paths.map((path) => [
    `${prefix}/${path}`,
    new TextEncoder().encode((path === 'manifest.json' && prefix === installPrefix)
      || path === 'extensions/jiuguan-reader/manifest.json'
      ? JSON.stringify({ version })
      : `fixture:${path}`),
  ]));
}

async function listFiles(directory: string, baseDirectory = directory): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolutePath, baseDirectory));
    else files.push(relative(baseDirectory, absolutePath).split(sep).join('/'));
  }
  return files;
}
