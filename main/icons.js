// The Material Icon Theme (the `material-icon-theme` npm package): its manifest and icon names.
const path = require('path');
const fs = require('fs');

const ICON_THEME = path.join(__dirname, '..', 'node_modules', 'material-icon-theme');

// The parts of the icon theme's manifest the renderer needs to pick a file/folder icon.
let manifest = null;
function iconManifest() {
  if (manifest) return manifest;
  const m = JSON.parse(fs.readFileSync(path.join(ICON_THEME, 'dist', 'material-icons.json'), 'utf8'));
  manifest = {
    // id -> svg file name, so the renderer can build ../node_modules/material-icon-theme/icons/<file>
    defs: Object.fromEntries(Object.entries(m.iconDefinitions).map(([id, d]) => [id, path.basename(d.iconPath)])),
    file: m.file,
    folder: m.folder,
    folderExpanded: m.folderExpanded,
    fileNames: m.fileNames,
    fileExtensions: m.fileExtensions,
    languageIds: m.languageIds,
    folderNames: m.folderNames,
    folderNamesExpanded: m.folderNamesExpanded,
  };
  return manifest;
}

// Every icon's name, for the repo icon picker.
let names = null;
async function iconNames() {
  // Skip the "-open" folder states and "_light" theme variants: they're duplicates in the picker.
  names ??= (await fs.promises.readdir(path.join(ICON_THEME, 'icons')))
    .filter((f) => f.endsWith('.svg') && !/(-open|_light)\.svg$/.test(f))
    .map((f) => f.slice(0, -4))
    .sort();
  return names;
}

module.exports = { iconManifest, iconNames };
