/**
 * One place that can put a primer in front of anything.
 *
 * The prompts worth explaining are reached from all over: a call starts from
 * five different buttons, from an incoming ring, and from the corner popup
 * outside the window entirely. Wrapping each of those was never going to hold
 * — the one that got missed would be the one somebody used.
 *
 * So the explanation is asked for where the system prompt is actually about to
 * happen, by awaiting `primed`, and drawn once by a host component mounted at
 * the top of the application.
 *
 * The rule that matters: if for any reason nothing can draw the primer, this
 * gets out of the way and lets the action through. A call that will not start
 * because an explanation could not be rendered would be far worse than a
 * system prompt somebody was not warned about.
 */
import { shouldExplain, type PromptKind } from './primer';

export interface PrimerAsk {
  kind: PromptKind;
  /** True to go ahead with the thing that needed the prompt. */
  answer: (proceed: boolean) => void;
}

type Listener = (ask: PrimerAsk | null) => void;

let listener: Listener | null = null;
let current: PrimerAsk | null = null;

/** Registers the component that draws primers. Returns an unsubscribe. */
export function onPrimerAsk(fn: Listener): () => void {
  listener = fn;
  // A host that mounts while something is already waiting picks it up rather
  // than leaving that caller blocked forever.
  if (current) fn(current);
  return () => {
    if (listener === fn) listener = null;
  };
}

/** For tests, and for a host unmounting mid-question. */
export function resetPrimerGate(): void {
  current?.answer(true);
  current = null;
  listener = null;
}

/**
 * Explains the coming system prompt, if it is worth explaining, and resolves
 * with whether to carry on.
 *
 * Resolves `true` immediately when there is nothing to explain — already
 * granted, already refused, already seen — which is the overwhelmingly common
 * case and must cost nothing.
 */
export async function primed(kind: PromptKind): Promise<boolean> {
  let explain = false;
  try {
    explain = await shouldExplain(kind);
  } catch {
    // Working out whether to explain must never be what stops the thing being
    // explained from happening.
    return true;
  }
  if (!explain || !listener) return true;

  // Somebody is already being asked. Two primers stacked on each other is not
  // a thing anyone should see, so this one goes ahead unexplained.
  if (current) return true;

  return new Promise<boolean>((resolve) => {
    const ask: PrimerAsk = {
      kind,
      answer: (proceed) => {
        if (current !== ask) return;
        current = null;
        listener?.(null);
        resolve(proceed);
      },
    };
    current = ask;
    listener?.(ask);
  });
}
