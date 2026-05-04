import React from 'react';

// SF Symbols via the system SF Pro font's private-use code points.
// Apple ships SF Pro with macOS 11+, and the symbols live in the
// Supplementary Private Use Area-A (codepoints above 0x100000).
// Setting `font-family: -apple-system` on a span containing one of
// these characters renders the native SF Symbol — same weight,
// scale, and optical alignment Apple's own apps get.
//
// Adding a new symbol:
//   1. Open SF Symbols.app on macOS.
//   2. Click the symbol you want.
//   3. In the right inspector, click the "Code" tab and copy the
//      Unicode value (it'll look like "100186").
//   4. Add an entry below with a friendly name and `0x100186`.
//
// If a symbol renders as a hollow box ▯ at runtime, the codepoint
// has shifted in your installed SF Symbols version — update it
// from the inspector. Apple does not document these codepoints
// as a stable API, but they're stable enough across point
// releases to be practical.
const SYMBOLS = {
  // Verified against SF Symbols 5.x. If any renders as ▯ on your
  // system, look it up in SF Symbols.app's inspector.
  search: 0x100307,        // magnifyingglass
  trash: 0x10018A,         // trash
  folder: 0x10038D,        // folder
  plus: 0x10009A,          // plus
  gear: 0x100322,          // gearshape
  star: 0x100184,          // star
  ellipsis: 0x100196,      // ellipsis
  arrow_back: 0x1001D5,    // arrow.uturn.backward
  square_on_square: 0x1006FA, // square.on.square (Find similar)
  bell: 0x10038C,          // bell
};

export default function SfSymbol({
  name,
  codepoint,
  size = 16,
  weight = 400,
  className,
  style,
}) {
  const cp = codepoint ?? (name ? SYMBOLS[name] : null);
  if (!cp) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[SfSymbol] unknown symbol: ${name ?? '(no name)'}`);
    }
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        // -apple-system resolves to the system SF Pro font on macOS,
        // which contains SF Symbols. The fallback chain is just for
        // safety — on a correctly-resolved Mac this is the only one
        // that ever fires.
        fontFamily: '"SF Pro", "SF Pro Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        fontSize: size,
        fontWeight: weight,
        lineHeight: 1,
        // SF Symbols render with their own optical baseline; flex-
        // centering keeps them vertically aligned with adjacent text
        // and the existing inline-SVG icons.
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Inherit the surrounding text color so the symbol picks up
        // currentColor like the SVG icons it's replacing.
        color: 'currentColor',
        // Disable kerning / ligature shenanigans that might shift
        // the glyph horizontally inside its box.
        fontFeatureSettings: '"kern" 0',
        fontVariantLigatures: 'none',
        ...style,
      }}
    >
      {String.fromCodePoint(cp)}
    </span>
  );
}

SfSymbol.SYMBOLS = SYMBOLS;
