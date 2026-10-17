[CmdletBinding()]
param(
    [string]$HostName = $(if ($env:TOMIFY_AGENT_HOST) { $env:TOMIFY_AGENT_HOST } else { 'tom@tomify' }),
    [switch]$Rollback,
    [switch]$Setup
)

$ErrorActionPreference = 'Stop'
$repo = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repo) { throw 'Run this script inside the Tomify checkout.' }
Push-Location $repo
try {
    if ($Setup) {
        # One-time: installs the root helper and a sudoers rule so later deploys need no password.
        & scp scripts/tomify-agent-activate.sh scripts/setup-agent-deploy.sh "${HostName}:/tmp/"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the setup scripts.' }
        & ssh -t $HostName 'sudo bash /tmp/setup-agent-deploy.sh /tmp/tomify-agent-activate.sh "$(id -un)"; status=$?; rm -f /tmp/setup-agent-deploy.sh /tmp/tomify-agent-activate.sh; exit $status'
        if ($LASTEXITCODE -ne 0) { throw 'Remote setup failed.' }
        return
    }

    if ($Rollback) {
        # Uses this checkout's installer: an older release's copy may predate the root helper.
        & scp scripts/install-agent-release.sh "${HostName}:/tmp/tomify-install-agent-release.sh"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the installer.' }
        & ssh -t $HostName 'bash /tmp/tomify-install-agent-release.sh --rollback; status=$?; rm -f /tmp/tomify-install-agent-release.sh; exit $status'
        if ($LASTEXITCODE -ne 0) { throw 'Remote rollback failed.' }
        return
    }

    $dirty = (& git status --porcelain -- recovery-agent shared)
    if ($dirty) { throw "Commit or discard changes under recovery-agent/ and shared/ before deploying:`n$($dirty -join "`n")" }

    $sha = (& git rev-parse --short HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the current Git revision.' }
    $archive = Join-Path ([IO.Path]::GetTempPath()) "tomify-agent-$sha.tar.gz"
    $remoteArchive = "/tmp/tomify-agent-$sha.tar.gz"
    try {
        & tar -czf $archive recovery-agent shared package.json scripts/install-agent-release.sh
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the agent release archive.' }
        & scp $archive "${HostName}:$remoteArchive"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the agent release archive.' }

        $remote = "bash -o pipefail -c 'tar -xOf $remoteArchive scripts/install-agent-release.sh | bash -s -- --archive $remoteArchive --sha $sha; status=`$?; rm -f $remoteArchive; exit `$status'"
        & ssh -t $HostName $remote
        if ($LASTEXITCODE -ne 0) { throw 'Remote agent installation failed.' }
    }
    finally {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
