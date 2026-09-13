// Shared context menu for the project Files tab and the session file browser.
// Uses the app's context menu and prompt components from projects-view.js.
function projectEntryPath(root, relativePath = '') {
  const separator = window.api.platform === 'win32' ? '\\' : '/';
  return root.replace(/[\\/]$/, '') + (relativePath ? separator + relativePath : '');
}

function remapFileActionPath(value, change) {
  if (!value) return value;
  const normalize = path => {
    const normalized = path.replace(/\\/g, '/');
    return window.api.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const sources = [
    [projectEntryPath(change.projectPath, change.relativePath), change.newRelativePath && projectEntryPath(change.projectPath, change.newRelativePath)],
    [change.filePath, change.newFilePath],
  ];
  for (const [from, to] of sources) {
    const key = normalize(from);
    if (normalize(value) === key || normalize(value).startsWith(key + '/')) {
      return to ? to + value.slice(from.length) : null;
    }
  }
  return value;
}

function remapFileActionRelative(root, relativePath, change) {
  if (!relativePath) return relativePath;
  const original = projectEntryPath(root, relativePath);
  const mapped = remapFileActionPath(original, change);
  return mapped === original ? relativePath : mapped === null ? null : mapped.slice(projectEntryPath(root).length + 1);
}

// A preview read stays side-effect free; only user-initiated open flows call
// this fallback after their stale-request checks. Preserve the current editor.
async function openUnsupportedFile(result, filePath, projectRoot) {
  if (result?.code !== 'PREVIEW_UNAVAILABLE') return false;
  try {
    const opened = await window.api.openFileExternally(filePath, projectRoot);
    if (!opened?.ok) throw new Error(opened?.error || 'Could not open the file in its default application.');
  } catch (error) {
    alert(error.message || 'Could not open the file in its default application.');
  }
  return true;
}

function fileEntryMenuItems(root, entry, open) {
  const manager = window.api.platform === 'darwin' ? 'Finder' : window.api.platform === 'win32' ? 'Explorer' : 'File Manager';
  const trash = window.api.platform === 'win32' ? 'Recycle Bin' : 'Trash';
  const run = action => async () => {
    try {
      let name;
      if (action === 'rename' || action === 'trash') {
        if (typeof canManageBrowserEntry === 'function' && !canManageBrowserEntry(root, entry.relativePath)) {
          alert('Resolve or close the open diff for this item before changing it.');
          return;
        }
      }
      if (action === 'rename') {
        name = await showPromptDialog({ title: 'Rename ' + entry.name, label: 'Name', value: entry.name, confirm: 'Rename' });
        if (!name || name === entry.name) return;
      }
      const result = await window.api.manageProjectEntry(root, entry.relativePath, action, name);
      if (!result?.ok) throw new Error(result?.error || 'Could not complete the file action.');
      if (result.cancelled || (action !== 'rename' && action !== 'trash')) return;
      if (typeof applyProjectFileAction === 'function') await applyProjectFileAction(result);
      if (typeof applyBrowserFileAction === 'function') await applyBrowserFileAction(result);
    } catch (err) {
      alert(err.message || 'Could not complete the file action.');
    }
  };
  return [
    { head: entry.name },
    entry.type === 'directory'
      ? { label: 'Open folder', icon: PICONS.folder(14), onClick: run('open-folder') }
      : { label: entry.viewable ? 'Open in editor / preview' : 'Open in default application', icon: PICONS.file(14), disabled: entry.type !== 'file', onClick: open },
    { label: 'Reveal in ' + manager, icon: PICONS.open(14), onClick: run('reveal') },
    { sep: true },
    { label: 'Copy path', onClick: () => window.api.writeClipboard(projectEntryPath(root, entry.relativePath)) },
    { label: 'Copy relative path', onClick: () => window.api.writeClipboard(entry.relativePath) },
    { sep: true },
    { label: 'Rename…', icon: PICONS.pencil(14), onClick: run('rename') },
    { label: 'Move to ' + trash + '…', icon: PICONS.trash(14), danger: true, onClick: run('trash') },
  ];
}

function bindFileEntryMenu(row, root, entry, open) {
  row.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(fileEntryMenuItems(root, entry, open), { x: event.clientX, y: event.clientY });
  });
  row.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(fileEntryMenuItems(root, entry, open), { anchor: row });
  });
}
