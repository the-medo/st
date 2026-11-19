param([Parameter(Mandatory=$true)][string]$SshAlias,[string]$Microphone="")
$ErrorActionPreference="Stop"
$root=Join-Path $env:LOCALAPPDATA "STapp"
New-Item -ItemType Directory -Force -Path "$root/bin","$root/state","$root/models" | Out-Null
Copy-Item "$PSScriptRoot/bin/*" "$root/bin/" -Force
Copy-Item "$PSScriptRoot/runtime/*" "$root/bin/" -Force
Copy-Item "$PSScriptRoot/models.py" "$root/bin/models.py" -Force
py -3.13 -m venv "$root/venv"
if ($LASTEXITCODE) { throw "Install Python 3.13 with the Windows py launcher" }
$python="$root/venv/Scripts/python.exe"
& $python -m pip install -r "$root/bin/requirements.txt"
if ($LASTEXITCODE) { throw "Voice dependency installation failed" }
& $python "$root/bin/models.py" "$root/models"
if ($LASTEXITCODE) { throw "Speech model installation failed" }
# SshAlias names a dedicated entry with its own forced-command public key on the server.

$probe = '{"op":"projects"}' | ssh -T -o BatchMode=yes -o ConnectTimeout=5 $SshAlias stctl bridge
if ($LASTEXITCODE -or -not (($probe | ConvertFrom-Json).PSObject.Properties.Name -contains "result")) {
  throw "Pair the dedicated SSH key and verify the host alias before installing startup."
}
$settings=@{STAPP_DEVICE="pc"; STAPP_SSH=$SshAlias; STAPP_CLIENT_STATE="$root/state"; STAPP_MODELS="$root/models"; STAPP_VOICE_BIN="$root/bin/st-voice.exe"; STAPP_SPEECH_PYTHON=$python; STAPP_SPEECH_SCRIPT="$root/bin/speech.py"}
if ($Microphone) { $settings.STAPP_MIC=$Microphone }
$settings | ConvertTo-Json | Set-Content -Encoding utf8 "$root/client.json"
$launcher=@'
import json, os, runpy, sys
from pathlib import Path
root=Path(os.environ["LOCALAPPDATA"])/"STapp"
os.environ.update(json.loads((root/"client.json").read_text(encoding="utf-8-sig")))
sys.path.insert(0,str(root/"bin"))
runpy.run_path(str(root/"bin/client.py"),run_name="__main__")
'@
$launcher | Set-Content -Encoding utf8 "$root/launch.py"
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute "$root/venv/Scripts/pythonw.exe" -Argument ('"'+$root+'/launch.py"')
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "STapp Voice" -Action $action -Trigger $trigger -Settings $settings -User $user -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName "STapp Voice"
Write-Output "Started STapp. Use the tray icon to mute or answer questions."
