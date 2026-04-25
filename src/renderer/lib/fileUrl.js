export function fileUrl(absolutePath) {
  if (!absolutePath) return null;
  const segments = absolutePath.split('/').map((s) => encodeURIComponent(s));
  return `moodmark-file://${segments.join('/')}`;
}
