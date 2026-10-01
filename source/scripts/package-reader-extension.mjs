import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = resolve(root, 'extensions/jiuguan-reader');
const outputRoot = resolve(root, 'dist-extensions');

// Explicit allowlists keep personal cards, configuration, databases and keys out
// of both archives and the publish tree, even if other files exist in the worktree.
export const installFiles = [
  'manifest.json', 'index.js', 'style.css', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
];
export const sourceFiles = [
  'package.json', 'package-lock.json', 'tsconfig.base.json', 'tsconfig.reader-extension.json',
  'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'config/tavern-types.ts', 'server/tavern/reader-domain.ts',
  'extensions/jiuguan-reader/manifest.json', 'extensions/jiuguan-reader/README.md',
  'extensions/jiuguan-reader/vite.config.ts',
  'extensions/jiuguan-reader/src/types.ts', 'extensions/jiuguan-reader/src/settings.ts',
  'extensions/jiuguan-reader/src/source-domain.ts', 'extensions/jiuguan-reader/src/reader-engine.ts',
  'extensions/jiuguan-reader/src/controller.ts', 'extensions/jiuguan-reader/src/render.ts',
  'extensions/jiuguan-reader/src/browser-compat.ts',
  'extensions/jiuguan-reader/src/updater.ts',
  'extensions/jiuguan-reader/src/ui.ts', 'extensions/jiuguan-reader/src/style.css',
  'extensions/jiuguan-reader/src/host.ts', 'extensions/jiuguan-reader/src/storage.ts',
  'extensions/jiuguan-reader/src/index.ts',
  'tests/tavern-reader-extension-settings.test.ts', 'tests/tavern-reader-extension-domain.test.ts',
  'tests/tavern-reader-extension-engine.test.ts', 'tests/tavern-reader-extension-controller.test.ts',
  'tests/tavern-reader-extension-host.test.ts', 'tests/tavern-reader-extension-storage.test.ts',
  'tests/tavern-reader-extension-browser-compat.test.ts',
  'tests/tavern-reader-extension-updater.test.ts',
  'tests/tavern-reader-extension-packaging.test.ts',
  'scripts/package-reader-extension.mjs', 'scripts/tavern-reader-extension-qa.ts',
  'tests/fixtures/tavern/reader-extension-card.json',
  'tests/fixtures/tavern/reader-extension-primary-worldbook.json',
  'tests/fixtures/tavern/reader-extension-extra-worldbook.json',
  'tests/fixtures/tavern/reader-extension-unrelated-worldbook.json',
];

const gitignore = `# Installable extension files are in the repository root.
# Keep generated source dependencies/build output and local user data out of Git.
node_modules/
source/node_modules/
source/dist/
source/dist-extensions/
source/dist-server/
.env
.env.*
source/.env
source/.env.*
data/
backups/
source/data/
source/backups/
*.db
*.db-*
*.sqlite
*.sqlite-*
source/**/*.db
source/**/*.db-*
source/**/*.sqlite
source/**/*.sqlite-*
`;

export function assertManifestVersion(sourceManifest, builtManifest) {
  if (!/^\d+\.\d+\.\d+$/u.test(sourceManifest?.version ?? '')) {
    throw new Error('扩展版本必须是三段数字。');
  }
  if (builtManifest?.version !== sourceManifest.version) {
    throw new Error('构建输出版本不一致，请重新构建扩展。');
  }
}

