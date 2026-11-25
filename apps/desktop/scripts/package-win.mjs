import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ffprobe from '@ffprobe-installer/ffprobe';
import electron from 'electron';
import { Arch, build, Platform } from 'electron-builder';
import ffmpeg from 'ffmpeg-static';

import desktop from '../package.json' with { type: 'json' };

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The Windows x64 installer must be built on Windows x64.');
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const web = path.join(root, 'apps', 'web-antd', 'dist');
const electronDist = path.dirname(electron);
await Promise.all([
  access(path.join(web, 'index.html')),
  access(electron),
  access(ffmpeg),
  access(ffprobe.path),
]);

// Stage just the runtime files; the Vben monorepo and pnpm links stay out of the app.
const stage = await mkdtemp(path.join(tmpdir(), 'kill-clip-package-'));
try {
  const source = path.join(stage, 'src');
  const licenses = path.join(stage, 'licenses');
  await Promise.all([mkdir(source), mkdir(licenses)]);
  await Promise.all([
    ...['clip-plan.mjs', 'main.mjs', 'media.mjs', 'preload.cjs'].map((name) =>
      copyFile(
        new URL(`../src/${name}`, import.meta.url),
        path.join(source, name),
      ),
    ),
    copyFile(path.join(root, 'LICENSE'), path.join(licenses, 'workbench.txt')),
    copyFile(`${ffmpeg}.LICENSE`, path.join(licenses, 'ffmpeg.txt')),
    copyFile(`${ffmpeg}.README`, path.join(licenses, 'ffmpeg-readme.txt')),
    copyFile(
      path.join(path.dirname(ffprobe.path), 'README.md'),
      path.join(licenses, 'ffprobe-readme.md'),
    ),
    writeFile(
      path.join(stage, 'package.json'),
      JSON.stringify({
        name: 'kill-clip-workbench',
        productName: desktop.productName,
        version: desktop.version,
        description: 'Local gameplay clip editor',
        author: desktop.productName,
        license: 'MIT',
        type: desktop.type,
        main: desktop.main,
      }),
    ),
  ]);

  await build({
    projectDir: stage,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    publish: 'never',
    config: {
      appId: 'com.killclip.workbench',
      artifactName: `Kill-Clip-Workbench-Setup-${desktop.version}-x64.exe`,
      directories: { output: path.join(root, 'release') },
      electronVersion: require('electron/package.json').version,
      electronDist,
      npmRebuild: false,
      files: ['src/**/*', 'package.json'],
      extraResources: [
        { from: web, to: 'web' },
        { from: ffmpeg, to: 'media/ffmpeg.exe' },
        { from: ffprobe.path, to: 'media/ffprobe.exe' },
        { from: licenses, to: 'licenses' },
      ],
      win: {
        executableName: 'Kill Clip Workbench',
        signAndEditExecutable: false,
      },
      nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        installerLanguages: ['zh_CN', 'en_US'],
        runAfterFinish: false,
      },
    },
  });
} finally {
  // Node removes only the unique staging directory created by mkdtemp above.
  await rm(stage, { force: true, recursive: true });
}
