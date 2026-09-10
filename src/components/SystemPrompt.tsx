import React from 'react';
import { ShieldQuestion } from 'lucide-react';
import { Button, Modal } from './ui';
import { detectPlatform, primerFor, rememberExplained, type PromptKind } from '../lib/primer';
import { onPrimerAsk, type PrimerAsk } from '../lib/primergate';

/**
 * A word before the operating system interrupts.
 *
 * The dialogs this describes are drawn by Windows, macOS and Android, not by
 * LANTern: the application cannot restyle them, cannot read what was pressed,
 * and in every case cannot ask a second time. So the only place to help is
 * before — naming the option to choose, in the words the dialog itself uses,
 * and saying what a refusal costs while it is still avoidable.
 *
 * Mounted once, near the root, because the prompts it explains are reached
 * from all over the application and from outside its window.
 */
export function SystemPromptHost() {
  const [ask, setAsk] = React.useState<PrimerAsk | null>(null);

  React.useEffect(() => onPrimerAsk(setAsk), []);

  if (!ask) return null;
  return (
    <SystemPromptDialog
      kind={ask.kind}
      onCancel={() => ask.answer(false)}
      onContinue={() => {
        // Remembered on the way through, not on the way in: somebody who
        // backed out has not been told anything they will act on, and should
        // get the explanation again next time.
        rememberExplained(ask.kind);
        ask.answer(true);
      }}
    />
  );
}

function SystemPromptDialog({
  kind,
  onCancel,
  onContinue,
}: {
  kind: PromptKind;
  onCancel: () => void;
  onContinue: () => void;
}) {
  // Read at render rather than at module load, so this file stays importable
  // outside a browser.
  const primer = primerFor(kind, detectPlatform());

  return (
    <Modal
      open
      onClose={onCancel}
      title={
        <span className="flex items-center gap-2">
          <ShieldQuestion size={15} className="text-gold" />
          {primer.title}
        </span>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Not now
          </Button>
          <Button variant="primary" onClick={onContinue}>
            Show me the prompt
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-xs leading-relaxed">
        <p className="text-muted">{primer.what}</p>

        {/* The one thing to take away, set apart from the explanation so it
            survives being skimmed. */}
        <div className="rounded-card border border-gold/40 bg-gold/10 px-3 py-2">
          <p className="text-2xs uppercase tracking-wide text-gold/90">Choose</p>
          <p className="font-medium mt-0.5">{primer.choose}</p>
          {primer.because && <p className="text-muted mt-1.5 text-2xs">{primer.because}</p>}
        </div>

        <p className="text-2xs text-muted">
          <span className="text-txt">If you refuse: </span>
          {primer.ifRefused}
        </p>
      </div>
    </Modal>
  );
}
