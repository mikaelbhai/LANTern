import React from 'react';
import { CodeBlock } from '../components/CodeBlock';

/**
 * Small Markdown subset rendered straight to React nodes.
 *
 * Deliberately not `dangerouslySetInnerHTML` — message bodies arrive from other
 * devices on the network, so nothing user-authored is ever parsed as HTML.
 */

type Block =
  | { k: 'p'; text: string }
  | { k: 'h'; level: number; text: string }
  | { k: 'code'; lang: string; text: string }
  | { k: 'quote'; text: string }
  | { k: 'ul'; items: string[] }
  | { k: 'ol'; items: string[]; start: number }
  | { k: 'hr' };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ k: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ k: 'hr' });
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ k: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ k: 'quote', text: body.join('\n') });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ k: 'ul', items });
      continue;
    }

    const ol = line.match(/^\s*(\d+)[.)]\s+/);
    if (ol) {
      const items: string[] = [];
      const start = parseInt(ol[1], 10);
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ k: 'ol', items, start });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|>|#{1,6}\s|[-*+]\s|\d+[.)]\s|---|\*\*\*|___)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) blocks.push({ k: 'p', text: para.join('\n') });
    else i++;
  }
  return blocks;
}

export interface InlineOpts {
  mentionNames?: Set<string>;
  onMention?: (name: string) => void;
  onLink?: (href: string) => void;
  highlight?: string;
}

const INLINE_RE =
  /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|__[^_]+__|(?<![*\w])\*(?!\s)[^*]+\*|(?<![_\w])_(?!\s)[^_]+_|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?:https?|file|lantern):\/\/[^\s<>()]+|@[A-Za-z0-9_\-.]+)/g;

function renderHighlighted(text: string, term: string, key: string): React.ReactNode {
  if (!term) return text;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text;
  const out: React.ReactNode[] = [];
  let pos = 0;
  let n = 0;
  let cur = idx;
  while (cur !== -1) {
    if (cur > pos) out.push(text.slice(pos, cur));
    out.push(
      <mark key={`${key}-m${n++}`} className="bg-gold/30 text-txt rounded-[3px] px-0.5">
        {text.slice(cur, cur + term.length)}
      </mark>,
    );
    pos = cur + term.length;
    cur = text.toLowerCase().indexOf(term.toLowerCase(), pos);
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

export function renderInline(src: string, opts: InlineOpts = {}): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  const plain = (s: string) => {
    if (!s) return;
    out.push(
      <React.Fragment key={`t${n++}`}>
        {renderHighlighted(s, opts.highlight ?? '', `t${n}`)}
      </React.Fragment>,
    );
  };

  for (const m of src.matchAll(INLINE_RE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    plain(src.slice(last, at));
    last = at + tok.length;
    const key = `i${n++}`;

    if (tok.startsWith('***') && tok.endsWith('***')) {
      out.push(
        <strong key={key} className="font-semibold italic">
          {renderInline(tok.slice(3, -3), opts)}
        </strong>,
      );
    } else if ((tok.startsWith('**') && tok.endsWith('**')) || (tok.startsWith('__') && tok.endsWith('__'))) {
      out.push(
        <strong key={key} className="font-semibold">
          {renderInline(tok.slice(2, -2), opts)}
        </strong>,
      );
    } else if (tok.startsWith('~~') && tok.endsWith('~~')) {
      out.push(
        <s key={key} className="opacity-70">
          {renderInline(tok.slice(2, -2), opts)}
        </s>,
      );
    } else if (tok.startsWith('`') && tok.endsWith('`')) {
      out.push(
        <code
          key={key}
          className="font-mono text-[0.88em] bg-raised border border-edge rounded-[4px] px-1 py-[1px] text-glow"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('[')) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(
        <button
          key={key}
          onClick={() => opts.onLink?.(mm[2])}
          className="text-cyan hover:underline underline-offset-2"
        >
          {mm[1]}
        </button>,
      );
    } else if (/^(https?|file|lantern):\/\//.test(tok)) {
      out.push(
        <button
          key={key}
          onClick={() => opts.onLink?.(tok)}
          className="text-cyan hover:underline underline-offset-2 break-all"
        >
          {tok}
        </button>,
      );
    } else if (tok.startsWith('@')) {
      const name = tok.slice(1);
      const known = opts.mentionNames?.has(name.toLowerCase());
      out.push(
        <button
          key={key}
          onClick={() => known && opts.onMention?.(name)}
          className={
            known
              ? 'bg-gold/15 text-gold rounded-[4px] px-1 font-medium hover:bg-gold/25'
              : ''
          }
        >
          {tok}
        </button>,
      );
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      out.push(
        <em key={key} className="italic">
          {renderInline(tok.slice(1, -1), opts)}
        </em>,
      );
    } else {
      plain(tok);
    }
  }
  plain(src.slice(last));
  return out;
}

export function Markdown({
  source,
  opts = {},
  className = '',
}: {
  source: string;
  opts?: InlineOpts;
  className?: string;
}) {
  const blocks = React.useMemo(() => parseBlocks(source), [source]);

  return (
    <div className={`space-y-1.5 ${className}`}>
      {blocks.map((b, i) => {
        switch (b.k) {
          case 'code':
            return <CodeBlock key={i} lang={b.lang} code={b.text} />;
          case 'h': {
            const size = ['text-lg', 'text-lg', 'text-base', 'text-base', 'text-sm', 'text-sm'][b.level - 1];
            return (
              <div key={i} className={`${size} font-semibold text-txt pt-0.5`}>
                {renderInline(b.text, opts)}
              </div>
            );
          }
          case 'quote':
            return (
              <blockquote
                key={i}
                className="border-l-2 border-gold/60 pl-2.5 text-dim italic whitespace-pre-wrap"
              >
                {renderInline(b.text, opts)}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={i} className="list-disc pl-5 space-y-0.5 marker:text-muted">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, opts)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol
                key={i}
                start={b.start}
                className="list-decimal pl-5 space-y-0.5 marker:text-muted"
              >
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, opts)}</li>
                ))}
              </ol>
            );
          case 'hr':
            return <hr key={i} className="border-edge my-2" />;
          default:
            return (
              <p key={i} className="whitespace-pre-wrap break-words leading-[1.55]">
                {renderInline(b.text, opts)}
              </p>
            );
        }
      })}
    </div>
  );
}

/** True when the body is a single short run of emoji — rendered oversized. */
export function isJumboEmoji(src: string): boolean {
  const t = src.trim();
  if (!t || t.length > 12) return false;
  const stripped = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}️‍\s]/gu, '');
  return stripped.length === 0;
}
