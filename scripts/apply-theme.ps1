<#
=====================================================================
 Switchboard - Personnalisation des couleurs
 ---------------------------------------------------------------------
 Modifie la CSS empaquetee dans app.asar (app Electron Switchboard).

 3 modes :
   Cowork  -> theme clair facon Claude / Cowork
              (fond creme #faf9f5, texte #141413, accent corail #d97757)
   Solid   -> remplace simplement la couleur de fond principale (-Color)
   Revert  -> restaure l'original intact (app.asar.bak)

 Le script repart TOUJOURS de la sauvegarde propre (app.asar.bak) et
 re-empaquette en gardant les modules natifs (better-sqlite3, node-pty)
 HORS de l'asar (--unpack-dir), sinon l'application casse.

 PREREQUIS : Node.js 20+ et npm (fournit npx). @electron/asar est
 telecharge automatiquement par npx au besoin.

 IMPORTANT : si Switchboard est installe dans "Program Files", lancez
 ce script dans une fenetre PowerShell ouverte EN ADMINISTRATEUR.

 ATTENTION : la mise a jour automatique de Switchboard reecrit app.asar
 a chaque nouvelle version -> il faut relancer ce script apres un update.

 Auteur : Jean-Luc PIETRI
 Date    : 23/05/2026
=====================================================================
.EXAMPLE
  .\2026-05-23_14-00-36_Switchboard-Personnalisation.ps1 -Mode Cowork
.EXAMPLE
  .\2026-05-23_14-00-36_Switchboard-Personnalisation.ps1 -Mode Solid -Color '#101820'
.EXAMPLE
  .\2026-05-23_14-00-36_Switchboard-Personnalisation.ps1 -Mode Revert
.EXAMPLE
  .\2026-05-23_14-00-36_Switchboard-Personnalisation.ps1 -Mode Cowork -InstallDir 'D:\Program Files\Switchboard'
#>

param(
  [string]$InstallDir,
  [ValidateSet('Cowork','Solid','Revert')] [string]$Mode = 'Cowork',
  [string]$Color = '#1e1e2e',
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------
# 1. Localiser l'installation de Switchboard
# ---------------------------------------------------------------------
if (-not $InstallDir) {
  $candidats = @(
    "$env:LOCALAPPDATA\Programs\Switchboard",
    "$env:ProgramFiles\Switchboard",
    "${env:ProgramFiles(x86)}\Switchboard",
    "D:\Program Files\Switchboard",
    "C:\Program Files\Switchboard"
  )
  $InstallDir = $candidats | Where-Object { Test-Path (Join-Path $_ 'resources\app.asar') } | Select-Object -First 1
}
if (-not $InstallDir -or -not (Test-Path (Join-Path $InstallDir 'resources\app.asar'))) {
  Write-Error "Switchboard introuvable. Relancez avec : -InstallDir 'C:\chemin\vers\Switchboard'"
  return
}

$resources = Join-Path $InstallDir 'resources'
$asar      = Join-Path $resources 'app.asar'
$bak       = Join-Path $resources 'app.asar.bak'
$appsrc    = Join-Path $resources 'app_src'
$cssPath   = Join-Path $appsrc   'public\style.css'
$exe       = Join-Path $InstallDir 'Switchboard.exe'

Write-Host "Installation : $InstallDir"  -ForegroundColor Cyan
Write-Host "Mode         : $Mode"        -ForegroundColor Cyan

# ---------------------------------------------------------------------
# 2. Fermer Switchboard (sinon app.asar est verrouille)
# ---------------------------------------------------------------------
Get-Process Switchboard -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# ---------------------------------------------------------------------
# 3. Sauvegarde initiale propre (une seule fois)
# ---------------------------------------------------------------------
if (-not (Test-Path $bak)) {
  Copy-Item $asar $bak -Force
  Write-Host "Sauvegarde de l'original creee : app.asar.bak" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------
# Mode REVERT : restaurer l'original puis quitter
# ---------------------------------------------------------------------
if ($Mode -eq 'Revert') {
  Copy-Item $bak $asar -Force
  Write-Host "Original restaure (app.asar.bak)." -ForegroundColor Green
  if (-not $NoRestart) { Start-Process $exe }
  return
}

# ---------------------------------------------------------------------
# 4. Repartir du propre, puis extraire l'asar
# ---------------------------------------------------------------------
Copy-Item $bak $asar -Force
if (Test-Path $appsrc) { Remove-Item $appsrc -Recurse -Force }
npx @electron/asar extract $asar $appsrc

$css = Get-Content -Raw $cssPath

# ---------------------------------------------------------------------
# 5. Transformation des couleurs selon le mode
# ---------------------------------------------------------------------
if ($Mode -eq 'Solid') {

  # Remplace les fonds principaux par la couleur demandee
  foreach ($bg in '#0e0e14','#111118','#1e1e2e') {
    $css = $css -replace ([regex]::Escape($bg) + '\b'), $Color
  }
  Write-Host "Fond principal remplace par $Color" -ForegroundColor Green

}
elseif ($Mode -eq 'Cowork') {

  # Table de correspondance sombre -> clair (chassis de l'application).
  # NB : aucune valeur cible n'est elle-meme une cle (pas d'effet de chaine).
  $map = [ordered]@{
    '#0e0e14'='#f4f2ec'; '#111118'='#faf9f5'; '#1e1e2e'='#faf9f5'; '#18181f'='#f7f5ef'; '#1a1a2e'='#f0eee6';
    '#4a4a5a'='#e3e0d6'; '#555570'='#ddd9ce'; '#5a5a70'='#ddd9ce'; '#606078'='#9a978d'; '#606878'='#9a978d';
    '#6a6a80'='#8a8780'; '#707088'='#84817a'; '#777790'='#7c7a72'; '#7a7a90'='#6e6c64'; '#7a7a96'='#6e6c64';
    '#808090'='#6b6962'; '#808098'='#6b6962'; '#8888a0'='#64625b'; '#8888a8'='#64625b'; '#8a8aa0'='#64625b';
    '#909098'='#5e5c56'; '#9090a8'='#5e5c56'; '#9898b0'='#595751'; '#a0a0b8'='#54524c'; '#b0b0c4'='#46443f';
    '#b0b0d0'='#46443f'; '#b0b8c8'='#46443f'; '#b8b8cc'='#403e3a'; '#c0c0d0'='#36342f'; '#c0c0d8'='#36342f';
    '#c0c1d8'='#36342f'; '#d0d0e0'='#2a2925'; '#d0d0e8'='#2a2925'; '#d8d8f0'='#222019'; '#e0e0e0'='#141413';
    '#e0e0f0'='#141413'; '#f0f0ff'='#141413'; '#8088ff'='#d97757'; '#6a72e0'='#bd5d3f'; '#6068b0'='#bd5d3f';
    '#555'='#8a8780'; '#666'='#8a8780'; '#888'='#6b6962'; '#999'='#5e5c56'; '#ffffff'='#141413'; '#fff'='#141413';
  }
  # Cles longues d'abord ; la frontiere \b evite de couper un hex plus long.
  foreach ($k in ($map.Keys | Sort-Object { $_.Length } -Descending)) {
    $css = $css -replace ([regex]::Escape($k) + '\b'), $map[$k]
  }

  # Voiles translucides : blanc -> fonce ; accent bleu -> corail.
  $css = $css -replace 'rgba\(\s*255\s*,\s*255\s*,\s*255\s*,', 'rgba(20,20,19,'
  $css = $css -replace 'rgba\(\s*128\s*,\s*136\s*,\s*255\s*,', 'rgba(217,119,87,'
  $css = $css -replace 'rgba\(\s*120\s*,\s*130\s*,\s*255\s*,', 'rgba(217,119,87,'

  # Correctifs de la zone conversation (corps fonce, code clair sur fond
  # sombre conserve, liens lisibles). Ajoutes en fin de fichier -> priorite.
  $override = @'

/* === Theme clair Cowork : correctifs zone conversation === */
.markdown-preview { color:#141413; }
.markdown-preview h1,.markdown-preview h2,.markdown-preview h3,.markdown-preview h4,.markdown-preview h5,.markdown-preview h6 { color:#141413; }
.markdown-preview a { color:#3a6ea5; }
.markdown-preview th { color:#141413; }
.markdown-preview pre { background:#282a36; }
.markdown-preview pre, .markdown-preview pre code { color:#f1efe9; }
.jsonl-text { color:#141413; }
.jsonl-text a { color:#3a6ea5; }
.jsonl-text a:hover { color:#28527d; }
.jsonl-text th { color:#141413; }
.jsonl-text :not(pre) > code { color:#9a3fb8; background:rgba(20,20,19,0.06); }
.jsonl-text pre { background:#282a36; color:#f1efe9; }
.jsonl-tool-name { color:#3a6ea5; }
.jsonl-meta-entry code { color:#6b4a86; }
.jsonl-tool-call .jsonl-toggle { color:#9a3fb8; }
'@
  $css = $css + "`r`n" + $override
  Write-Host "Theme clair Cowork applique." -ForegroundColor Green
}

# Ecriture UTF-8 sans BOM (chemin absolu requis pour .NET)
[System.IO.File]::WriteAllText($cssPath, $css)

# ---------------------------------------------------------------------
# 6. Re-empaqueter en gardant les modules natifs dehors
# ---------------------------------------------------------------------
npx @electron/asar pack $appsrc $asar --unpack-dir "node_modules/{better-sqlite3,node-pty}"

$sizeMo = [math]::Round((Get-Item $asar).Length / 1MB, 1)
Write-Host "app.asar reconstruit : $sizeMo Mo (attendu ~15-16 Mo)." -ForegroundColor Green
if ($sizeMo -gt 30) {
  Write-Warning "Taille anormale (>30 Mo) : les modules natifs ont peut-etre ete empaquetes. Verifiez le --unpack-dir."
}

# Nettoyage du dossier temporaire d'extraction
Remove-Item $appsrc -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------
# 7. Relancer l'application
# ---------------------------------------------------------------------
if (-not $NoRestart) {
  Start-Process $exe
  Write-Host "Switchboard relance." -ForegroundColor Green
} else {
  Write-Host "Termine. Relancez Switchboard manuellement." -ForegroundColor Green
}
