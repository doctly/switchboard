# Personnaliser les couleurs de Switchboard (fond + thème clair « Cowork »)

> Guide pratique pour installer Switchboard, changer la couleur de fond, et appliquer un thème clair façon Claude / Cowork (fond crème, texte foncé, accent corail).
>
> Auteur : Jean-Luc PIETRI — 23/05/2026 — testé sur Switchboard v0.0.30 (Windows).

---

## 1. Présentation

**Switchboard** (dépôt : `doctly/switchboard`, licence MIT) est une application de bureau qui centralise toutes vos sessions Claude Code dans une seule fenêtre : navigateur de sessions par projet, recherche plein texte, terminal intégré, fork/reprise de session, édition des fichiers `CLAUDE.md`, statistiques d'activité.

L'interface est livrée avec un **thème sombre** bleu-violet. Comme l'application est construite avec Electron, son apparence est définie par une feuille de style CSS : on peut donc la modifier. Ce guide explique trois choses :

1. installer Switchboard ;
2. changer simplement la **couleur de fond** ;
3. appliquer un **thème clair complet** aux couleurs de Claude / Cowork.

> **Important** — La feuille de style est empaquetée dans une archive `app.asar`. Toute modification est **écrasée par la mise à jour automatique** de Switchboard à chaque nouvelle version : il faudra rejouer l'opération après un *update*.

---

## 2. Prérequis

- **Switchboard installé**, avec des sessions Claude Code dans `~/.claude/projects` (sous Windows : `C:\Users\<vous>\.claude\projects`).
- **Node.js 20+** et **npm** (fournissent la commande `npx`). L'outil `@electron/asar` est téléchargé automatiquement au besoin.
- Sous Windows, si Switchboard est installé dans `Program Files`, ouvrez **PowerShell en administrateur** (les écritures y sont protégées).

---

## 3. Installer Switchboard

1. Ouvrez la page des versions : `https://github.com/doctly/switchboard/releases/latest`
2. Dans **Assets**, téléchargez l'installeur Windows `.exe` (type `Switchboard-Setup-x.y.z.exe`). *(macOS : `.dmg` ; Linux : `.AppImage` ou `.deb`.)*
3. Lancez l'`.exe`. Comme l'application n'est pas signée, **SmartScreen** affichera « Windows a protégé votre PC » → cliquez sur **Informations complémentaires** puis **Exécuter quand même**.
4. Suivez l'installeur. Au premier lancement, Switchboard scanne `~/.claude/projects` et liste vos sessions par projet.

---

## 4. Comprendre la personnalisation (`app.asar`)

La CSS de l'interface se trouve dans `public/style.css`, **empaquetée** dans :

```
<dossier d'installation>\resources\app.asar
```

Chemins par défaut selon l'installation :

- `C:\Users\<vous>\AppData\Local\Programs\Switchboard\resources\app.asar` (installation par utilisateur), ou
- `C:\Program Files\Switchboard\resources\app.asar` / autre disque si vous avez changé le dossier.

Pour modifier la CSS, il faut **extraire** l'archive, éditer le fichier, puis **ré-empaqueter**. Point crucial : les **modules natifs** (`better-sqlite3`, `node-pty`) doivent rester **hors** de l'archive (`--unpack-dir`), faute de quoi l'application ne démarre plus (Electron ne sait pas charger un module natif depuis l'intérieur d'un `.asar`).

> Un `app.asar` reconstruit doit peser **~15-16 Mo**. S'il monte à ~50 Mo, c'est que les modules natifs ont été aspirés dans l'archive : l'option `--unpack-dir` a été oubliée.

---

## 5. Méthode A — Changer la couleur de fond (simple)

Le fond principal sombre est la couleur `#111118`. Voici comment la remplacer par la couleur de votre choix (exemple : `#1e1e2e`).

Ouvrez **PowerShell en administrateur**, puis adaptez le chemin d'installation :

```powershell
cd "D:\Program Files\Switchboard\resources"      # adaptez ce chemin
Copy-Item app.asar app.asar.bak                   # sauvegarde (1re fois seulement)
npx @electron/asar extract app.asar app_src
(Get-Content app_src\public\style.css -Raw) -replace '#111118','#1e1e2e' | Set-Content app_src\public\style.css
npx @electron/asar pack app_src app.asar --unpack-dir "node_modules/{better-sqlite3,node-pty}"
```

