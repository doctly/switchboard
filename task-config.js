const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, printParseErrorCode } = require('jsonc-parser');
const dotenv = require('dotenv');

const TASKS_RELATIVE_PATH = path.join('.vscode', 'tasks.json');

function platformKey(platform = process.platform) {
  if (platform === 'darwin') return 'osx';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

function mergeOptions(...values) {
  const result = {};
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const previousEnv = result.env;
    Object.assign(result, value);
    if (value.env || previousEnv) result.env = { ...(previousEnv || {}), ...(value.env || {}) };
  }
  return result;
}

function mergeConfig(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return { ...base };
  return {
    ...base,
    ...override,
    options: mergeOptions(base.options, override.options),
    presentation: { ...(base.presentation || {}), ...(override.presentation || {}) },
  };
}

function valueOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return value.value;
  }
  return value;
}

function expandString(value, context) {
  if (typeof value !== 'string') return value;
  const variables = {
    workspaceFolder: context.workspaceFolder,
    workspaceFolderBasename: path.basename(context.workspaceFolder),
    userHome: context.userHome || os.homedir(),
    pathSeparator: path.sep,
    '/': path.sep,
    cwd: context.workspaceFolder,
  };

  return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(variables, name)) return variables[name];
    if (name.startsWith('env:')) return context.env?.[name.slice(4)] ?? '';
    const error = new Error(`Unsupported task variable ${match}`);
    error.unsupportedVariable = true;
    throw error;
  });
}

function expandValue(value, context) {
  if (typeof value === 'string') return expandString(value, context);
  if (Array.isArray(value)) return value.map(item => expandValue(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandValue(item, context)]));
  }
  return value;
}

function parseJsonc(text, filePath = 'tasks.json') {
  const errors = [];
  const document = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0];
    throw new Error(`${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${filePath}: expected a JSON object`);
  }
  return document;
}

function loadEnvFile(envFile, context, readFile = fs.readFileSync) {
  if (!envFile) return {};
  const expanded = expandString(String(envFile), context);
  const filePath = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(context.workspaceFolder, expanded);
  try {
    return dotenv.parse(readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && context.fallbackWorkspaceFolder) {
      const fallbackContext = { ...context, workspaceFolder: context.fallbackWorkspaceFolder };
      const fallbackExpanded = expandString(String(envFile), fallbackContext);
      const fallbackPath = path.isAbsolute(fallbackExpanded)
        ? fallbackExpanded
        : path.resolve(context.fallbackWorkspaceFolder, fallbackExpanded);
      try {
        return dotenv.parse(readFile(fallbackPath, 'utf8'));
      } catch {}
    }
    throw new Error(`Could not read task env file ${filePath}: ${error.message}`);
  }
}

function normalizeArgs(args, context) {
  if (args == null) return [];
  if (!Array.isArray(args)) throw new Error('Task args must be an array');
  return args.map(arg => String(expandValue(valueOf(arg), context)));
}

function normalizeTask(rawTask, root, context, key) {
  const platform = key || platformKey();
  const rootWithPlatform = mergeConfig(root, root[platform]);
  let task = mergeConfig(rawTask, rawTask?.[platform]);
  task = {
    ...task,
    options: mergeOptions(rootWithPlatform.options, task.options),
    presentation: { ...(rootWithPlatform.presentation || {}), ...(task.presentation || {}) },
  };

  const label = task.label || task.taskName;
  if (!label || typeof label !== 'string') throw new Error('Every task must have a string label');

  const variableContext = {
    ...context,
    env: { ...(context.env || process.env) },
  };
  const envFile = task.options?.envFile || task.envFile;
  const fileEnv = loadEnvFile(envFile, variableContext, context.readFile);
  const rawEnv = { ...fileEnv, ...(task.options?.env || {}) };
  const expandedEnv = {};
  for (const [name, value] of Object.entries(rawEnv)) {
    if (value === null) expandedEnv[name] = null;
    else expandedEnv[name] = String(expandValue(value, { ...variableContext, env: { ...variableContext.env, ...fileEnv } }));
  }
  variableContext.env = { ...variableContext.env, ...fileEnv, ...expandedEnv };

  const dependsOn = task.dependsOn == null
    ? []
    : (Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn]).map(String);
  const type = task.type || (task.command != null ? 'shell' : 'compound');
  const compound = type === 'compound' || (task.command == null && dependsOn.length > 0 && type !== 'npm');
  const cwdValue = task.options?.cwd || context.workspaceFolder;
  const cwd = path.resolve(context.workspaceFolder, expandString(String(cwdValue), variableContext));

  const normalized = {
    label,
    type: compound ? 'compound' : type,
    detail: typeof task.detail === 'string' ? expandString(task.detail, variableContext) : '',
    dependsOn,
    dependsOrder: task.dependsOrder === 'sequence' ? 'sequence' : 'parallel',
    isBackground: task.isBackground === true,
    cwd,
    env: expandedEnv,
    presentation: task.presentation || {},
    problemMatcher: task.problemMatcher,
    supported: true,
  };

  if (compound) return normalized;

  if (type === 'npm') {
    const script = valueOf(task.script || task.command);
    if (!script) throw new Error(`Task "${label}" is missing its npm script`);
    normalized.type = 'npm';
    normalized.executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    normalized.args = ['run', expandString(String(script), variableContext)];
    const extraArgs = normalizeArgs(task.args, variableContext);
    if (extraArgs.length) normalized.args.push('--', ...extraArgs);
    normalized.useShell = true;
    return normalized;
  }

  if (type !== 'shell' && type !== 'process') {
    normalized.supported = false;
    normalized.error = `Task type "${type}" is not supported yet`;
    return normalized;
  }

  const command = valueOf(task.command);
  if (command == null || command === '') throw new Error(`Task "${label}" is missing its command`);
  normalized.executable = expandString(String(command), variableContext);
  if (context.fallbackWorkspaceFolder
      && path.isAbsolute(normalized.executable)
      && !fs.existsSync(normalized.executable)) {
    const fallbackExecutable = expandString(String(command), {
      ...variableContext,
      workspaceFolder: context.fallbackWorkspaceFolder,
    });
    if (fs.existsSync(fallbackExecutable)) normalized.executable = fallbackExecutable;
  }
  normalized.args = normalizeArgs(task.args, variableContext);
  normalized.useShell = type === 'shell';
  return normalized;
}

