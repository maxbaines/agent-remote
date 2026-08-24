/** Browser-window identity for users connected to more than one Host. */

const GENERIC_HOSTS = new Set(['localhost', '127.0.0.1', '']);

/** Use the Host name when it distinguishes this instance; use the product name locally. */
export function instanceLabel(loc: Pick<Location, 'hostname'> = window.location): string {
  const host = loc.hostname;
  return GENERIC_HOSTS.has(host) ? 'Agent Remote' : host;
}

/** Keep browser tabs and installed PWA windows identifiable without changing product chrome. */
export function applyDocumentTitle(loc: Pick<Location, 'hostname'> = window.location): void {
  const label = instanceLabel(loc);
  document.title = label === 'Agent Remote' ? 'Agent Remote' : `Agent Remote — ${label}`;
}
