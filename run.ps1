#requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$runExitCode = 0

Push-Location -LiteralPath $PSScriptRoot
try {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $nodeCommand -or -not $npmCommand) {
        throw 'Please install Node.js 22.13 or newer (including npm), then run this script again.'
    }

    $nodeVersionText = & $nodeCommand.Source --version
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to read the Node.js version.'
    }
    $nodeVersion = [version]($nodeVersionText.Trim() -replace '^v', '')
    if ($nodeVersion -lt [version]'22.13.0') {
        throw "Node.js $nodeVersion is too old. Please install Node.js 22.13 or newer."
    }

    $requiredDependencies = @(
        'node_modules\vite\package.json',
        'node_modules\esbuild\package.json',
        'node_modules\electron\package.json',
        'node_modules\electron\dist\electron.exe'
    )
    $missingDependencies = @($requiredDependencies | Where-Object {
        -not (Test-Path -LiteralPath $_ -PathType Leaf)
    })
    if ($missingDependencies.Count -gt 0) {
        Write-Host 'Installing project dependencies for the first run...'
        & $npmCommand.Source ci --include=dev
        if ($LASTEXITCODE -ne 0) {
            throw 'Dependency installation failed. Check your network and run this script again.'
        }
    }

    Write-Host 'Starting ExamCraft. Close the app or press Ctrl+C to stop.'
    & $npmCommand.Source run dev
    $runExitCode = $LASTEXITCODE
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $runExitCode = 1
}
finally {
    Pop-Location
}

exit $runExitCode
