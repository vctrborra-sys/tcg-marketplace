$ErrorActionPreference = 'Stop'

try {
    Write-Host 'TCG MARKETPLACE - ACESSO PRIVADO AO PAINEL'
    $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    $tailscale = if ($command) { $command.Source } else { Join-Path $env:ProgramFiles 'Tailscale/tailscale.exe' }
    if (-not (Test-Path -LiteralPath $tailscale)) {
        throw 'Instale o Tailscale em https://tailscale.com/download/windows e execute este arquivo novamente.'
    }

    $rawStatus = & $tailscale status --json 2>$null
    $state = $rawStatus | ConvertFrom-Json
    if ($state.BackendState -ne 'Running') {
        $tray = Join-Path (Split-Path $tailscale) 'tailscale-ipn.exe'
        if (Test-Path -LiteralPath $tray) { Start-Process -FilePath $tray -WindowStyle Hidden }
        throw 'Entre no Tailscale pelo icone perto do relogio do Windows. Depois execute este arquivo novamente.'
    }

    $rawServe = & $tailscale serve status --json 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel consultar o Tailscale Serve.' }
    $existing = $rawServe | ConvertFrom-Json
    $dns = ([string]$state.Self.DNSName).TrimEnd('.')
    if (-not $dns.EndsWith('.ts.net')) { throw 'O nome privado do computador ainda nao esta disponivel no Tailscale.' }
    $target = 'http://127.0.0.1:8765'
    $port = $existing.TCP.'443'
    if ($port -and (-not $port.HTTPS -or $existing.Web."${dns}:443".Handlers.'/'.Proxy -ne $target)) {
        throw 'Ja existe outro servico na porta 443 do Tailscale. A configuracao existente foi preservada.'
    }

    & $tailscale serve --bg --yes --https=443 $target
    if ($LASTEXITCODE -ne 0) {
        throw 'A configuracao ainda nao foi concluida. Se o Tailscale mostrou um link para habilitar HTTPS, abra-o e execute este arquivo novamente.'
    }
    $verified = (& $tailscale serve status --json) | ConvertFrom-Json
    if ($verified.Web."${dns}:443".Handlers.'/'.Proxy -ne $target) {
        throw 'Nao foi possivel confirmar o encaminhamento para o painel.'
    }
    Write-Host "`nAcesso privado configurado: https://$dns/"
    Write-Host 'Abra INICIAR_PAINEL.bat neste computador e mantenha-o ligado.'
    Write-Host 'No outro computador, conecte o Tailscale a mesma rede privada e abra o endereco acima.'
    Write-Host 'Entre com o usuario e a senha existentes do painel TCG Marketplace.'
} catch {
    Write-Host "`nPENDENTE: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