Relancez Switchboard. *(La même opération est automatisée par le script en mode `Solid` — voir section 7.)*

---

## 6. Méthode B — Appliquer le thème clair « Cowork »

Passer d'un thème **sombre** à un thème **clair** n'est pas un simple échange de couleur : il faut convertir tout le châssis. Le principe appliqué :

- **Fonds** sombres → crème (`#faf9f5`, `#f0eee6`, `#f4f2ec`, `#f7f5ef`).
- **Texte** clair → foncé (`#141413` et nuances).
- **Accent** bleu-violet (`#8088ff`) → **corail Claude** (`#d97757`).
- **Voiles translucides blancs** (`rgba(255,255,255,…)`, utilisés pour bordures/survols sur fond sombre) → **voiles foncés** (`rgba(20,20,19,…)`).
- Les **couleurs de statut** (vert / rouge / jaune) et les **blocs de code** (fond sombre conservé) sont laissés tels quels pour rester lisibles.

La palette de référence est celle d'Anthropic / Claude :

| Rôle | Couleur |
|------|---------|
| Fond crème | `#faf9f5` |
| Texte principal | `#141413` |
| Gris moyen | `#b0aea5` |
| Accent corail | `#d97757` |
| Bleu secondaire | `#6a9bcc` |

Cette transformation touche des dizaines de couleurs ; le plus simple et le plus fiable est d'utiliser le **script automatique** ci-dessous.

---

## 7. Script automatique (recommandé)

Le script `…_Switchboard-Personnalisation.ps1` (fourni avec ce guide) gère trois modes :

| Mode | Effet |
|------|-------|
| `Cowork` | Applique le thème clair complet (défaut). |
| `Solid`  | Remplace seulement le fond principal par `-Color`. |
| `Revert` | Restaure l'original intact (`app.asar.bak`). |

Il **repart toujours de la sauvegarde propre**, ferme l'application au besoin, et ré-empaquette en gardant les modules natifs dehors.

Ouvrez **PowerShell en administrateur**, placez-vous dans le dossier du script, puis :

```powershell
# Thème clair Cowork
.\2026-05-23_14-00-36_Switchboard-Personnalisation.ps1 -Mode Cowork

# Fond uni d'une couleur précise
.\2026-05-23_14-00-36_Switchboard-Personnalisation.ps1 -Mode Solid -Color '#101820'

# Revenir à l'original
.\2026-05-23_14-00-36_Switchboard-Personnalisation.ps1 -Mode Revert

# Forcer un dossier d'installation particulier
.\2026-05-23_14-00-36_Switchboard-Personnalisation.ps1 -Mode Cowork -InstallDir 'D:\Program Files\Switchboard'
```

Si l'exécution de scripts est bloquée, autorisez-la pour la session courante :

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

À la fin, le script affiche la taille du nouvel `app.asar` (doit être ~15-16 Mo) et relance l'application.

---

## 8. Revenir en arrière

- **Original (thème sombre d'origine)** :

  ```powershell
  Copy-Item app.asar.bak app.asar -Force
  ```

  ou `.\…_Switchboard-Personnalisation.ps1 -Mode Revert`.

- **Sécurité** : conservez toujours `app.asar.bak`. C'est votre filet de secours.

---

## 9. Réserves et limites

- **Mise à jour automatique** : Switchboard se met à jour seul (au lancement et toutes les 4 h) ; chaque nouvelle version réécrit `app.asar` et **annule** la personnalisation. Relancez alors le script.
- **Application non signée** : l'avertissement Windows à l'installation est normal.
- **Terminal** : la zone terminal (xterm) a son propre thème, réglable directement dans **Réglages → Terminal Theme** (Switchboard, Ghostty, Tokyo Night, Catppuccin Mocha, Dracula, Nord, Solarized Dark).
- **Thème clair = premier jet** : la conversion sombre → clair est volontairement « best-effort ». Si une zone vous paraît peu lisible, ajustez le bloc de correctifs en fin de `style.css` (section « correctifs zone conversation » du script).
- **Version testée** : Switchboard v0.0.30. Une refonte de la CSS dans une version future peut nécessiter d'adapter la table de correspondance.

---

*Document rédigé par Jean-Luc PIETRI — 23/05/2026.*
