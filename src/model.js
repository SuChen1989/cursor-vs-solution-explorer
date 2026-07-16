const fs = require('fs');
const path = require('path');

const SOLUTION_FOLDER_GUID = '2150E333-8FDC-42A3-9474-1A3956D46DE8';

function readText(file) {
  const data = fs.readFileSync(file);
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return data.subarray(3).toString('utf8');
  }
  try {
    const utf8 = data.toString('utf8');
    if (!utf8.includes('\ufffd')) return utf8;
  } catch (_) { /* fall through */ }
  // Visual Studio projects in this repository contain Chinese GB18030 text.
  try { return new TextDecoder('gb18030').decode(data); } catch (_) { return data.toString(); }
}

function xmlEntities(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseSolution(file) {
  const text = readText(file);
  const projects = [];
  const projectByGuid = new Map();
  const projectRe = /Project\("\{([^}]+)\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"\{([^}]+)\}"/g;
  let match;
  while ((match = projectRe.exec(text))) {
    const item = {
      typeGuid: match[1].toUpperCase(), name: match[2], relativePath: match[3].replace(/\\/g, '/'),
      guid: match[4].toUpperCase(), isSolutionFolder: match[1].toUpperCase() === SOLUTION_FOLDER_GUID,
      solutionItems: []
    };
    const start = match.index;
    const next = text.indexOf('\nProject(', start + 1);
    const block = text.slice(start, next < 0 ? text.length : next);
    const itemRe = /^\s*([^=\r\n]+?)\s*=\s*(.+?)\s*$/gm;
    if (item.isSolutionFolder) {
      let itemMatch;
      while ((itemMatch = itemRe.exec(block))) {
        if (itemMatch[1].includes('\\') || itemMatch[1].includes('/')) {
          item.solutionItems.push({ name: path.basename(itemMatch[1].trim()), relativePath: itemMatch[1].trim().replace(/\\/g, '/') });
        }
      }
    }
    projects.push(item); projectByGuid.set(item.guid, item);
  }
  const nested = new Map();
  const nestedSection = text.match(/GlobalSection\(NestedProjects\)[\s\S]*?EndGlobalSection/);
  if (nestedSection) {
    const nestedRe = /\{([^}]+)\}\s*=\s*\{([^}]+)\}/g;
    let nestedMatch;
    while ((nestedMatch = nestedRe.exec(nestedSection[0]))) nested.set(nestedMatch[1].toUpperCase(), nestedMatch[2].toUpperCase());
  }
  for (const project of projects) project.parentGuid = nested.get(project.guid) || null;
  return { file, name: path.basename(file, path.extname(file)), projects, projectByGuid };
}

function projectItems(vcxproj) {
  if (!fs.existsSync(vcxproj)) return [];
  const text = readText(vcxproj);
  const itemRe = /<(ClCompile|ClInclude|ResourceCompile|None|Content|CustomBuild|Natvis|Midl|Image|JavaScriptCompile)\b[^>]*\bInclude="([^"]+)"[^>]*>/g;
  const items = []; let m;
  while ((m = itemRe.exec(text))) items.push({ kind: m[1], include: xmlEntities(m[2]).replace(/\\/g, '/') });
  return items;
}

function filterItems(filtersFile) {
  if (!fs.existsSync(filtersFile)) return new Map();
  const text = readText(filtersFile);
  const map = new Map();
  const itemRe = /<(ClCompile|ClInclude|ResourceCompile|None|Content|CustomBuild|Natvis|Midl|Image|JavaScriptCompile)\b[^>]*\bInclude="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = itemRe.exec(text))) {
    const filter = m[3].match(/<Filter>([\s\S]*?)<\/Filter>/);
    map.set(xmlEntities(m[2]).replace(/\\/g, '/'), filter ? xmlEntities(filter[1]).replace(/\\/g, '/') : '');
  }
  return map;
}

function displayGroup(kind) {
  if (kind === 'ClCompile') return '源文件';
  if (kind === 'ClInclude') return '头文件';
  if (kind === 'ResourceCompile' || kind === 'Image') return '资源文件';
  return '其他文件';
}

function parseProject(projectFile) {
  const dir = path.dirname(projectFile);
  const items = projectItems(projectFile);
  const filters = filterItems(projectFile + '.filters');
  return { file: projectFile, name: path.basename(projectFile, path.extname(projectFile)), items, filters, dir };
}

function buildTree(solution) {
  const children = new Map();
  for (const project of solution.projects) children.set(project.guid, []);
  const roots = [];
  for (const project of solution.projects) {
    const parent = project.parentGuid && children.has(project.parentGuid) ? children.get(project.parentGuid) : roots;
    parent.push(project);
  }
  return roots;
}

module.exports = { readText, parseSolution, parseProject, buildTree, displayGroup, SOLUTION_FOLDER_GUID };
