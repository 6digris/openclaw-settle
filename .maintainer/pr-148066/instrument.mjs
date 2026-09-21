import assert from 'node:assert/strict';
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
