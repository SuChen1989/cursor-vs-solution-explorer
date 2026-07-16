const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseSolution, parseProject, buildTree, displayGroup, readText } = require('./src/model');

class SolutionNode {
  constructor(label, kind, resource, collapsible = vscode.TreeItemCollapsibleState.None) {
    this.label = label; this.kind = kind; this.resource = resource; this.collapsibleState = collapsible;
    this.contextValue = kind;
    if (kind === 'file') {
      this.command = { command: 'vscode.open', title: '打开文件', arguments: [vscode.Uri.file(resource)] };
      this.iconPath = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('charts.green'));
      this.tooltip = resource;
    } else if (kind === 'solution') {
      this.iconPath = new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.blue'));
      this.description = 'Visual Studio Solution';
    } else if (kind === 'project') {
      this.iconPath = new vscode.ThemeIcon('project', new vscode.ThemeColor('charts.orange'));
      this.description = 'C++ project';
    } else if (kind === 'filter' || kind === 'group' || kind === 'solutionFolder') {
      this.iconPath = new vscode.ThemeIcon(kind === 'solutionFolder' ? 'folder-library' : 'folder', new vscode.ThemeColor('charts.purple'));
    }
  }
}

class SolutionProvider {
  constructor() { this._onDidChangeTreeData = new vscode.EventEmitter(); this.onDidChangeTreeData = this._onDidChangeTreeData.event; this.solution = null; this.solutionPath = null; }
  refresh() { this._onDidChangeTreeData.fire(); }
  async load(file) { this.solutionPath = file; this.solution = parseSolution(file); this.refresh(); }
  getTreeItem(node) { return node; }
  getChildren(node) {
    if (!node) return this.solution ? [new SolutionNode(this.solution.name, 'solution', this.solution.file, vscode.TreeItemCollapsibleState.Expanded)] : [];
    if (node.kind === 'solution') return this.solutionChildren();
    if (node.kind === 'solutionFolder') return this.solutionFolderChildren(node.project);
    if (node.kind === 'project') return this.projectChildren(node.projectInfo);
    if (node.kind === 'filter' || node.kind === 'group') return node.children || [];
    return [];
  }
  solutionChildren() {
    const roots = buildTree(this.solution).sort((a, b) => Number(b.isSolutionFolder) - Number(a.isSolutionFolder) || a.name.localeCompare(b.name, 'zh-CN'));
    return roots.map(p => p.isSolutionFolder ? this.solutionFolderNode(p) : this.projectNode(p));
  }
  projectNode(project) { const projectFile = path.join(path.dirname(this.solution.file), project.relativePath); const node = new SolutionNode(project.name, 'project', path.dirname(projectFile), vscode.TreeItemCollapsibleState.Collapsed); node.projectInfo = project; return node; }
  solutionFolderChildren(project) { const children = buildTree({ projects: this.solution.projects.filter(p => p.parentGuid === project.guid), projectByGuid: this.solution.projectByGuid }).sort((a, b) => Number(b.isSolutionFolder) - Number(a.isSolutionFolder) || a.name.localeCompare(b.name, 'zh-CN')); return children.map(p => p.isSolutionFolder ? this.solutionFolderNode(p) : this.projectNode(p)); }
  solutionFolderNode(project) { const n = new SolutionNode(project.name, 'solutionFolder', path.dirname(this.solution.file), vscode.TreeItemCollapsibleState.Collapsed); n.project = project; return n; }
  projectChildren(projectInfo) {
    const file = path.join(path.dirname(this.solution.file), projectInfo.relativePath);
    const project = parseProject(file); const groups = new Map();
    for (const item of project.items) {
      const filter = project.filters.get(item.include);
      const group = filter || displayGroup(item.kind);
      const parts = group.split(/[\\/]/).filter(Boolean);
      let level = groups;
      for (const part of parts) {
        if (!level.has(part)) level.set(part, { items: [], children: new Map() });
        level = level.get(part).children;
      }
      const leaf = parts.length ? groups : groups;
      let target = groups;
      for (const part of parts) target = target.get(part).children;
      // The item is kept on the deepest filter node. A synthetic root is
      // avoided so the resulting tree has the same top-level grouping as VS.
      const parent = parts.length ? (() => {
        let cursor = groups;
        for (const part of parts) { const entry = cursor.get(part); if (part === parts[parts.length - 1]) return entry; cursor = entry.children; }
      })() : null;
      if (parent) parent.items.push(item);
    }
    const make = (entries, parentPath = '') => [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN')).map(([label, entry]) => {
      const node = { label, kind: 'filter', contextValue: 'filter', collapsibleState: vscode.TreeItemCollapsibleState.Collapsed, iconPath: new vscode.ThemeIcon('folder'), children: [] };
      node.projectInfo = projectInfo;
      node.filterPath = parentPath ? `${parentPath}\\${label}` : label;
      node.resource = path.resolve(project.dir, filterFolderRelative(node.filterPath));
      const files = entry.items.map(item => {
        const relative = item.include;
        const fileNode = new SolutionNode(path.basename(relative), 'file', path.normalize(path.join(project.dir, relative)));
        fileNode.projectInfo = projectInfo;
        fileNode.filterPath = node.filterPath;
        return fileNode;
      });
      // Keep folders before files at every level, matching Visual Studio.
      node.children.push(...make(entry.children, node.filterPath));
      node.children.push(...files);
      node.collapsibleState = node.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      return node;
    });
    return make(groups);
  }
}

