/**
 * Working out what a subtitle track is from what it says.
 *
 * A release can carry a dozen subtitle files whose container says nothing
 * about them - language "und", no name - and the menu then reads
 * "Undetermined 1" to "Undetermined 11", which is no help in choosing one.
 * The text itself is the one reliable witness: its script says a great deal
 * and its commonest words say most of the rest. Tracks that do state a
 * language never come through here.
 */
import { parseVtt } from './Subtitles';

export interface Detected {
  /** ISO 639-2 code, which `languageName` turns into a name. */
  lang: string;
  /** What kind of track, where it can be told: "SDH" or "forced". */
  kind: '' | 'SDH' | 'forced';
}

/** Scripts that name a language, or nearly, on their own. */
const SCRIPTS: [RegExp, string][] = [
  [/[぀-ヿ]/g, 'jpn'],
  [/[가-힯]/g, 'kor'],
  [/[֐-׿]/g, 'heb'],
  [/[฀-๿]/g, 'tha'],
  [/[Ͱ-Ͽ]/g, 'ell'],
  [/[ऀ-ॿ]/g, 'hin'],
  [/[ঀ-৿]/g, 'ben'],
  [/[஀-௿]/g, 'tam'],
  [/[ఀ-౿]/g, 'tel'],
  [/[一-鿿]/g, 'zho'],
];

/** The commonest words of each Latin-script language that others do not share. */
const WORDS: Record<string, string> = {
  eng: 'the and you that is it to of in i what this not have me for was he she we they are with be on your do but know just no yes get can will',
  fra: 'le la les de des est une que pas vous je tu et un pour dans ce qui sur avec il elle nous mais ne suis oui non cest',
  spa: 'el la los las que de y en un una es no por para con te lo se su pero como yo tú está muy sí',
  por: 'o a os as que de e um uma não você com para em se do da mas eu é está sim muito',
  ita: 'il la che di è un per non sono mi ti con una questo ma lo le si come anche ho sei',
  deu: 'der die das und ist nicht ich du ein zu mit sie es wir auf für den ja nein aber was',
  nld: 'de het een en ik je niet dat van is op te zijn met voor maar ook dit wat',
  tur: 'bir bu ve ben sen için ne değil de da çok var evet hayır ama ki o şey',
  ind: 'yang dan itu ini aku kamu tidak di ke dengan untuk ada saya apa dia akan',
  pol: 'nie to się jest że na ja ty co jak tak ale do w z czy mnie',
  swe: 'och att det är jag du inte en på som för med har den ett vi',
  dan: 'og jeg er det ikke du en til som på for med har han den vi',
  fin: 'ja on ei että se minä sinä en oli mutta kyllä hän te me',
  ron: 'și nu este un să la eu tu de în ce pe cu mai dar da',
  ces: 'je se to na že ne ale ty já v s do jsem jak co',
  hun: 'hogy nem egy az és én te ez de mit van volt',
  vie: 'là và của không tôi bạn có một này được đã cho những',
  // Cyrillic ones are separated by their words too, since the script alone is shared.
  rus: 'я не что это ты в и на с как он да но мы вы был его так',
  ukr: 'я не що це ти в і на з як він так але ми ви був його',
  bul: 'аз не че това ти в и на с как той да но ние вие беше го',
};

const SETS = Object.fromEntries(
  Object.entries(WORDS).map(([lang, list]) => [lang, new Set(list.split(/\s+/))]),
) as Record<string, Set<string>>;

/** Letters that give a Latin-script language away on their own. */
const HINTS: [RegExp, string, number][] = [
  [/[ñ¿¡]/g, 'spa', 3],
  [/[ãõ]/g, 'por', 3],
  [/[ß]/g, 'deu', 3],
  [/[ığş]/g, 'tur', 3],
  [/[ąęłźż]/g, 'pol', 3],
  [/[ăș]/g, 'ron', 3],
];

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Strips the markup a subtitle line carries, leaving what is read. */
function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)|♪[^♪]*♪/g, ' ');
}

/**
 * The language of a subtitle file, or null where it cannot be told.
 *
 * Null is a real answer: a few lines of names and numbers say nothing, and
 * guessing would put a wrong name on the menu, which is worse than the
 * honest "Undetermined" it was meant to improve on.
 */
export function detectLanguage(vtt: string): Detected | null {
  const cues = parseVtt(vtt);
  if (cues.length === 0) return null;

  const sample = cues
    .slice(0, 400)
    .map((c) => plain(c.text))
    .join(' ')
    .toLowerCase();

  // A track that carries sound descriptions is the SDH one; one with very few
  // lines is signs and foreign dialogue only.
  const described = cues.filter((c) => /\[[^\]]+\]|\([^)]+\)|♪/.test(c.text)).length;
  const kind: Detected['kind'] =
    cues.length < 60 ? 'forced' : described / cues.length > 0.04 ? 'SDH' : '';

  // Script first. Kana beats ideographs: Japanese writes both.
  let best: [string, number] = ['', 0];
  for (const [re, lang] of SCRIPTS) {
    const n = count(sample, re);
    if (n > best[1]) best = [lang, n];
  }
  const letters = sample.replace(/[^\p{L}]/gu, '').length || 1;
  if (best[1] / letters > 0.2) {
    const lang = best[0] === 'zho' && count(sample, /[぀-ヿ]/g) > 5 ? 'jpn' : best[0];
    return { lang, kind };
  }

  // Arabic script: Persian and Urdu have letters Arabic does not.
  const arabic = count(sample, /[؀-ۿݐ-ݿ]/g);
  if (arabic / letters > 0.2) {
    const lang = count(sample, /[ٹڈڑںے]/g) > 3 ? 'urd' : count(sample, /[پچژگ]/g) > 3 ? 'fas' : 'ara';
    return { lang, kind };
  }

  // Everything else is read by its commonest words, helped by telltale letters.
  const tokens = sample.split(/[^\p{L}']+/u).filter(Boolean);
  if (tokens.length < 30) return null;

  const scores: Record<string, number> = {};
  for (const [lang, set] of Object.entries(SETS)) {
    let hits = 0;
    for (const t of tokens) if (set.has(t)) hits++;
    scores[lang] = hits / tokens.length;
  }
  for (const [re, lang, weight] of HINTS) {
    scores[lang] = (scores[lang] ?? 0) + (count(sample, re) / tokens.length) * weight;
  }
  // Ukrainian has four letters Russian does not.
  if (count(sample, /[іїєґ]/g) > 3) scores.ukr = (scores.ukr ?? 0) + 0.2;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, runnerUp] = ranked;
  // A clear winner with real support, or no answer.
  if (!top || top[1] < 0.08 || (runnerUp && top[1] < runnerUp[1] * 1.25)) return null;
  return { lang: top[0], kind };
}
