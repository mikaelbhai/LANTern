/**
 * Compact tokeniser for code blocks.
 *
 * A full highlighter grammar per language would cost more than the whole rest
 * of the bundle, so this shares one lexer across languages and varies only the
 * keyword set, comment syntax and string delimiters. That covers the common
 * shapes (keyword / string / number / comment / function / punctuation) for the
 * languages people actually paste into chat.
 */

export type Tok = { t: string; c: TokKind };
export type TokKind =
  | 'plain'
  | 'kw'
  | 'str'
  | 'num'
  | 'com'
  | 'fn'
  | 'punc'
  | 'type'
  | 'attr';

type Lang = {
  kw: string[];
  type?: string[];
  line?: string[];
  block?: [string, string][];
  str?: string[];
  hashComment?: boolean;
};

const C_LIKE = ['//'];
const C_BLOCK: [string, string][] = [['/*', '*/']];

const COMMON_TYPES = [
  'string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'object',
  'int', 'float', 'double', 'char', 'bool', 'long', 'short', 'byte', 'u8',
  'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'usize',
  'isize', 'str', 'String', 'Vec', 'Option', 'Result', 'Self',
];

const LANGS: Record<string, Lang> = {
  javascript: {
    kw: 'const let var function return if else for while do break continue class extends new this super import export from default async await yield try catch finally throw typeof instanceof in of delete void null undefined true false switch case static get set'.split(' '),
    type: COMMON_TYPES,
    line: C_LIKE,
    block: C_BLOCK,
    str: ['"', "'", '`'],
  },
  typescript: {
    kw: 'const let var function return if else for while do break continue class extends implements interface type enum new this super import export from default async await yield try catch finally throw typeof instanceof keyof as in of delete void null undefined true false switch case public private protected readonly static abstract get set satisfies'.split(' '),
    type: COMMON_TYPES,
    line: C_LIKE,
    block: C_BLOCK,
    str: ['"', "'", '`'],
  },
  rust: {
    kw: 'fn let mut const static struct enum impl trait for while loop if else match return break continue use mod pub crate self super as where type dyn ref move async await unsafe extern in box'.split(' '),
    type: COMMON_TYPES,
    line: C_LIKE,
    block: C_BLOCK,
    str: ['"'],
  },
  python: {
    kw: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda global nonlocal yield async await in is not and or None True False del assert match case'.split(' '),
    type: ['int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes'],
    hashComment: true,
    str: ['"', "'"],
  },
  go: {
    kw: 'func package import var const type struct interface map chan go defer return if else for range switch case default break continue select fallthrough nil true false'.split(' '),
    type: COMMON_TYPES,
    line: C_LIKE,
    block: C_BLOCK,
    str: ['"', '`'],
  },
  java: {
    kw: 'public private protected class interface extends implements static final void new return if else for while do break continue switch case try catch finally throw throws import package this super abstract synchronized native enum true false null instanceof'.split(' '),
    type: COMMON_TYPES,
    line: C_LIKE,
    block: C_BLOCK,
    str: ['"', "'"],
  },
  c: {
    kw: 'int char float double void long short signed unsigned struct union enum typedef static const extern return if else for while do break continue switch case default goto sizeof include define ifdef ifndef endif'.split(' '),
    type: COMMON_TYPES,
    line: C_LIKE,
    block: C_BLOCK,
    str: ['"', "'"],
  },
  sql: {
    kw: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER ADD INDEX JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL PRIMARY KEY FOREIGN REFERENCES UNIQUE DEFAULT DISTINCT COUNT SUM AVG MIN MAX CASE WHEN THEN END'.split(' '),
    line: ['--'],
    block: C_BLOCK,
    str: ["'", '"'],
  },
  bash: {
    kw: 'if then else elif fi for while do done case esac function return export local echo cd ls source alias unset read set in select time until'.split(' '),
    hashComment: true,
    str: ['"', "'"],
  },
  json: { kw: ['true', 'false', 'null'], str: ['"'] },
  yaml: { kw: ['true', 'false', 'null', 'yes', 'no'], hashComment: true, str: ['"', "'"] },
  html: { kw: [], block: [['<!--', '-->']], str: ['"', "'"] },
  css: { kw: 'important media import keyframes from to and not only supports'.split(' '), block: C_BLOCK, str: ['"', "'"] },
};

const ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  rs: 'rust', golang: 'go',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  'c++': 'c', cpp: 'c', cxx: 'c', h: 'c', hpp: 'c', cs: 'java', csharp: 'java',
  kt: 'java', kotlin: 'java', swift: 'java', scala: 'java', dart: 'java',
  php: 'c', ruby: 'python', rb: 'python', perl: 'python', lua: 'python',
  r: 'python', julia: 'python', elixir: 'python', ex: 'python',
  postgres: 'sql', mysql: 'sql', sqlite: 'sql', psql: 'sql',
  yml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml',
  xml: 'html', svg: 'html', vue: 'html', htm: 'html',
  scss: 'css', sass: 'css', less: 'css',
  md: 'plain', markdown: 'plain', txt: 'plain', text: 'plain', diff: 'plain',
};

export function normalizeLang(lang: string): string {
  const l = (lang || '').toLowerCase().trim();
  return ALIAS[l] ?? (LANGS[l] ? l : 'plain');
}

const isIdent = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

export function tokenize(src: string, langName: string): Tok[] {
  const lang = LANGS[normalizeLang(langName)];
  if (!lang) return [{ t: src, c: 'plain' }];

  const kw = new Set(lang.kw);
  const kwLower = new Set(lang.kw.map((k) => k.toLowerCase()));
  const types = new Set(lang.type ?? []);
  const lineComs = [...(lang.line ?? []), ...(lang.hashComment ? ['#'] : [])];
  const strDelims = lang.str ?? ['"'];

  const out: Tok[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ t: buf, c: 'plain' });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    const lc = lineComs.find((c) => rest.startsWith(c));
    if (lc) {
      flush();
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out.push({ t: src.slice(i, stop), c: 'com' });
      i = stop;
      continue;
    }

    const bc = (lang.block ?? []).find(([open]) => rest.startsWith(open));
    if (bc) {
      flush();
      const end = src.indexOf(bc[1], i + bc[0].length);
      const stop = end === -1 ? src.length : end + bc[1].length;
      out.push({ t: src.slice(i, stop), c: 'com' });
      i = stop;
      continue;
    }

    const q = strDelims.find((d) => rest.startsWith(d));
    if (q) {
      flush();
      let j = i + q.length;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src.startsWith(q, j)) {
          j += q.length;
          break;
        }
        j++;
      }
      out.push({ t: src.slice(i, Math.min(j, src.length)), c: 'str' });
      i = j;
      continue;
    }

    if (/[0-9]/.test(src[i]) && !isIdent(src[i - 1] ?? '')) {
      flush();
      let j = i;
      while (j < src.length && /[0-9a-fA-FxX._]/.test(src[j])) j++;
      out.push({ t: src.slice(i, j), c: 'num' });
      i = j;
      continue;
    }

    if (isIdent(src[i]) && !/[0-9]/.test(src[i])) {
      let j = i;
      while (j < src.length && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      const nextCh = src.slice(j).match(/^\s*\(/);
      flush();
      if (kw.has(word) || kwLower.has(word.toLowerCase())) {
        out.push({ t: word, c: 'kw' });
      } else if (types.has(word) || /^[A-Z][a-zA-Z0-9_]*$/.test(word)) {
        out.push({ t: word, c: 'type' });
      } else if (nextCh) {
        out.push({ t: word, c: 'fn' });
      } else {
        out.push({ t: word, c: 'plain' });
      }
      i = j;
      continue;
    }

    if (/[{}()[\];,.:+\-*/%=<>!&|^~?@#]/.test(src[i])) {
      flush();
      out.push({ t: src[i], c: 'punc' });
      i++;
      continue;
    }

    buf += src[i];
    i++;
  }
  flush();
  return out;
}

export const TOKEN_CLASS: Record<TokKind, string> = {
  plain: 'text-txt',
  kw: 'text-[#C792EA]',
  str: 'text-[#8BD49C]',
  num: 'text-[#F78C6C]',
  com: 'text-muted italic',
  fn: 'text-[#82AAFF]',
  punc: 'text-dim',
  type: 'text-[#FFCB6B]',
  attr: 'text-cyan',
};

export const LANGUAGE_NAMES = Object.keys({ ...LANGS, ...ALIAS }).sort();