async function findSolution(root, configured) {
  const candidate = path.resolve(root, configured);
  if (fs.existsSync(candidate)) return candidate;
  const files = await vscode.workspace.findFiles('**/*.sln', '**/{.git,node_modules,Debug,Release,x64}/**');
  return files.length ? files[0].fsPath : null;
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function itemTypeForFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.cpp', '.cc', '.cxx', '.c', '.mm'].includes(ext)) return 'ClCompile';
  if (['.h', '.hh', '.hpp', '.hxx', '.inl'].includes(ext)) return 'ClInclude';
  if (ext === '.rc') return 'ResourceCompile';
  if (['.ico', '.cur', '.bmp', '.png', '.jpg', '.jpeg'].includes(ext)) return 'Image';
  return 'None';
}

function defaultFilterForType(type) {
  if (type === 'ClCompile') return '源文件';
  if (type === 'ClInclude') return '头文件';
  if (type === 'ResourceCompile' || type === 'Image') return '资源文件';
  return '其他文件';
}

function projectFilePath(solutionPath, projectInfo) {
  return path.resolve(path.dirname(solutionPath), projectInfo.relativePath);
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) return null;
  return clean;
}

function appendProjectItem(projectFile, type, include) {
  const text = readText(projectFile);
  const escaped = escapeXml(include);
  const existing = new RegExp(`<${type}\\b[^>]*\\bInclude=["']${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
  if (existing.test(text)) return false;
  const close = text.lastIndexOf('</Project>');
  if (close < 0) throw new Error(`项目文件缺少 </Project>: ${projectFile}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const group = `  <ItemGroup>${eol}    <${type} Include="${escaped}" />${eol}  </ItemGroup>${eol}`;
  fs.writeFileSync(projectFile, text.slice(0, close) + group + text.slice(close), 'utf8');
  return true;
}

function appendFilterItem(projectFile, type, include, filter) {
  const filtersFile = `${projectFile}.filters`;
  const escaped = escapeXml(include);
  const filterEscaped = escapeXml(filter);
  const eol = '\r\n';
  if (!fs.existsSync(filtersFile)) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>${eol}<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">${eol}`
      + `  <ItemGroup>${eol}    <Filter Include="${filterEscaped}">${eol}      <UniqueIdentifier>{${Date.now().toString(16).padStart(8, '0')}-0000-4000-8000-000000000000}</UniqueIdentifier>${eol}    </Filter>${eol}  </ItemGroup>${eol}`
      + `  <ItemGroup>${eol}    <${type} Include="${escaped}">${eol}      <Filter>${filterEscaped}</Filter>${eol}    </${type}>${eol}  </ItemGroup>${eol}</Project>${eol}`;
    fs.writeFileSync(filtersFile, xml, 'utf8');
    return true;
  }
  let text = readText(filtersFile);
  const existing = new RegExp(`<${type}\\b[^>]*\\bInclude=["']${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
  if (existing.test(text)) return false;
  const close = text.lastIndexOf('</Project>');
  if (close < 0) throw new Error(`筛选器文件缺少 </Project>: ${filtersFile}`);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let filterGroup = '';
  const filterExists = new RegExp(`<Filter\\b[^>]*\\bInclude=["']${filterEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(text);
  if (!filterExists) {
    filterGroup = `  <ItemGroup>${newline}    <Filter Include="${filterEscaped}">${newline}      <UniqueIdentifier>{${Date.now().toString(16).padStart(8, '0')}-0000-4000-8000-000000000000}</UniqueIdentifier>${newline}    </Filter>${newline}  </ItemGroup>${newline}`;
  }
  const itemGroup = `  <ItemGroup>${newline}    <${type} Include="${escaped}">${newline}      <Filter>${filterEscaped}</Filter>${newline}    </${type}>${newline}  </ItemGroup>${newline}`;
  fs.writeFileSync(filtersFile, text.slice(0, close) + filterGroup + itemGroup + text.slice(close), 'utf8');
  return true;
}

function projectChoices(provider) {
  if (!provider.solution) return [];
  return provider.solution.projects.filter(project => !project.isSolutionFolder).map(project => ({
    label: project.name,
    description: project.relativePath,
    project
  }));
}

function filterFolderRelative(filterPath) {
  const parts = String(filterPath || '').split(/[\\/]/).filter(Boolean);
  const defaultGroups = new Set(['源文件', '头文件', '资源文件', '其他文件']);
  if (parts.length && defaultGroups.has(parts[0])) parts.shift();
  return parts.join('/');
}

async function chooseProject(provider, node) {
  if (node && node.kind === 'project' && node.projectInfo) return node.projectInfo;
  const picked = await vscode.window.showQuickPick(projectChoices(provider), { placeHolder: '选择要修改的 C++ 项目' });
  return picked && picked.project;
}

async function chooseTarget(provider, node) {
  const projectInfo = await chooseProject(provider, node);
  if (!projectInfo) return null;
  return { projectInfo, filterPath: node && node.kind === 'filter' ? node.filterPath : '' };
}

function projectTargetFolder(projectFile, filterPath) {
  const projectDir = path.dirname(projectFile);
  const relative = filterFolderRelative(filterPath);
  const absolute = path.resolve(projectDir, relative || '.');
  if (absolute !== projectDir && !absolute.startsWith(`${projectDir}${path.sep}`)) {
    throw new Error('目标文件夹必须位于项目目录内。');
  }
  return { absolute, relative };
}

function uniqueDestination(directory, name) {
  const parsed = path.parse(name);
  let candidate = path.join(directory, name);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name}_${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function reloadProvider(provider) {
  if (provider.solutionPath) await provider.load(provider.solutionPath);
}

async function createCodeFile(provider, node) {
  const target = await chooseTarget(provider, node);
  if (!target) return;
  const { projectInfo } = target;
  const typeChoice = await vscode.window.showQuickPick([
    { label: 'C++ 源文件 (.cpp)', extension: '.cpp', itemType: 'ClCompile' },
    { label: 'C++ 头文件 (.h)', extension: '.h', itemType: 'ClInclude' },
    { label: 'C 源文件 (.c)', extension: '.c', itemType: 'ClCompile' }
  ], { placeHolder: '选择文件类型' });
  if (!typeChoice) return;
  const name = await vscode.window.showInputBox({
    prompt: '输入新文件名（可包含项目内子目录）',
    value: `NewFile${typeChoice.extension}`,
    validateInput(value) {
      const relative = safeRelativePath(value);
      if (!relative || !path.extname(relative)) return '请输入有效的相对文件名';
      if (path.basename(relative) !== path.basename(value.trim())) return '文件名不能包含 .. 或绝对路径';
      return null;
    }
  });
  const relative = safeRelativePath(name);
  if (!relative) return;
  const projectFile = projectFilePath(provider.solutionPath, projectInfo);
  const folder = projectTargetFolder(projectFile, target.filterPath);
  const include = path.posix.join(folder.relative || '.', relative).replace(/^\.\//, '');
  const targetFile = path.join(folder.absolute, relative);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  if (fs.existsSync(targetFile)) return vscode.window.showErrorMessage(`文件已存在：${include}`);
  fs.writeFileSync(targetFile, '', 'utf8');
  appendProjectItem(projectFile, typeChoice.itemType, include);
  appendFilterItem(projectFile, typeChoice.itemType, include, target.filterPath || defaultFilterForType(typeChoice.itemType));
  await reloadProvider(provider);
  await vscode.window.showTextDocument(vscode.Uri.file(targetFile));
  vscode.window.setStatusBarMessage(`已新建并加入 ${projectInfo.name}: ${include}`, 4000);
}

async function importCodeFiles(provider, node) {
  const target = await chooseTarget(provider, node);
  if (!target) return;
  const { projectInfo } = target;
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: '导入到项目',
    filters: { 'C/C++ 代码文件': ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'inl', 'rc'] }
  });
  if (!selected || !selected.length) return;
  const projectFile = projectFilePath(provider.solutionPath, projectInfo);
  const projectDir = path.dirname(projectFile);
  const folder = projectTargetFolder(projectFile, target.filterPath);
  fs.mkdirSync(folder.absolute, { recursive: true });
  let added = 0;
  for (const uri of selected) {
    const source = uri.fsPath;
    const sourceInTarget = path.resolve(source) === folder.absolute || path.resolve(source).startsWith(`${folder.absolute}${path.sep}`);
    let targetFile = source;
    if (!sourceInTarget) {
      targetFile = uniqueDestination(folder.absolute, path.basename(source));
      fs.copyFileSync(source, targetFile);
    }
    const relative = path.relative(projectDir, targetFile).replace(/\\/g, '/');
    const type = itemTypeForFile(targetFile);
    if (appendProjectItem(projectFile, type, relative)) {
      appendFilterItem(projectFile, type, relative, target.filterPath || defaultFilterForType(type));
      added += 1;
    }
  }
  await reloadProvider(provider);
  vscode.window.showInformationMessage(`已导入 ${added} 个文件到 ${projectInfo.name}。`);
}

let fileClipboard = null;

function nodePath(node) {
  return node && node.resource ? path.normalize(node.resource) : null;
}

function nodeDirectory(node) {
  const target = nodePath(node);
  if (!target) return null;
  try { return fs.statSync(target).isDirectory() ? target : path.dirname(target); }
  catch (_) { return node.kind === 'file' ? path.dirname(target) : target; }
}

function isVirtualFilterRoot(node) {
  return node && node.kind === 'filter' && !filterFolderRelative(node.filterPath);
}

function projectRelative(projectFile, file) {
  return path.relative(path.dirname(projectFile), file).replace(/\\/g, '/');
}

function isPathUnder(file, root) {
  const absoluteFile = path.resolve(file);
  const absoluteRoot = path.resolve(root);
  return absoluteFile === absoluteRoot || absoluteFile.startsWith(`${absoluteRoot}${path.sep}`);
}

function addFileToProject(projectFile, file, filterPath) {
  const relative = projectRelative(projectFile, file);
  const type = itemTypeForFile(file);
  if (!appendProjectItem(projectFile, type, relative)) return false;
  appendFilterItem(projectFile, type, relative, filterPath || defaultFilterForType(type));
  return true;
}

function removeProjectReferences(projectFile, targetRelative) {
  if (!fs.existsSync(projectFile)) return;
  const normalizedTarget = targetRelative.replace(/\\/g, '/').replace(/^\.\//, '');
  const removeItems = text => text.replace(/\s*<(ClCompile|ClInclude|ResourceCompile|None|Content|CustomBuild|Natvis|Midl|Image|JavaScriptCompile)\b[^>]*\bInclude=["']([^"']+)["'][^>]*(?:\/>|>[\s\S]*?<\/\1>)/gi, (whole, type, include) => {
    const normalized = include.replace(/\\/g, '/');
    return normalized === normalizedTarget || normalized.startsWith(`${normalizedTarget}/`) ? '' : whole;
  });
  const replaceFile = (file, transform) => {
    if (!fs.existsSync(file)) return;
    const before = readText(file);
    const after = transform(before);
    if (before !== after) fs.writeFileSync(file, after, 'utf8');
  };
  replaceFile(projectFile, removeItems);
  replaceFile(`${projectFile}.filters`, removeItems);
}

function updateProjectReferences(projectFile, oldRelative, newRelative) {
  const oldPath = oldRelative.replace(/\\/g, '/').replace(/^\.\//, '');
  const newPath = newRelative.replace(/\\/g, '/').replace(/^\.\//, '');
  const replacePath = value => {
    const normalized = value.replace(/\\/g, '/');
    if (normalized !== oldPath && !normalized.startsWith(`${oldPath}/`)) return value;
    return `${newPath}${normalized.slice(oldPath.length)}`;
  };
  const update = text => text.replace(/(\bInclude=["'])([^"']+)(["'])/gi, (whole, prefix, include, suffix) => {
    const updated = replacePath(include);
    return updated === include ? whole : `${prefix}${updated}${suffix}`;
  }).replace(/(<Filter>)([^<]+)(<\/Filter>)/gi, (whole, prefix, filter, suffix) => {
    const updated = replacePath(filter);
    return updated === filter ? whole : `${prefix}${updated}${suffix}`;
  });
  const replaceFile = file => {
    if (!fs.existsSync(file)) return;
    const before = readText(file);
    const after = update(before);
    if (before !== after) fs.writeFileSync(file, after, 'utf8');
  };
  replaceFile(projectFile);
  replaceFile(`${projectFile}.filters`);
}

function ensureFilterEntry(projectFile, filterPath) {
  if (!filterPath) return;
  const filtersFile = `${projectFile}.filters`;
  const escaped = escapeXml(filterPath.replace(/\\/g, '/'));
  const newline = fs.existsSync(filtersFile) && readText(filtersFile).includes('\r\n') ? '\r\n' : '\n';
  if (!fs.existsSync(filtersFile)) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>${newline}<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">${newline}`
      + `  <ItemGroup>${newline}    <Filter Include="${escaped}">${newline}      <UniqueIdentifier>{${Date.now().toString(16).padStart(8, '0')}-0000-4000-8000-000000000000}</UniqueIdentifier>${newline}    </Filter>${newline}  </ItemGroup>${newline}</Project>${newline}`;
    fs.writeFileSync(filtersFile, xml, 'utf8');
    return;
  }
  const text = readText(filtersFile);
  const exists = new RegExp(`<Filter\\b[^>]*\\bInclude=["']${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(text);
  if (exists) return;
  const close = text.lastIndexOf('</Project>');
  if (close < 0) return;
  const group = `  <ItemGroup>${newline}    <Filter Include="${escaped}">${newline}      <UniqueIdentifier>{${Date.now().toString(16).padStart(8, '0')}-0000-4000-8000-000000000000}</UniqueIdentifier>${newline}    </Filter>${newline}  </ItemGroup>${newline}`;
  fs.writeFileSync(filtersFile, text.slice(0, close) + group + text.slice(close), 'utf8');
}

function projectNodeContext(provider, node) {
  const projectInfo = node && node.projectInfo;
  if (!projectInfo || !provider.solutionPath) return null;
  const projectFile = projectFilePath(provider.solutionPath, projectInfo);
  return { projectInfo, projectFile, folder: projectTargetFolder(projectFile, node.filterPath || '') };
}

async function newFile(provider, node) {
  const directory = nodeDirectory(node);
  if (!directory) return;
  const name = await vscode.window.showInputBox({
    prompt: '输入新文件名',
    value: 'NewFile.cpp',
    validateInput(value) {
      const clean = String(value || '').trim();
      if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') return '请输入文件名，不要包含路径';
      if (fs.existsSync(path.join(directory, clean))) return '文件已存在';
      return null;
    }
  });
  if (!name) return;
  const target = path.join(directory, name.trim());
  fs.writeFileSync(target, '', 'utf8');
  const context = projectNodeContext(provider, node);
  if (context && isPathUnder(target, path.dirname(context.projectFile))) {
    addFileToProject(context.projectFile, target, node.filterPath || defaultFilterForType(itemTypeForFile(target)));
  }
  await reloadProvider(provider);
  await vscode.window.showTextDocument(vscode.Uri.file(target));
}

async function newFolder(provider, node) {
  const directory = nodeDirectory(node);
  if (!directory) return;
  const name = await vscode.window.showInputBox({
    prompt: '输入新文件夹名称',
    validateInput(value) {
      const clean = String(value || '').trim();
      if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') return '请输入文件夹名称，不要包含路径';
      if (fs.existsSync(path.join(directory, clean))) return '文件夹已存在';
      return null;
    }
  });
  if (!name) return;
  const target = path.join(directory, name.trim());
  fs.mkdirSync(target, { recursive: true });
  const context = projectNodeContext(provider, node);
  if (context && node.kind === 'filter') ensureFilterEntry(context.projectFile, path.posix.join(node.filterPath || '', name.trim()));
  await reloadProvider(provider);
}

async function revealInFinder(node) {
  const target = nodePath(node);
  if (target) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
}

async function openInTerminal(node) {
  const directory = nodeDirectory(node);
  if (!directory) return;
  const terminal = vscode.window.createTerminal({ name: `UACS: ${path.basename(directory)}`, cwd: directory });
  terminal.show();
}

async function findInFolder(node) {
  const directory = nodeDirectory(node);
  if (!directory) return;
  await vscode.commands.executeCommand('workbench.action.findInFolder', vscode.Uri.file(directory));
}

async function copyPath(provider, node, relative) {
  const target = nodePath(node);
  if (!target) return;
  let value = target;
  if (relative) {
    const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (root) value = path.relative(root.uri.fsPath, target).replace(/\\/g, '/');
  }
  await vscode.env.clipboard.writeText(value);
  vscode.window.setStatusBarMessage(relative ? `已复制相对路径: ${value}` : `已复制路径: ${value}`, 2500);
}

async function renameNode(provider, node) {
  if (!node || !['file', 'filter'].includes(node.kind)) return;
  if (isVirtualFilterRoot(node)) return vscode.window.showInformationMessage('“源文件/头文件”等分类是虚拟筛选器，不能重命名。');
  const source = nodePath(node);
  if (!source || !fs.existsSync(source)) return vscode.window.showErrorMessage('该节点没有对应的本地文件夹或文件。');
  const nextName = await vscode.window.showInputBox({ prompt: '输入新名称', value: path.basename(source), validateInput: value => value && !value.includes('/') && !value.includes('\\') ? null : '名称不能包含路径' });
  if (!nextName || nextName === path.basename(source)) return;
  const destination = path.join(path.dirname(source), nextName.trim());
  if (fs.existsSync(destination)) return vscode.window.showErrorMessage('目标名称已存在。');
  fs.renameSync(source, destination);
  const context = projectNodeContext(provider, node);
  if (context) updateProjectReferences(context.projectFile, projectRelative(context.projectFile, source), projectRelative(context.projectFile, destination));
  await reloadProvider(provider);
}

async function deleteNode(provider, node) {
  if (!node || !['file', 'filter'].includes(node.kind)) return;
  if (isVirtualFilterRoot(node)) return vscode.window.showInformationMessage('“源文件/头文件”等分类是虚拟筛选器，不能删除。');
  const target = nodePath(node);
  if (!target || !fs.existsSync(target)) return;
  const answer = await vscode.window.showWarningMessage(`确定删除“${path.basename(target)}”吗？`, { modal: true }, '删除');
  if (answer !== '删除') return;
  const context = projectNodeContext(provider, node);
  if (context) removeProjectReferences(context.projectFile, projectRelative(context.projectFile, target));
  fs.rmSync(target, { recursive: true, force: true });
  await reloadProvider(provider);
}

async function cutNode(node) {
  if (isVirtualFilterRoot(node)) return;
  const target = nodePath(node);
  if (target) {
    fileClipboard = { source: target, mode: 'cut' };
    await vscode.commands.executeCommand('setContext', 'uacsSolutionExplorer.canPaste', true);
  }
}

async function copyNode(node) {
  if (isVirtualFilterRoot(node)) return;
  const target = nodePath(node);
  if (target) {
    fileClipboard = { source: target, mode: 'copy' };
    await vscode.commands.executeCommand('setContext', 'uacsSolutionExplorer.canPaste', true);
  }
}

async function pasteNode(provider, node) {
  if (!fileClipboard || !fs.existsSync(fileClipboard.source)) return vscode.window.showInformationMessage('剪贴板中没有可粘贴的文件或文件夹。');
  const directory = nodeDirectory(node);
  if (!directory) return;
  const destination = uniqueDestination(directory, path.basename(fileClipboard.source));
  const sourceContext = node && node.projectInfo ? projectNodeContext(provider, node) : null;
  if (fileClipboard.mode === 'cut') fs.renameSync(fileClipboard.source, destination);
  else fs.cpSync(fileClipboard.source, destination, { recursive: true });
  const context = projectNodeContext(provider, node);
  if (context) {
    const stat = fs.statSync(destination);
    if (stat.isDirectory()) {
      const visit = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const current = path.join(dir, entry.name);
          if (entry.isDirectory()) visit(current);
          else addFileToProject(context.projectFile, current, node.filterPath || defaultFilterForType(itemTypeForFile(current)));
        }
      };
      visit(destination);
    } else addFileToProject(context.projectFile, destination, node.filterPath || defaultFilterForType(itemTypeForFile(destination)));
    if (fileClipboard.mode === 'cut' && sourceContext && sourceContext.projectFile === context.projectFile) {
      removeProjectReferences(context.projectFile, projectRelative(context.projectFile, fileClipboard.source));
    }
  }
  fileClipboard = null;
  await vscode.commands.executeCommand('setContext', 'uacsSolutionExplorer.canPaste', false);
  await reloadProvider(provider);
}

async function addDirectoryToChat(node, newSession) {
  const directory = nodeDirectory(node);
  if (!directory) return;
  const candidates = newSession ? ['workbench.action.chat.newSession', 'cursor.newChat'] : ['workbench.action.chat.open', 'cursor.openChat'];
  for (const command of candidates) {
    try {
      await vscode.commands.executeCommand(command, { resource: vscode.Uri.file(directory), query: `@${directory}` });
      return;
    } catch (_) { /* Cursor versions expose different chat command ids. */ }
  }
  await vscode.env.clipboard.writeText(directory);
  vscode.window.showInformationMessage('当前版本未提供 Cursor Chat 命令，目录路径已复制到剪贴板。');
}

function activate(context) {
  const provider = new SolutionProvider();
  vscode.commands.executeCommand('setContext', 'uacsSolutionExplorer.canPaste', false);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('uacs-solution-tree', provider));
  const workspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const config = () => vscode.workspace.getConfiguration('uacsSolutionExplorer');
  const loadConfigured = async () => {
    if (!workspace) return vscode.window.showWarningMessage('请先打开 UACS 工作区文件夹。');
    const file = await findSolution(workspace.uri.fsPath, config().get('solutionPath'));
    if (!file) return vscode.window.showErrorMessage('找不到 .sln 文件，请执行“UACS: 选择解决方案文件”。');
    try { await provider.load(file); vscode.window.setStatusBarMessage(`VS解决方案: ${path.basename(file)}`, 3000); }
    catch (error) { vscode.window.showErrorMessage(`解析解决方案失败: ${error.message}`); }
  };
  context.subscriptions.push(vscode.commands.registerCommand('uacsSolutionExplorer.refresh', loadConfigured));
  context.subscriptions.push(vscode.commands.registerCommand('uacsSolutionExplorer.openSolution', loadConfigured));
  context.subscriptions.push(vscode.commands.registerCommand('uacsSolutionExplorer.selectSolution', async () => {
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Visual Studio Solution': ['sln'] }, openLabel: '打开解决方案' });
    if (selected && selected[0]) { await provider.load(selected[0].fsPath); await config().update('solutionPath', path.relative(workspace.uri.fsPath, selected[0].fsPath), vscode.ConfigurationTarget.Workspace); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('uacsSolutionExplorer.createFile', async node => {
    try { await createCodeFile(provider, node); }
    catch (error) { vscode.window.showErrorMessage(`新建代码文件失败: ${error.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('uacsSolutionExplorer.addExistingFile', async node => {
    try { await importCodeFiles(provider, node); }
    catch (error) { vscode.window.showErrorMessage(`导入代码文件失败: ${error.message}`); }
  }));
  const safeCommand = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(name, async node => {
    try { await handler(node); }
    catch (error) { vscode.window.showErrorMessage(`${name} 执行失败: ${error.message}`); }
  }));
  safeCommand('uacsSolutionExplorer.newFile', node => newFile(provider, node));
  safeCommand('uacsSolutionExplorer.newFolder', node => newFolder(provider, node));
  safeCommand('uacsSolutionExplorer.revealInFinder', revealInFinder);
  safeCommand('uacsSolutionExplorer.openInTerminal', openInTerminal);
  safeCommand('uacsSolutionExplorer.findInFolder', findInFolder);
  safeCommand('uacsSolutionExplorer.copyPath', node => copyPath(provider, node, false));
  safeCommand('uacsSolutionExplorer.copyRelativePath', node => copyPath(provider, node, true));
  safeCommand('uacsSolutionExplorer.rename', node => renameNode(provider, node));
  safeCommand('uacsSolutionExplorer.delete', node => deleteNode(provider, node));
  safeCommand('uacsSolutionExplorer.cut', cutNode);
  safeCommand('uacsSolutionExplorer.copy', copyNode);
  safeCommand('uacsSolutionExplorer.paste', node => pasteNode(provider, node));
  safeCommand('uacsSolutionExplorer.addDirectoryToChat', node => addDirectoryToChat(node, false));
  safeCommand('uacsSolutionExplorer.addDirectoryToNewChat', node => addDirectoryToChat(node, true));
  if (workspace) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,vcxproj,filters}');
    watcher.onDidChange(loadConfigured, null, context.subscriptions); watcher.onDidCreate(loadConfigured, null, context.subscriptions); watcher.onDidDelete(loadConfigured, null, context.subscriptions); context.subscriptions.push(watcher);
    loadConfigured();
  }
}

function deactivate() {}
module.exports = { activate, deactivate };
