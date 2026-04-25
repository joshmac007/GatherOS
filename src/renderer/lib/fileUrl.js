export function fileUrl(absolutePath) {
  if (!absolutePath) return null;
  // Encode the entire path as a single opaque segment so Chromium's URL
  // parser can't accidentally turn "/Users" into an authority.
  return `moodmark-file://local/${encodeURIComponent(absolutePath)}`;
}
