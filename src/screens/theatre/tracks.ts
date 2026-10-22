/**
 * Turning raw track metadata into something readable.
 *
 * A release like this one carries 35 subtitle tracks whose labels arrive as
 * `eng · Timed text` — the language code and the codec, neither of which helps
 * anyone choose. Worse, the same language appears several times (full
 * subtitles, signs and songs, SDH) with nothing to tell them apart, so the
 * menu reads as a wall of identical rows.
 */

/**
 * ISO 639-2 codes to language names.
 *
 * `Intl.DisplayNames` handles most three-letter codes, but not all of them and
 * not on every platform, so the answer is checked before it is used.
 */
const FALLBACK: Record<string, string> = {
  eng: 'English',
  spa: 'Spanish',
  por: 'Portuguese',
  fra: 'French',
  fre: 'French',
  deu: 'German',
  ger: 'German',
  ita: 'Italian',
  jpn: 'Japanese',
  kor: 'Korean',
  zho: 'Chinese',
  chi: 'Chinese',
  ara: 'Arabic',
  bul: 'Bulgarian',
  ces: 'Czech',
  cze: 'Czech',
  dan: 'Danish',
  ell: 'Greek',
  gre: 'Greek',
  est: 'Estonian',
  fin: 'Finnish',
  heb: 'Hebrew',
  hun: 'Hungarian',
  ind: 'Indonesian',
  lit: 'Lithuanian',
  lav: 'Latvian',
  nld: 'Dutch',
  dut: 'Dutch',
  nor: 'Norwegian',
  pol: 'Polish',
  ron: 'Romanian',
  rum: 'Romanian',
  rus: 'Russian',
  slk: 'Slovak',
  slo: 'Slovak',
  slv: 'Slovenian',
  swe: 'Swedish',
  tha: 'Thai',
  tur: 'Turkish',
  ukr: 'Ukrainian',
  vie: 'Vietnamese',
  hin: 'Hindi',
  tam: 'Tamil',
  tel: 'Telugu',
  msa: 'Malay',
  may: 'Malay',
};

let display: Intl.DisplayNames | null | undefined;

/** A language code as a name, or the code itself when there is no better one. */
export function languageName(code: string): string {
  const key = code.trim().toLowerCase();
  if (!key) return '';
  // Matroska and MP4 both write "und" when the muxer was told nothing. Intl
  // renders that as "root", which is worse than saying so plainly.
  if (key === 'und' || key === 'mis' || key === 'zxx' || key === 'root') return 'Undetermined';
  if (FALLBACK[key]) return FALLBACK[key];

  if (display === undefined) {
    try {
      display = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      display = null;
    }
  }

  try {
    const name = display?.of(key);
    // A code it does not know is echoed back unchanged; that is not a name.
    if (name && name.toLowerCase() !== key) return name;
  } catch {
    /* not a well-formed code */
  }

  return code;
}

/**
 * The name a person gave a track, if the label carries one.
 *
 * The backend's own labels are "language · codec" or "Track 3" when the file
 * offered nothing, and neither is a name worth showing in place of the
 * honest "Undetermined".
 */
function authoredName(label: string | undefined): string {
  const first = (label ?? '').split('·')[0].trim();
  if (!first) return '';
  if (/^(und|mis|zxx|root)$/i.test(first)) return '';
  if (/^track(\s+\d+)?$/i.test(first)) return '';
  // A bare language code is what languageName already tried.
  if (/^[a-z]{2,3}$/i.test(first)) return '';
  return first;
}

/**
 * Names a list of tracks so no two rows read the same.
 *
 * Where a language occurs more than once the copies are numbered, which is the
 * only honest thing to do: the file says nothing about which is forced, which
 * is SDH, and which is the plain track. A number at least makes them
 * distinguishable and stable between sessions.
 */
export function trackNames(
  tracks: { lang?: string; label?: string; kind?: string }[],
): string[] {
  const base = tracks.map((t) => {
    let name = languageName(t.lang ?? '');
    // "und" is the muxer saying it was told nothing, not a name. A track that
    // the author titled ("English [SDH]", "Director's commentary") says more
    // than that, and used to be shown as "Undetermined 4" anyway because the
    // language code always won.
    if (!name || name === 'Undetermined') {
      const authored = authoredName(t.label);
      if (authored) name = authored;
      else if (!name) name = 'Track';
    }
    return t.kind ? `${name} (${t.kind})` : name;
  });

  const totals = new Map<string, number>();
  for (const name of base) totals.set(name, (totals.get(name) ?? 0) + 1);

  const seen = new Map<string, number>();
  return base.map((name) => {
    if ((totals.get(name) ?? 0) < 2) return name;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return `${name} ${n}`;
  });
}
