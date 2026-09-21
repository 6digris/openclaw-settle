import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const root = path.dirname(fileURLToPath(import.meta.url));
export const sha256 = b => createHash('sha256').update(b).digest('hex');
export const manifest = JSON.parse(fs.readFileSync(path.join(root, 'source-manifest.json'), 'utf8'));
export function source(name) {
  assert(manifest.files[name] && !manifest.files[name].referenceOnly);
  const b = fs.readFileSync(path.join(root, 'source-exact', name));
  assert.equal(sha256(b), manifest.files[name].sha256, `Source hash: ${name}`);
  return b.toString('utf8');
}
for (const [name, binding] of Object.entries(manifest.files)) if (!binding.referenceOnly) source(name);
const aliases = {
  '@openclaw/normalization-core/record-coerce': 'packages/normalization-core/src/record-coerce.ts',
  '@openclaw/normalization-core/string-coerce': 'packages/normalization-core/src/string-coerce.ts',
};
registerHooks({
  resolve(specifier, context, next) {
    if (aliases[specifier]) return { url: pathToFileURL(path.join(root, 'source-exact', aliases[specifier])).href, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.includes('/source-exact/')) {
      const url = new URL(specifier, context.parentURL);
      if (url.pathname.endsWith('.js')) url.pathname = url.pathname.slice(0, -3) + '.ts';
      return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.includes('/source-exact/')) {
      const name = path.relative(path.join(root, 'source-exact'), fileURLToPath(url)).split(path.sep).join('/');
      return { format: 'module', source: stripTypeScriptTypes(source(name)), shortCircuit: true };
    }
    return next(url, context);
  },
});
export function exactInitializer({ process, path, setTestEnvValue, deleteTestEnvValue, resolveTestCorepackHome }) {
  const setup = stripTypeScriptTypes(source('test/test-env.ts'));
  const supervisor = stripTypeScriptTypes(source('src/infra/supervisor-markers.ts'));
  const hints = supervisor.slice(supervisor.indexOf('const SUPERVISOR_HINTS ='), supervisor.indexOf('/** Supported supervisor'));
  const keys = setup.slice(setup.indexOf('const ISOLATED_TEST_CREDENTIAL_ENV_KEYS ='), setup.indexOf('const HERMETIC_TEST_ENV_KEYS ='));
  const initializer = setup.slice(setup.indexOf('function initializeIsolatedTestEnv('), setup.indexOf('function ensureParentDir('));
  assert(initializer.startsWith('function initializeIsolatedTestEnv(') && initializer.includes('XDG_RUNTIME_DIR'));
  return new Function('process', 'path', 'setTestEnvValue', 'deleteTestEnvValue', 'resolveTestCorepackHome',
    hints.replace('export const', 'const') + keys + initializer + '\nreturn initializeIsolatedTestEnv;')(
      process, path, setTestEnvValue, deleteTestEnvValue, resolveTestCorepackHome);
}
export function instrument(script) {
  const marker = name => `[Console]::Error.WriteLine('PR148066:${name}:'+[DateTime]::UtcNow.ToString('o')); `;
  const original = "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $lookup=$true; $task=$service.GetFolder('\\').GetTask($taskName); $lookup=$false } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; Write-Output $exception.HResult; if($lookup){exit 1}; exit 2 }";
  assert.equal(script.split(original).length, 2, 'Exactly one original probe block');
  const replacement = 'try { ' + marker('before-com') + "$service=New-Object -ComObject 'Schedule.Service'; " + marker('after-com') +
    marker('before-connect') + '$service.Connect(); ' + marker('after-connect') + '$lookup=$true; ' +
    marker('before-folder') + "$folder=$service.GetFolder('\\'); " + marker('after-folder') +
    marker('before-task') + '$task=$folder.GetTask($taskName); ' + marker('after-task') +
    '$lookup=$false } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; ' +
    "[Console]::Error.WriteLine('PR148066:caught-hresult:'+$exception.HResult+':'+[DateTime]::UtcNow.ToString('o')); " +
    'Write-Output $exception.HResult; if($lookup){exit 1}; exit 2 }';
  return marker('entry') + script.replace(original, replacement);
}
