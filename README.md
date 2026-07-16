# UACS VS Solution Explorer

This local Cursor extension adds a separate VS-style solution tree for this repository. It reads `UACS_GG5.sln`, all referenced `.vcxproj` files, and `.vcxproj.filters`, while opening the original files in place so clangd paths remain unchanged.

The extension is intentionally read-only for the solution tree. Use the normal Explorer or Visual Studio to edit project files.

## Install for development

Open this directory in Cursor and run `Developer: Install Extension from Location...`, then reload Cursor. The default solution path is `Source/New_Server/UACS_GG5.sln`; it can be changed with `uacsSolutionExplorer.solutionPath`.
