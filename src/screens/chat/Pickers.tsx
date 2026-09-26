import React from 'react';
import { motion } from 'framer-motion';
import { Search } from 'lucide-react';
import { Input } from '../../components/ui';
import {
  EMOJI_CATEGORIES,
  SKIN_TONES,
  applySkinTone,
  searchEmoji,
} from '../../lib/emoji';
import { useLocalStorage } from '../../lib/hooks';
import { cn } from '../../lib/utils';

const panel =
  'w-[320px] max-h-[340px] glass border border-edge-strong rounded-card shadow-2xl flex flex-col overflow-hidden';

export function EmojiPicker({ onPick }: { onPick: (glyph: string) => void }) {
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState(EMOJI_CATEGORIES[0].id);
  const [tone, setTone] = useLocalStorage('lantern.skinTone', '');
  const [recent, setRecent] = useLocalStorage<string[]>('lantern.recentEmoji', []);

  const pick = (glyph: string) => {
    setRecent([glyph, ...recent.filter((g) => g !== glyph)].slice(0, 24));
    onPick(glyph);
  };

  const results = query.trim() ? searchEmoji(query, tone) : null;
  const active = EMOJI_CATEGORIES.find((c) => c.id === category)!;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.97 }}
      className={panel}
    >
      <div className="p-2 border-b border-edge shrink-0">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji…"
          icon={<Search size={12} />}
        />
      </div>

      {!results && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-edge shrink-0 overflow-x-auto no-scrollbar">
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              title={c.label}
              className={cn(
                'h-7 w-7 shrink-0 rounded-input grid place-items-center text-sm transition-colors',
                category === c.id ? 'bg-gold/15 ring-1 ring-gold/40' : 'hover:bg-raised',
              )}
            >
              {c.icon}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 scroll-y p-2">
        {results ? (
          results.length ? (
            <Grid items={results.map((r) => r.glyph)} onPick={pick} />
          ) : (
            <p className="text-2xs text-muted text-center py-8">No emoji match “{query}”.</p>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <>
                <div className="label mb-1.5">Recently used</div>
                <Grid items={recent} onPick={pick} />
                <div className="label mb-1.5 mt-3">{active.label}</div>
              </>
            )}
            <Grid
              items={active.items.map((i) => applySkinTone(i.glyph, tone))}
              onPick={pick}
            />
          </>
        )}
      </div>

      <div className="flex items-center gap-1 px-2 h-8 border-t border-edge shrink-0">
        <span className="text-2xs text-muted mr-1">Skin tone</span>
        {SKIN_TONES.map((t) => (
          <button
            key={t || 'default'}
            onClick={() => setTone(t)}
            className={cn(
              'h-5 w-5 rounded-full text-xs grid place-items-center transition-transform',
              tone === t ? 'ring-1 ring-gold scale-110' : 'hover:scale-105',
            )}
          >
            {applySkinTone('✋', t)}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function Grid({ items, onPick }: { items: string[]; onPick: (g: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {items.map((g, i) => (
        <button
          key={`${g}-${i}`}
          onClick={() => onPick(g)}
          className="h-8 rounded-input text-lg grid place-items-center hover:bg-raised transition-transform hover:scale-110"
        >
          {g}
        </button>
      ))}
    </div>
  );
}
