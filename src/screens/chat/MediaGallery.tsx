import React from 'react';
import { File as FileIcon, X } from 'lucide-react';
import { Empty, IconButton, Segmented } from '../../components/ui';
import { MotionClip, Sticker } from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { clockTime, formatBytes } from '../../lib/utils';
import type { Room } from '../../lib/types';

type Kind = 'all' | 'image' | 'file' | 'sticker';

export function MediaGallery({ room, onClose }: { room: Room; onClose: () => void }) {
  const messages = useStore((s) => s.messages[room.id] ?? []);
  const [kind, setKind] = React.useState<Kind>('all');

  const images = messages.flatMap((m) =>
    m.attachments.filter((a) => a.kind === 'image').map((a) => ({ m, a })),
  );
  const files = messages.flatMap((m) =>
    m.attachments.filter((a) => a.kind !== 'image').map((a) => ({ m, a })),
  );
  const stickers = messages.filter((m) => m.sticker || m.gif);

  const empty =
    (kind === 'all' && !images.length && !files.length && !stickers.length) ||
    (kind === 'image' && !images.length) ||
    (kind === 'file' && !files.length) ||
    (kind === 'sticker' && !stickers.length);

  return (
    <div className="h-full flex flex-col w-[300px]">
      <header className="h-11 shrink-0 px-3 flex items-center justify-between border-b border-edge">
        <span className="text-xs font-semibold">Media in {room.name}</span>
        <IconButton label="Close gallery" size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>

      <div className="p-2 border-b border-edge shrink-0">
        <Segmented
          value={kind}
          onChange={setKind}
          size="xs"
          options={[
            { value: 'all', label: 'All' },
            { value: 'image', label: 'Images' },
            { value: 'file', label: 'Files' },
            { value: 'sticker', label: 'Stickers' },
          ]}
        />
      </div>

      <div className="flex-1 scroll-y p-2">
        {empty ? (
          <Empty title="Nothing here yet" hint="Images, files and stickers shared in this room collect here." />
        ) : (
          <div className="space-y-4">
            {(kind === 'all' || kind === 'image') && images.length > 0 && (
              <section>
                <div className="label mb-1.5">Images</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {images.map(({ m, a }) => (
                    <button
                      key={a.id + m.id}
                      onClick={() =>
                        document
                          .getElementById(`msg-${m.id}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      }
                      className="aspect-square rounded-input overflow-hidden border border-edge hover:border-gold/50"
                      title={a.name}
                    >
                      {a.dataUrl ? (
                        <img src={a.dataUrl} alt={a.name} className="h-full w-full object-cover" />
                      ) : (
                        <span className="h-full w-full grid place-items-center text-[10px] text-muted p-1 text-center">
                          {a.name}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {(kind === 'all' || kind === 'file') && files.length > 0 && (
              <section>
                <div className="label mb-1.5">Files</div>
                <ul className="space-y-1">
                  {files.map(({ m, a }) => (
                    <li
                      key={a.id + m.id}
                      className="flex items-center gap-2 p-1.5 rounded-input hover:bg-raised"
                    >
                      <FileIcon size={13} className="text-muted shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-2xs truncate">{a.name}</div>
                        <div className="text-[10px] text-muted">
                          {formatBytes(a.size)} · {clockTime(m.ts)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(kind === 'all' || kind === 'sticker') && stickers.length > 0 && (
              <section>
                <div className="label mb-1.5">Stickers & motion</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {stickers.map((m) => (
                    <button
                      key={m.id}
                      onClick={() =>
                        document
                          .getElementById(`msg-${m.id}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      }
                      className="aspect-square rounded-input border border-edge grid place-items-center hover:border-gold/50 p-1"
                    >
                      {m.sticker ? (
                        <Sticker id={m.sticker} size={60} />
                      ) : (
                        <MotionClip id={m.gif!} size={60} />
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
