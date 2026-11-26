param([Parameter(Mandatory=$true)][string]$SshAlias,[string]$Microphone="",[string]$Speaker="")
$ErrorActionPreference="Stop"
$root=Join-Path $env:LOCALAPPDATA "STapp"
New-Item -ItemType Directory -Force -Path "$root/bin","$root/state","$root/models" | Out-Null
# Stop only this client's scheduled task before replacing its executable.
$task=Get-ScheduledTask -TaskName "STapp Voice" -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName "STapp Voice" }
Copy-Item "$PSScriptRoot/bin/*" "$root/bin/" -Force
foreach ($model in (Get-Content "$PSScriptRoot/audio/models.json" -Raw | ConvertFrom-Json)) {
  $file=Join-Path "$root/models" $model.file
  if (-not (Test-Path $file)) {
    Invoke-WebRequest $model.url -OutFile "$file.download"
    if ((Get-FileHash "$file.download" -Algorithm SHA256).Hash.ToLower() -ne $model.sha256) { throw "Speech model checksum failed: $($model.file)" }
    Move-Item "$file.download" $file
  }
  if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $model.sha256) { throw "Corrupt model; remove and retry: $file" }
  if ($model.directory) {
    $marker=Join-Path "$root/models/$($model.directory)" ".st-verified"
    if (-not (Test-Path $marker) -or (Get-Content $marker -Raw) -ne $model.sha256) {
      tar -xf $file -C "$root/models"
      if ($LASTEXITCODE) { throw "Cannot extract $file" }
      [IO.File]::WriteAllText($marker,$model.sha256)
    }
  }
}
Copy-Item "$PSScriptRoot/audio/st-keywords.txt" "$root/models/" -Force
if (-not (Test-Path "$root/bin/libespeak-ng.dll")) { throw "Package is missing the native eSpeak NG library" }
# The paired forced-command key owns the device role; this file contains no cloud credentials.
$probe = '{"op":"projects"}' | ssh -T -o BatchMode=yes -o ConnectTimeout=5 $SshAlias stctl bridge
if ($LASTEXITCODE -or -not (($probe | ConvertFrom-Json).PSObject.Properties.Name -contains "result")) {
  throw "Pair the dedicated SSH key and verify its host alias first."
}
$settings=@{STAPP_DEVICE="pc"; STAPP_SSH=$SshAlias; STAPP_CLIENT_STATE="$root/state"; STAPP_MODELS="$root/models"; STAPP_ESPEAK_LIBRARY="$root/bin/libespeak-ng.dll"}
if ($Microphone) { $settings.STAPP_MIC=$Microphone }
if ($Speaker) { $settings.STAPP_SPEAKER=$Speaker }
$settings | ConvertTo-Json | Set-Content -Encoding utf8 "$root/client.json"
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute "$root/bin/st-voice.exe" -Argument ('--config "'+$root+'/client.json"')
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$taskSettings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "STapp Voice" -Action $action -Trigger $trigger -Settings $taskSettings -User $user -RunLevel Limited -Force | Out-Null
$shell=New-Object -ComObject WScript.Shell
$start=Join-Path ([Environment]::GetFolderPath('Programs')) 'S.T. assistant'
New-Item -ItemType Directory -Force $start | Out-Null
foreach ($command in @('mute','unmute','stop','quit')) {
  $link=$shell.CreateShortcut((Join-Path $start "$command.lnk"))
  $link.TargetPath="$root/bin/st-voice.exe"
  $link.Arguments='--config "'+$root+'/client.json" --control '+$command
  $link.Save()
}
Start-ScheduledTask -TaskName "STapp Voice"
Write-Output "Started S.T. Say Hey ST or Okay ST. Maintenance controls are in the Start menu."
