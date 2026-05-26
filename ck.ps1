#!/usr/bin/env pwsh
# PowerShell 包装：把所有参数透传给 rotator.js
node "$PSScriptRoot\rotator.js" @args
exit $LASTEXITCODE
