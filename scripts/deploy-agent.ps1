[CmdletBinding()]
param(
    [string]$HostName = $(if ($env:TOMIFY_AGENT_HOST) { $env:TOMIFY_AGENT_HOST } else { 'tom@tomify' }),
    [switch]$Rollback,
    # One-time setup (asks for the server's sudo password): installs this checkout's installer as
    # /usr/local/sbin/tomify-install-agent and lets the SSH user run only that command without a password.
    [switch]$Bootstrap
)

$ErrorActionPreference = 'Stop'
$installer = '/usr/local/sbin/tomify-install-agent'
$repo = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repo) { throw 'Run this script inside the Tomify checkout.' }
Push-Location $repo
try {
    $sha = (& git rev-parse --short HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the current Git revision.' }

    if ($Bootstrap) {
        $dirty = (& git status --porcelain -- scripts/install-agent-release.sh)
        if ($dirty) { throw 'Commit scripts/install-agent-release.sh before bootstrapping.' }
        $remoteInstaller = "/tmp/tomify-install-agent-$sha.sh"
        & scp scripts/install-agent-release.sh "${HostName}:$remoteInstaller"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the installer.' }
        & ssh -t $HostName "sudo bash $remoteInstaller --bootstrap; status=`$?; rm -f $remoteInstaller; exit `$status"
        if ($LASTEXITCODE -ne 0) { throw 'Bootstrap failed.' }
        return
    }

    & ssh $HostName "sudo -n $installer --help >/dev/null 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "$HostName is not set up for password-free deploys yet. Run .\scripts\deploy-agent.ps1 -Bootstrap once." }

    if ($Rollback) {
        & ssh $HostName "sudo -n $installer --rollback"
        if ($LASTEXITCODE -ne 0) { throw 'Remote rollback failed.' }
        return
    }

    $dirty = (& git status --porcelain -- recovery-agent shared)
    if ($dirty) { throw "Commit or discard changes under recovery-agent/ and shared/ before deploying:`n$($dirty -join "`n")" }

    $archive = Join-Path ([IO.Path]::GetTempPath()) "tomify-agent-$sha.tar.gz"
    $remoteArchive = "/tmp/tomify-agent-$sha.tar.gz"
    try {
        & tar -czf $archive recovery-agent shared package.json
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the agent release archive.' }
        & scp $archive "${HostName}:$remoteArchive"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the agent release archive.' }

        & ssh $HostName "sudo -n $installer --archive $remoteArchive --sha $sha; status=`$?; rm -f $remoteArchive; exit `$status"
        if ($LASTEXITCODE -ne 0) { throw 'Remote agent installation failed.' }
    }
    finally {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
