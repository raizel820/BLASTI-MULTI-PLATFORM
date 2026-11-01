<#
BLASTI — one-shot HTTPS/SSL enabler launcher (Windows PowerShell)
=================================================================
Grants automatic HTTPS certificates for BOTH hostnames on the VPS:
    •  blastidz.online        (apex — full app + API)
    •  www.blastidz.online    (own auto-TLS certificate + 308 redirect)

This is the MANUAL step of the deploy workflow:
    download app here  →  push to GitHub  →  Actions build + deploy
    →  (this script)   →  https://blastidz.online + https://www.blastidz.online

USAGE (from the folder that holds this file):
    .\blasti-ssl.ps1                       # defaults: root@129.151.242.219, blastidz.online
    .\blasti-ssl.ps1 -Check                # verify only, change nothing
    .\blasti-ssl.ps1 -Vps root@YOUR_IP -Domain your.domain.tld

WHAT IT DOES ON THE SERVER (idempotent — safe to re-run):
    1. DNS sanity check for apex + www (warns if the A-records are missing)
    2. /etc/blasti/blasti.env: SITE_ADDRESS gains https://<domain> (raw-IP
       door preserved); CORS_ORIGIN + ALLOWED_ORIGINS gain apex + www origins
    3. /etc/caddy/Caddyfile: re-rendered from the repo template (or patched
       in place), www site block ensured, config VALIDATED before reload
    4. gateway reloaded + blasti-api restarted (CORS pickup)
    5. live verification: /api/health 200 + www 308-redirects to the apex
    (a config backup is saved as /etc/caddy/Caddyfile.pre-ssl.bak first)

REQUIREMENTS on the Windows machine: ssh + scp (built into Windows 10/11)
and the SSH key/password you already use to reach the VPS.
#>
param(
    [string]$Vps = "root@129.151.242.219",
    [string]$Domain = "blastidz.online",
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sh   = Join-Path $here "blasti-ssl.sh"

if (-not (Test-Path $sh)) {
    $url = "https://raw.githubusercontent.com/raizel820/BLASTI-MULTI-PLATFORM/master/scripts/blasti-ssl.sh"
    Write-Host "blasti-ssl.sh not found next to me — downloading it from $url"
    Invoke-WebRequest -Uri $url -OutFile $sh
}

Write-Host ""
Write-Host "==> uploading blasti-ssl.sh to $Vps ..."
scp $sh "${Vps}:/tmp/blasti-ssl.sh"

$extra = ""
if ($Check) { $extra = "--check" }

Write-Host "==> running on $Vps (domain: $Domain $extra) ..."
ssh $Vps "tr -d '\r' </tmp/blasti-ssl.sh > /tmp/blasti-ssl.sh.nix && bash /tmp/blasti-ssl.sh.nix $Domain $extra"

Write-Host ""
Write-Host "==> done. Verify any time with:  .\blasti-ssl.ps1 -Check"
