import React from 'react';
import { Check, Copy } from 'lucide-react';
import { TOKEN_CLASS, normalizeLang, tokenize } from '../lib/highlight';
import { cn } from '../lib/utils';
import { copyText } from '../lib/clipboard';

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = React.useState(false);
  const norm = normalizeLang(lang);
  const tokens = React.useMemo(() => tokenize(code, norm), [code, norm]);

  const copy = async () => {
    try {
      await copyText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="group/code relative my-1 rounded-card border border-edge bg-base overflow-hidden">
      <div className="flex items-center justify-between h-7 px-2.5 border-b border-edge bg-raised/50">
        <span className="text-2xs font-mono text-muted uppercase tracking-wide">
          {lang || norm}
        </span>
        <button
          onClick={copy}
          className={cn(
            'inline-flex items-center gap-1 text-2xs px-1.5 h-5 rounded-[4px] transition-colors',
            copied ? 'text-cyan' : 'text-muted hover:text-txt hover:bg-raised',
          )}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-2.5 overflow-x-auto text-[12.5px] leading-[1.6] font-mono">
        <code>
          {tokens.map((t, i) => (
            <span key={i} className={TOKEN_CLASS[t.c]}>
              {t.t}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
