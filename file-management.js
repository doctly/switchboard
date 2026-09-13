const fs = require('fs');
const path = require('path');
const { resolveProjectEntry } = require('./project-files');

// Resolve the parent, not the leaf: renaming/trashing a symlink must act on
// the link itself. Parents still have to resolve inside the project.
function resolveManagedEntry(projectPath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Invalid project-relative path');
  }
  const { root } = resolveProjectEntry(projectPath);
  const candidate = path.resolve(root, relativePath);
  if (candidate === root) throw new Error('The project folder itself cannot be changed');
  const { resolved: parent } = resolveProjectEntry(root, path.relative(root, path.dirname(candidate)));
  const filePath = path.join(parent, path.basename(candidate));
  const stat = fs.lstatSync(filePath);
  return { root, filePath, stat };
}

async function manageProjectEntry(projectPath, relativePath, action, newName, { shell, confirmTrash }) {
  const { filePath, stat } = resolveManagedEntry(projectPath, relativePath);
  const result = { action, projectPath, relativePath, filePath };
  if (action === 'reveal') {
    shell.showItemInFolder(filePath);
  } else if (action === 'open-folder') {
    if (!stat.isDirectory()) throw new Error('Not a folder');
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
  } else if (action === 'rename') {
    if (typeof newName !== 'string' || !newName.trim() || newName === '.' || newName === '..' || /[/\\\0]/.test(newName)) {
      throw new Error('Enter a file or folder name without path separators');
    }
    const newFilePath = path.join(path.dirname(filePath), newName);
    if (newFilePath === filePath) return { ...result, cancelled: true };
    // lstat also catches dangling symlinks, which existsSync would miss.
    try {
      fs.lstatSync(newFilePath);
      throw new Error('A file or folder with that name already exists');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    fs.renameSync(filePath, newFilePath);
    result.newFilePath = newFilePath;
    result.newRelativePath = path.join(path.dirname(relativePath), newName);
  } else if (action === 'trash') {
    if (!await confirmTrash(filePath, stat.isDirectory())) return { ...result, cancelled: true };
    // A native confirmation is asynchronous. Recheck before acting in case
    // the item or one of its parents was replaced while the dialog was open.
    const current = resolveManagedEntry(projectPath, relativePath);
    if (current.filePath !== filePath || current.stat.ino !== stat.ino || current.stat.dev !== stat.dev) {
      throw new Error('The item changed while confirming. Refresh the files and try again.');
    }
    await shell.trashItem(filePath);
  } else {
    throw new Error('Unknown file action');
  }
  return result;
}

module.exports = { manageProjectEntry, resolveManagedEntry };