export async function createPublishDirectory({ outputDirectory, version, installEntries, sourceEntries }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('扩展版本必须是三段数字。');
  const installPrefix = 'jiuguan-reader/';
  const sourcePrefix = `jiuguan-reader-${version}-source/`;
  const rootManifestBytes = installEntries[`${installPrefix}manifest.json`];
  if (!rootManifestBytes) throw new Error('发布目录缺少根 manifest.json。');
  const rootManifest = JSON.parse(new TextDecoder().decode(rootManifestBytes));
  if (rootManifest.version !== version) throw new Error('发布目录根 manifest 版本与扩展版本不一致。');

  await mkdir(outputDirectory, { recursive: true });
  const publishDirectory = await mkdtemp(resolve(outputDirectory, `jiuguan-reader-${version}-publish-`));
  await writePrefixedEntries(publishDirectory, installEntries, installPrefix);
  await writePrefixedEntries(resolve(publishDirectory, 'source'), sourceEntries, sourcePrefix);
  await writeFile(resolve(publishDirectory, '.gitignore'), gitignore);
  return publishDirectory;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/u.test(manifest.version)) throw new Error('扩展版本必须是三段数字。');

  const builtManifest = JSON.parse(await readFile(resolve(outputRoot, 'jiuguan-reader/manifest.json'), 'utf8'));
  assertManifestVersion(manifest, builtManifest);

  const installEntries = await readEntries(resolve(outputRoot, 'jiuguan-reader'), installFiles, 'jiuguan-reader');
  const sourcePrefix = `jiuguan-reader-${manifest.version}-source`;
  const sourceEntries = await readEntries(root, sourceFiles, sourcePrefix);
  sourceEntries[`${sourcePrefix}/SOURCE-README.md`] = new TextEncoder().encode(`# 酒馆读卡 ${manifest.version} 对应源码

这是独立 SillyTavern 扩展的源码与共享读卡模块，不包含 Mac 应用、用户数据或密钥。
使用 Node.js 22，在本目录执行：

\`\`\`bash
npm ci
npm run test:reader-extension
npm run build:reader-extension
npm run package:reader-extension
\`\`\`

构建输出位于 dist-extensions/jiuguan-reader/，安装步骤见 extensions/jiuguan-reader/README.md。
package.json 保留上游桌面项目的其他工作流；本源码包只交付读卡扩展，使用以上带 reader-extension 的命令。
GPL-3.0-or-later；许可证与第三方声明在目录根部。
`);

  await mkdir(outputRoot, { recursive: true });
  const artifacts = [
    [`jiuguan-reader-${manifest.version}.zip`, zipSync(installEntries, { level: 9 })],
    [`jiuguan-reader-${manifest.version}-source.zip`, zipSync(sourceEntries, { level: 9 })],
  ];
  const checksums = [];
  for (const [name, bytes] of artifacts) {
    const path = resolve(outputRoot, name);
    await writeFile(path, bytes);
    checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    console.log(`${path} (${bytes.length} bytes)`);
  }
  await writeFile(resolve(outputRoot, `jiuguan-reader-${manifest.version}-sha256.txt`), `${checksums.join('\n')}\n`);

  const publishDirectory = await createPublishDirectory({
    outputDirectory: resolve(outputRoot, 'publish'),
    version: manifest.version,
    installEntries,
    sourceEntries,
  });
  console.log(`独立 GitHub 仓库目录：${publishDirectory}`);
}

async function writePrefixedEntries(destination, entries, archivePrefix) {
  const prefix = archivePrefix.endsWith('/') ? archivePrefix : `${archivePrefix}/`;
  const destinationRoot = resolve(destination);
  for (const [archivePath, bytes] of Object.entries(entries)) {
    if (!archivePath.startsWith(prefix)) throw new Error(`打包路径不属于白名单前缀：${archivePath}`);
    const relativePath = archivePath.slice(prefix.length);
    if (!relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`发布路径无效：${archivePath}`);
    }
    const target = resolve(destinationRoot, relativePath);
    if (target !== destinationRoot && !target.startsWith(`${destinationRoot}${sep}`)) {
      throw new Error(`发布路径越界：${archivePath}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

async function readEntries(base, paths, archivePrefix) {
  const entries = {};
  for (const path of paths) entries[`${archivePrefix}/${path}`] = new Uint8Array(await readFile(resolve(base, path)));
  return entries;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
