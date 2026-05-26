#!/usr/bin/env pwsh
# PowerShell 包装：把所有参数透传给 codex-rotator.js
node "$PSScriptRoot\codex-rotator.js" @args
exit $LASTEXITCODE
