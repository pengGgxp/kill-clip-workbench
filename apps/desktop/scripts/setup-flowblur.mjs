import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const buildRoot = fileURLToPath(new URL('../../../.temp/', import.meta.url));
const runtime = path.join(buildRoot, 'flowblur');
const packages = [
  {
    url: 'https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip',
    sha256: '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159',
    directory: '',
  },
  {
    url: 'https://files.pythonhosted.org/packages/09/d7/f67e68a7bf35dc24bdff34b30d14baee5b726790c0bed8cba449790dbc33/vapoursynth-82-cp312-abi3-win_amd64.whl',
    sha256: 'dbde9930d4e85de4eb220e05a0314edb7469b9016c5c58a279844b90da4a32b1',
    directory: 'site-packages',
  },
  {
    url: 'https://files.pythonhosted.org/packages/7a/bc/f78066bab517574c851fafcff710270f6fc601e125656329d503e3f07134/vapoursynth_mvutensils-10-py3-none-win_amd64.whl',
    sha256: '0290dc5881931973a61afbae45496dc17a1af40a333dc2bbc0143e860e050ea2',
    directory: 'site-packages',
  },
  {
    url: 'https://files.pythonhosted.org/packages/25/2e/1a5cb192ce26077c5afe9056a11b3a2d936c4e413b4fec5eee74d45bdb01/vapoursynth-82.tar.gz',
    sha256: '1128316620890ba8e5b69c924a665f98001b2ba4230dadead0f296446ea71843',
  },
  {
    url: 'https://files.pythonhosted.org/packages/b2/ba/306693a7c70c157e4c853efdc173219f655970184ec8f978a7db7f74823d/vapoursynth_mvutensils-10.tar.gz',
    sha256: 'aa2ae5f47a234b44328ac434bdf0b52b3c9b61812cc3f078649c294b019ddd2a',
  },
];

export async function prepareFlowBlur() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The bundled FlowBlur runtime requires Windows x64.');
  }
  if (
    await access(path.join(runtime, 'python.exe')).then(
      () => true,
      () => false,
    )
  ) {
    return runtime;
  }
  await mkdir(buildRoot, { recursive: true });
  const stage = await mkdtemp(path.join(buildRoot, 'flowblur-'));
  try {
    const payload = path.join(stage, 'runtime');
    await Promise.all([
      mkdir(path.join(payload, 'site-packages'), { recursive: true }),
      mkdir(path.join(payload, 'source'), { recursive: true }),
    ]);
    for (const { url, sha256, directory } of packages) {
      const name = path.basename(url);
      process.stdout.write(`Preparing ${name}\n`);
      const cached = await readFile(path.join(buildRoot, name)).catch(
        (error) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
      let data = cached;
      if (!data) {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(600_000),
        });
        if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
        data = Buffer.from(await response.arrayBuffer());
      }
      if (createHash('sha256').update(data).digest('hex') !== sha256) {
        throw new Error(`${name}: SHA-256 mismatch`);
      }
      if (directory === undefined) {
        await writeFile(path.join(payload, 'source', name), data);
        continue;
      }
      const archive = path.join(stage, name);
      await writeFile(archive, data);
      await exec(
        'tar.exe',
        ['-xf', archive, '-C', path.join(payload, directory)],
        {
          windowsHide: true,
        },
      );
    }
    await writeFile(
      path.join(payload, 'python314._pth'),
      'python314.zip\n.\nsite-packages\n',
    );
    await exec(
      path.join(payload, 'python.exe'),
      ['-c', 'import vapoursynth as vs; assert callable(vs.core.mvu.FlowBlur)'],
      { windowsHide: true },
    );
    await rename(payload, runtime);
    return runtime;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(`${await prepareFlowBlur()}\n`);
}
