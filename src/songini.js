// song.ini for a Clone Hero song folder.
export function songIni({ name, lengthMs }) {
  const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
  return [
    '[song]',
    `name = ${clean(name)}`,
    'artist = ',
    'charter = midimidi',
    'pro_drums = True',
    'diff_drums = -1',
    'diff_drums_real = -1',
    `song_length = ${Math.round(lengthMs)}`,
    'delay = 0',
    '',
  ].join('\r\n');
}
