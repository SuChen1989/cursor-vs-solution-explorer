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
  solutionFolderNode(project) { const n = new SolutionNode(project.name, 'solutionFolder', null, vscode.TreeItemCollapsibleState.Collapsed); n.project = project; return n; }
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
      const files = entry.items.map(item => {
        const relative = item.include; return new SolutionNode(path.basename(relative), 'file', path.normalize(path.join(project.dir, relative)));
      });
      // Keep folders before files at every level, matching Visual Studio.
      node.children.push(...make(entry.children, parentPath ? `${parentPath}\\${label}` : label));
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

async function chooseProject(provider, node) {
  if (node && node.kind === 'project' && node.projectInfo) return node.projectInfo;
  const picked = await vscode.window.showQuickPick(projectChoices(provider), { placeHolder: '选择要修改的 C++ 项目' });
  return picked && picked.project;
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
  const projectInfo = await chooseProject(provider, node);
  if (!projectInfo) return;
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
  const target = path.resolve(path.dirname(projectFile), relative);
  if (target !== path.dirname(projectFile) && !target.startsWith(`${path.dirname(projectFile)}${path.sep}`)) {
    return vscode.window.showErrorMessage('新文件必须位于项目目录内。');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) return vscode.window.showErrorMessage(`文件已存在：${relative}`);
  fs.writeFileSync(target, '', 'utf8');
  appendProjectItem(projectFile, typeChoice.itemType, relative);
  appendFilterItem(projectFile, typeChoice.itemType, relative, defaultFilterForType(typeChoice.itemType));
  await reloadProvider(provider);
  await vscode.window.showTextDocument(vscode.Uri.file(target));
  vscode.window.setStatusBarMessage(`已新建并加入 ${projectInfo.name}: ${relative}`, 4000);
}

async function importCodeFiles(provider, node) {
  const projectInfo = await chooseProject(provider, node);
  if (!projectInfo) return;
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: '导入到项目',
    filters: { 'C/C++ 代码文件': ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'inl', 'rc'] }
  });
  if (!selected || !selected.length) return;
  const projectFile = projectFilePath(provider.solutionPath, projectInfo);
  const projectDir = path.dirname(projectFile);
  let added = 0;
  for (const uri of selected) {
    const source = uri.fsPath;
    const sourceRelative = path.relative(projectDir, source);
    let target = source;
    let relative = safeRelativePath(sourceRelative);
    if (!relative || relative === '.') {
      target = uniqueDestination(projectDir, path.basename(source));
      relative = path.relative(projectDir, target).replace(/\\/g, '/');
      fs.copyFileSync(source, target);
    } else if (path.resolve(source) !== path.resolve(projectDir, relative)) {
      target = path.resolve(projectDir, relative);
    }
    const type = itemTypeForFile(target);
    if (appendProjectItem(projectFile, type, relative)) {
      appendFilterItem(projectFile, type, relative, defaultFilterForType(type));
      added += 1;
    }
  }
  await reloadProvider(provider);
  vscode.window.showInformationMessage(`已导入 ${added} 个文件到 ${projectInfo.name}。`);
}

function activate(context) {
  const provider = new SolutionProvider();
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
  if (workspace) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,vcxproj,filters}');
    watcher.onDidChange(loadConfigured, null, context.subscriptions); watcher.onDidCreate(loadConfigured, null, context.subscriptions); watcher.onDidDelete(loadConfigured, null, context.subscriptions); context.subscriptions.push(watcher);
    loadConfigured();
  }
}

function deactivate() {}
module.exports = { activate, deactivate };
