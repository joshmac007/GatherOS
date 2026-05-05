// afterPack hook — runs after electron-builder copies the Electron
// framework into the .app bundle, BEFORE codesign walks every file.
//
// Strips gendered/neutered locale variants (e.g. es_419_NEUTER.lproj,
// ar_MASCULINE.lproj, th_NEUTER.lproj). They aren't standard locale
// codes so electronLanguages doesn't filter them out, and on macOS
// 15+ they're flagged with a restricted attribute that makes
// `codesign --force` fail with "Operation not permitted" — taking
// the whole release down with it.
//
// Removing them is safe: they're regional Spanish / gendered-language
// variants we don't ship UI strings for, and the standard locale
// fallback (es.lproj, etc.) renders identically for users of those
// languages.

const fs = require('node:fs');
const path = require('node:path');

const VARIANT_RE = /_(MASCULINE|FEMININE|NEUTER)\.lproj$/;

function stripDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(dir)) {
    if (VARIANT_RE.test(entry)) {
      const full = path.join(dir, entry);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(entry);
      } catch (err) {
        console.warn(`[strip-gendered-locales] failed to remove ${full}:`, err.message);
      }
    }
  }
  return removed;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appRoot = path.join(context.appOutDir, `${appName}.app`);

  // Two paths the variant lprojs can show up under depending on the
  // electron-builder version + macOS framework layout:
  //   .../Frameworks/Electron Framework.framework/Resources/...
  //   .../Frameworks/Electron Framework.framework/Versions/A/Resources/...
  const candidates = [
    path.join(appRoot, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources'),
    path.join(appRoot, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'),
  ];

  let totalRemoved = 0;
  for (const dir of candidates) {
    const removed = stripDir(dir);
    totalRemoved += removed.length;
  }
  if (totalRemoved > 0) {
    console.log(`[strip-gendered-locales] removed ${totalRemoved} variant locale dir(s)`);
  }
};
