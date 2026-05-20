// afterPack hook — runs after electron-builder copies the Electron
// framework into the .app bundle, BEFORE codesign walks every file.
//
// Two things to strip before signing:
//
// 1. Gendered/neutered locale variants (e.g. es_419_NEUTER.lproj,
//    ar_MASCULINE.lproj, th_NEUTER.lproj). They aren't standard locale
//    codes so electronLanguages doesn't filter them out, and on macOS
//    15+ they're flagged with a restricted attribute that makes
//    `codesign --force` fail with "Operation not permitted" —
//    taking the whole release down with it.
//
// 2. All non-English .lproj directories (de, es, fr, ja, zh_TW, uk,
//    …). electron-builder's electronLanguages config is supposed to
//    handle this but in practice doesn't reach every framework
//    locale.pak. Each surviving locale.pak forces another
//    `codesign --timestamp` round-trip to Apple's TSA server, and
//    any one timing out fails the whole signing pass with
//    "A timestamp was expected but was not found" (the bug that
//    blocked v0.1.31 / v0.1.32 from publishing).
//
// We only ship English UI strings, so removing every non-en .lproj
// is safe — the standard locale fallback hands users their system
// language treatment from whatever's left or Base.lproj.

const fs = require('node:fs');
const path = require('node:path');

const VARIANT_RE = /_(MASCULINE|FEMININE|NEUTER)\.lproj$/;
const KEEP_LPROJ = new Set([
  'en.lproj',
  'en_GB.lproj',
  'en_US.lproj',
  'Base.lproj', // the fallback layout strings macOS uses if no match
]);

function stripDir(dir) {
  if (!fs.existsSync(dir)) return { variants: 0, locales: 0 };
  let variants = 0;
  let locales = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.lproj')) continue;
    const full = path.join(dir, entry);
    if (VARIANT_RE.test(entry)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        variants += 1;
      } catch (err) {
        console.warn(`[strip-locales] failed to remove variant ${full}:`, err.message);
      }
      continue;
    }
    if (!KEEP_LPROJ.has(entry)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        locales += 1;
      } catch (err) {
        console.warn(`[strip-locales] failed to remove locale ${full}:`, err.message);
      }
    }
  }
  return { variants, locales };
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

  let totalVariants = 0;
  let totalLocales = 0;
  for (const dir of candidates) {
    const { variants, locales } = stripDir(dir);
    totalVariants += variants;
    totalLocales += locales;
  }
  if (totalVariants > 0 || totalLocales > 0) {
    console.log(`[strip-locales] removed ${totalVariants} variant + ${totalLocales} non-English locale dir(s)`);
  }
};
