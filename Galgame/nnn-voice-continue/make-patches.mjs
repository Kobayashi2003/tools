import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { detectNnnEngine } from './nnn-engine.mjs';
import { patchScript } from './spt-patch.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function* findInstallations(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const scripts = entries.find(
    (entry) => entry.isDirectory() && entry.name.toLowerCase() === 'spt',
  );
  if (scripts) {
    const executables = entries.filter(
      (entry) => entry.isFile() && /\.exe$/i.test(entry.name),
    );
    if (executables.length > 0) {
      yield { directory, scripts: scripts.name, executables };
      return;
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory())
      yield* findInstallations(join(directory, entry.name));
  }
}

function preparePatch(installation) {
  const candidates = installation.executables.flatMap(({ name }) => {
    const bytes = readFileSync(join(installation.directory, name));
    const engine = detectNnnEngine(bytes);
    return engine ? [{ exe: name, engine, executableHash: sha256(bytes) }] : [];
  });
  if (candidates.length === 0) {
    const names = installation.executables
      .map((entry) => entry.name)
      .join(', ');
    throw new Error(
      `No executable matched a supported NNN engine layout: ${names}`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple executables matched: ${candidates.map(({ exe }) => exe).join(', ')}`,
    );
  }
  const [candidate] = candidates;
  const { exe, engine } = candidate;

  const scripts = join(installation.directory, installation.scripts);
  const names = readdirSync(scripts, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.spt$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const files = [];
  for (const name of names) {
    const original = readFileSync(join(scripts, name));
    const { patched, changes } = patchScript(original, name, engine);
    if (changes > 0) {
      files.push({
        path: join(installation.scripts, name),
        changes,
        original,
        patched,
        originalSha256: sha256(original),
        patchedSha256: sha256(patched),
      });
    }
  }
  if (files.length === 0)
    throw new Error(
      `${exe}: no qualifying voice stops in ${names.length} scripts`,
    );
  return { ...candidate, scriptsScanned: names.length, files };
}

function writePatch(directory, source, patch) {
  for (const { path, original, patched } of patch.files) {
    for (const [folder, bytes] of [
      ['patched', patched],
      ['original', original],
    ]) {
      const output = join(directory, folder, path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes, { flag: 'wx' });
    }
  }
  const manifest = {
    source,
    exe: patch.exe,
    executableSha256: patch.executableHash,
    engine: patch.engine,
    scriptsScanned: patch.scriptsScanned,
    files: patch.files.map(
      ({ path, changes, originalSha256, patchedSha256 }) => ({
        path,
        changes,
        originalSha256,
        patchedSha256,
      }),
    ),
  };
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' },
  );
}

function generatePackages(input, output, installations) {
  const report = [];
  for (const installation of installations) {
    const source = relative(input, installation.directory) || '.';
    let patch;
    try {
      patch = preparePatch(installation);
    } catch (error) {
      report.push({ source, status: 'skipped', reason: error.message });
      console.log(`Skipped ${source}: ${error.message}`);
      continue;
    }

    const destination = join(
      'games',
      source === '.' ? patch.exe.slice(0, -4) : source,
    );
    writePatch(join(output, destination), source, patch);
    const changes = patch.files.reduce(
      (total, file) => total + file.changes,
      0,
    );
    report.push({
      source,
      status: 'generated',
      exe: patch.exe,
      engine: patch.engine.id,
      destination,
      files: patch.files.length,
      changes,
    });
    console.log(
      `${patch.exe}: ${changes} stops in ${patch.files.length} scripts`,
    );
  }
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  return report;
}

function main() {
  const [inputArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !outputArg || process.argv.length !== 4) {
    throw new Error(
      'Usage: node make-patches.mjs <game-or-collection-directory> <new-output-directory>',
    );
  }

  const input = resolve(inputArg);
  const output = resolve(outputArg);
  const installations = [...findInstallations(input)];
  if (installations.length === 0)
    throw new Error(
      `No installations with an EXE and spt directory in ${input}`,
    );

  mkdirSync(output);
  let report;
  try {
    report = generatePackages(input, output, installations);
  } catch (error) {
    // The exclusive mkdir above gives this run ownership of the output tree.
    try {
      rmSync(output, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `${error.message}\nCould not remove incomplete output: ${cleanupError.message}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
  const generated = report.filter(
    (result) => result.status === 'generated',
  ).length;
  console.log(`${generated}/${report.length} patches generated in ${output}`);
  if (generated === 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
