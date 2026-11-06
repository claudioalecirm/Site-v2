# Servidor local simples para visualizar o site (sem Node/Python).
# Uso: powershell -ExecutionPolicy Bypass -File .claude\servidor.ps1 [porta]
param([int]$Porta = 5173)

$raiz = Split-Path -Parent $PSScriptRoot
$tipos = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.png' = 'image/png'
  '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.md' = 'text/plain; charset=utf-8'
}

$ouvinte = New-Object System.Net.HttpListener
$ouvinte.Prefixes.Add("http://localhost:$Porta/")
$ouvinte.Start()
Write-Host "Servindo $raiz em http://localhost:$Porta/"

while ($ouvinte.IsListening) {
  $ctx = $ouvinte.GetContext()
  $caminho = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
  if ($caminho -eq '') { $caminho = 'index.html' }
  $arquivo = Join-Path $raiz $caminho
  if (-not [IO.Path]::HasExtension($arquivo) -and (Test-Path "$arquivo.html")) { $arquivo = "$arquivo.html" }

  $resp = $ctx.Response
  $dentro = [IO.Path]::GetFullPath($arquivo).StartsWith([IO.Path]::GetFullPath($raiz))
  if ($dentro -and (Test-Path $arquivo -PathType Leaf)) {
    $bytes = [IO.File]::ReadAllBytes($arquivo)
    $ext = [IO.Path]::GetExtension($arquivo).ToLower()
    $resp.ContentType = if ($tipos.ContainsKey($ext)) { $tipos[$ext] } else { 'application/octet-stream' }
    $resp.Headers.Add('Cache-Control', 'no-store')
    $resp.ContentLength64 = $bytes.Length
    $resp.OutputStream.Write($bytes, 0, $bytes.Length)
    Write-Host "200 /$caminho"
  } else {
    $resp.StatusCode = 404
    $msg = [Text.Encoding]::UTF8.GetBytes("404 - /$caminho")
    $resp.OutputStream.Write($msg, 0, $msg.Length)
    Write-Host "404 /$caminho"
  }
  $resp.OutputStream.Close()
}
