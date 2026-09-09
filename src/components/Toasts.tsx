import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { Button } from './ui';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  return (
    <div className="fixed bottom-4 right-4 z-[120] flex flex-col gap-2 pointer-events-none max-w-[320px]">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon =
            t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? AlertCircle : Info;
          const tone =
            t.kind === 'success'
              ? 'text-cyan'
              : t.kind === 'error'
                ? 'text-danger'
                : 'text-gold';
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 220, damping: 24 }}
              className="pointer-events-auto glass border border-edge-strong rounded-card p-3 pr-8 shadow-xl relative"
            >
              <button
                onClick={() => dismiss(t.id)}
                className="absolute top-2 right-2 text-muted hover:text-txt"
                aria-label="Dismiss"
              >
                <X size={13} />
              </button>
              <div className="flex gap-2.5">
                <Icon size={15} className={`${tone} shrink-0 mt-[1px]`} />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-txt">{t.title}</div>
                  {t.body && <div className="text-2xs text-dim mt-0.5">{t.body}</div>}
                  {t.action && (
                    <Button
                      size="xs"
                      variant="primary"
                      className="mt-2"
                      onClick={() => {
                        t.action!.run();
                        dismiss(t.id);
                      }}
                    >
                      {t.action.label}
                    </Button>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
