const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseSolution, parseProject, buildTree, displayGroup } = require('./src/model');

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
  if (workspace) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,vcxproj,filters}');
    watcher.onDidChange(loadConfigured, null, context.subscriptions); watcher.onDidCreate(loadConfigured, null, context.subscriptions); watcher.onDidDelete(loadConfigured, null, context.subscriptions); context.subscriptions.push(watcher);
    loadConfigured();
  }
}

function deactivate() {}
module.exports = { activate, deactivate };