// Editor-context variables (${file}, ${relativeFile}, ${lineNumber}, ...) have no
// value outside a focused editor, so a headless run can never resolve them. Keep
// that task visible but unrunnable instead of failing the whole file with it.
function unsupportedTask(rawTask, label, cwd, message) {
  const detail = typeof rawTask?.detail === 'string' && !rawTask.detail.includes('${')
    ? rawTask.detail
    : '';
  return {
    label,
    type: 'shell',
    detail,
    dependsOn: [],
    dependsOrder: 'parallel',
    isBackground: false,
    cwd,
    env: {},
    presentation: rawTask?.presentation || {},
    problemMatcher: undefined,
    supported: false,
    error: message,
  };
}

function loadTasksFromText(text, options) {
  const workspaceFolder = path.resolve(options.workspaceFolder);
  const filePath = options.filePath || path.join(workspaceFolder, TASKS_RELATIVE_PATH);
  const root = parseJsonc(text, filePath);
  if (root.version && root.version !== '2.0.0') {
    throw new Error(`${filePath}: only tasks.json version 2.0.0 is supported`);
  }
  if (!Array.isArray(root.tasks)) throw new Error(`${filePath}: expected a tasks array`);

  const context = {
    workspaceFolder,
    userHome: options.userHome,
    env: options.env || process.env,
    readFile: options.readFile || fs.readFileSync,
    fallbackWorkspaceFolder: options.fallbackWorkspaceFolder,
  };
  const key = platformKey(options.platform);
  const tasks = root.tasks.map(rawTask => {
    try {
      return normalizeTask(rawTask, root, context, key);
    } catch (error) {
      const label = rawTask?.label || rawTask?.taskName;
      // Without a label there is no row to degrade into, so let it fail the file.
      if (!error?.unsupportedVariable || !label || typeof label !== 'string') throw error;
      return unsupportedTask(rawTask, label, workspaceFolder, error.message);
    }
  });
  const duplicate = tasks.find((task, index) => tasks.findIndex(other => other.label === task.label) !== index);
  if (duplicate) throw new Error(`${filePath}: duplicate task label "${duplicate.label}"`);
  return tasks;
}

function worktreeParentPath(workspaceFolder) {
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const markerIndex = workspaceFolder.indexOf(marker);
  if (markerIndex === -1) return null;
  const branchPart = workspaceFolder.slice(markerIndex + marker.length);
  if (!branchPart || branchPart.includes(path.sep)) return null;
  return workspaceFolder.slice(0, markerIndex);
}

function taskFileForWorkspace(workspaceFolder, existsSync = fs.existsSync) {
  const localFile = path.join(workspaceFolder, TASKS_RELATIVE_PATH);
  if (existsSync(localFile)) return { filePath: localFile, inherited: false };

  const parentPath = worktreeParentPath(workspaceFolder);
  if (!parentPath) return null;
  const parentFile = path.join(parentPath, TASKS_RELATIVE_PATH);
  if (!existsSync(parentFile)) return null;
  return { filePath: parentFile, inherited: true, parentPath };
}

function loadProjectTasks(workspaceFolder, options = {}) {
  const source = taskFileForWorkspace(workspaceFolder);
  if (!source) return [];
  const { filePath } = source;
  const text = fs.readFileSync(filePath, 'utf8');
  return loadTasksFromText(text, {
    ...options,
    workspaceFolder,
    filePath,
    fallbackWorkspaceFolder: source.inherited ? source.parentPath : options.fallbackWorkspaceFolder,
  });
}

function resolveTaskGraph(tasks, label) {
  const byLabel = new Map(tasks.map(task => [task.label, task]));
  const visiting = new Set();

  function visit(taskLabel) {
    const task = byLabel.get(taskLabel);
    if (!task) throw new Error(`Task "${taskLabel}" was not found`);
    if (!task.supported) throw new Error(task.error);
    if (visiting.has(taskLabel)) {
      throw new Error(`Task dependency cycle detected at "${taskLabel}"`);
    }
    visiting.add(taskLabel);
    const dependencies = task.dependsOn.map(visit);
    visiting.delete(taskLabel);
    return { task, dependencies };
  }

  return visit(label);
}

module.exports = {
  TASKS_RELATIVE_PATH,
  expandString,
  loadProjectTasks,
  loadTasksFromText,
  normalizeTask,
  parseJsonc,
  platformKey,
  resolveTaskGraph,
  taskFileForWorkspace,
  worktreeParentPath,
};
