$ErrorActionPreference="Stop"
New-Item -ItemType Directory -Force package/bin,package/audio | Out-Null
Copy-Item target/release/st.exe,target/release/stctl.exe,target/release/st-voice.exe package/bin
Copy-Item deploy/windows/st-icon.ico package/bin/st-icon.ico
Copy-Item assistant/audio/* package/audio
Copy-Item deploy/windows/install.ps1 package/
# Pinned official 64-bit eSpeak release. Extract without installing a machine service.
$msi=Join-Path $env:TEMP 'st-espeak-1.52.0.msi'
Invoke-WebRequest 'https://github.com/espeak-ng/espeak-ng/releases/download/1.52.0/espeak-ng.msi' -OutFile $msi
if ((Get-FileHash $msi -Algorithm SHA256).Hash.ToLower() -ne '7f673c709ea5dd579d3b5ebb98688cc575328a6ab7438d2bc405b88cedaeafb9') { throw 'eSpeak checksum mismatch' }
$extract=Join-Path $env:TEMP 'st-espeak-extracted'
$process=Start-Process msiexec.exe -ArgumentList ('/a "'+$msi+'" /qn TARGETDIR="'+$extract+'"') -Wait -PassThru
if ($process.ExitCode) { throw 'eSpeak extraction failed' }
$dll=Get-ChildItem $extract -Filter '*espeak*.dll' -Recurse | Select-Object -First 1
if (-not $dll) { throw 'Missing eSpeak DLL' }
Copy-Item $dll.FullName package/bin/libespeak-ng.dll
# Preserve upstream licensing with redistributed binary.
Invoke-WebRequest 'https://raw.githubusercontent.com/espeak-ng/espeak-ng/1.52.0/COPYING' -OutFile package/bin/ESPEAK-COPYING.txt
