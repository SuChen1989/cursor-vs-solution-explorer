# UACS VS Solution Explorer

This local Cursor extension adds a separate VS-style solution tree for this repository. It reads `UACS_GG5.sln`, all referenced `.vcxproj` files, and `.vcxproj.filters`, while opening the original files in place so clangd paths remain unchanged.

右键项目节点或项目下的子文件夹可以使用“新建代码文件”和“导入现有代码文件”。扩展会把文件写入对应项目/子文件夹，并同步更新 `.vcxproj` 与 `.vcxproj.filters`；新建文件默认使用 UTF-8。

右键菜单还提供新建文件夹、Finder/集成终端、Cursor Chat、文件夹查找、剪切/复制/粘贴、复制路径、重命名和删除等操作。

资源管理器标题栏提供解决方案文件搜索、当前文件定位、启动项目设置和构建/清理入口；构建与清理命令需要在设置中填写 `uacsSolutionExplorer.buildCommand`、`uacsSolutionExplorer.cleanCommand`，支持 `${solution}`、`${project}`、`${projectName}` 占位符。活动栏中的“错误与警告”视图会汇总当前解决方案目录内的诊断信息。

## Install for development

Open this directory in Cursor and run `Developer: Install Extension from Location...`, then reload Cursor. The default solution path is `Source/New_Server/UACS_GG5.sln`; it can be changed with `uacsSolutionExplorer.solutionPath`.
