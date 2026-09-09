import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { sfx } from '../lib/audio';
import { useBackDismiss } from '../lib/hooks';

export const spring = { type: 'spring' as const, stiffness: 180, damping: 20 };

/* ------------------------------------------------------------------ Button */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle' | 'cyan';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  full?: boolean;
  active?: boolean;
};

export function Button({
  variant = 'outline',
  size = 'sm',
  icon,
  full,
  active,
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const sizes = {
    xs: 'h-6 px-2 text-2xs gap-1 rounded-input',
    sm: 'h-8 px-3 text-xs gap-1.5 rounded-input',
    md: 'h-9 px-4 text-sm gap-2 rounded-input',
    lg: 'h-11 px-5 text-sm gap-2 rounded-card',
  }[size];

  const variants = {
    primary:
      'bg-gold text-[#1a1206] font-semibold hover:bg-glow shadow-glow disabled:opacity-40',
    cyan: 'bg-cyan text-[#04211e] font-semibold hover:brightness-110 shadow-glow-cyan',
    danger:
      'bg-danger text-white font-medium hover:brightness-110 shadow-glow-danger',
    outline:
      'bg-raised border border-edge text-txt hover:border-edge-strong hover:bg-raised/70',
    ghost: 'text-dim hover:text-txt hover:bg-raised',
    subtle: 'bg-raised/60 text-dim hover:text-txt border border-transparent hover:border-edge',
  }[variant];

  return (
    <button
      {...rest}
      onClick={(e) => {
        sfx.click();
        onClick?.(e);
      }}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap transition-all duration-150 select-none',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/60',
        'disabled:pointer-events-none disabled:opacity-40 active:scale-[0.97]',
        sizes,
        variants,
        active && 'ring-1 ring-gold/60 shadow-glow',
        full && 'w-full',
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  size = 'md',
  variant = 'ghost',
  ...rest
}: ButtonProps & { label: string; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const dim = { xs: 'h-6 w-6', sm: 'h-7 w-7', md: 'h-8 w-8', lg: 'h-10 w-10' }[size];
  return (
    <Tooltip content={label}>
      <Button
        {...rest}
        variant={variant}
        aria-label={label}
        className={cn('!px-0 rounded-input', dim, className)}
      />
    </Tooltip>
  );
}

/* ----------------------------------------------------------------- Tooltip */

export function Tooltip({
  content,
  children,
  side = 'top',
  delay = 350,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<number>();

  if (!content) return children;

  const pos = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }[side];

  return (
    <span
      className="relative inline-flex"
      onPointerEnter={() => {
        timer.current = window.setTimeout(() => setOpen(true), delay);
      }}
      onPointerLeave={() => {
        clearTimeout(timer.current);
        setOpen(false);
      }}
    >
      {children}
      <AnimatePresence>
        {open && (
          <motion.span
            initial={{ opacity: 0, y: side === 'top' ? 3 : -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className={cn(
              'absolute z-[80] px-2 py-1 rounded-input text-2xs whitespace-nowrap pointer-events-none',
              'glass border border-edge text-txt shadow-lg',
              pos,
            )}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/* ------------------------------------------------------------------- Modal */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Escape is the desktop gesture; back is the Android one. Doing this here
  // means every dialog in the app gets it, rather than each remembering to.
  useBackDismiss(open, onClose);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 scrim"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ scale: 0.94, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, y: 6, opacity: 0 }}
            transition={spring}
            className={cn(
              'w-full bg-surface border border-edge-strong rounded-modal shadow-2xl overflow-hidden flex flex-col max-h-[88vh]',
              width,
            )}
          >
            {title && (
              <div className="flex items-center justify-between px-4 h-12 border-b border-edge shrink-0">
                <h2 className="text-sm font-semibold">{title}</h2>
                <IconButton label="Close" size="sm" onClick={onClose}>
                  <X size={15} />
                </IconButton>
              </div>
            )}
            <div className="p-4 scroll-y flex-1">{children}</div>
            {footer && (
              <div className="px-4 py-3 border-t border-edge flex justify-end gap-2 shrink-0">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ Inputs */

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { icon?: React.ReactNode }
>(function Input({ className, icon, ...rest }, ref) {
  return (
    <div className="relative flex items-center w-full">
      {icon && <span className="absolute left-2.5 text-muted pointer-events-none">{icon}</span>}
      <input
        ref={ref}
        {...rest}
        className={cn(
          'w-full h-8 bg-raised border border-edge rounded-input px-2.5 text-xs text-txt',
          'placeholder:text-muted transition-colors',
          'focus:border-gold/60 focus:ring-1 focus:ring-gold/40',
          icon && 'pl-8',
          className,
        )}
      />
    </div>
  );
});

export function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cn(
        'w-full bg-raised border border-edge rounded-input px-2.5 py-2 text-xs text-txt',
        'placeholder:text-muted resize-none focus:border-gold/60 focus:ring-1 focus:ring-gold/40',
        className,
      )}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-3 select-none',
        disabled ? 'opacity-40' : 'cursor-pointer',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          sfx.click();
          onChange(!checked);
        }}
        className={cn(
          'relative h-[18px] w-[32px] rounded-pill shrink-0 transition-colors duration-200 border',
          checked ? 'bg-gold/90 border-gold shadow-glow' : 'bg-raised border-edge',
        )}
      >
        <motion.span
          layout
          transition={spring}
          className={cn(
            'absolute top-[2px] h-[12px] w-[12px] rounded-full',
            checked ? 'left-[16px] bg-[#1a1206]' : 'left-[2px] bg-dim',
          )}
        />
      </button>
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-xs text-txt">{label}</span>}
          {hint && <span className="block text-2xs text-muted mt-0.5">{hint}</span>}
        </span>
      )}
    </label>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className={cn('lantern-slider w-full h-4 cursor-pointer', className)}
      style={
        {
          background: `linear-gradient(to right, rgb(var(--c-gold)) ${pct}%, rgb(var(--c-edge)) ${pct}%)`,
          height: '4px',
          borderRadius: '2px',
          appearance: 'none',
          outline: 'none',
        } as React.CSSProperties
      }
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(
          'w-full h-8 bg-raised border border-edge rounded-input pl-2.5 pr-7 text-xs text-txt',
          'appearance-none cursor-pointer focus:border-gold/60 focus:ring-1 focus:ring-gold/40',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-surface text-txt">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={13}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
      />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const groupId = React.useId();
  return (
    <div
      className={cn(
        'inline-flex bg-raised border border-edge rounded-input p-[2px] gap-[2px]',
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => {
              sfx.click();
              onChange(o.value);
            }}
            className={cn(
              'relative rounded-[4px] transition-colors whitespace-nowrap',
              size === 'xs' ? 'px-2 h-5 text-2xs' : 'px-2.5 h-6 text-xs',
              on ? 'text-[#1a1206]' : 'text-dim hover:text-txt',
            )}
          >
            {on && (
              <motion.span
                layoutId={`seg-${groupId}`}
                className="absolute inset-0 bg-gold rounded-[4px]"
                transition={spring}
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Badges */

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'gold' | 'cyan' | 'danger' | 'muted';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-raised border-edge text-dim',
    gold: 'bg-gold/12 border-gold/40 text-gold',
    cyan: 'bg-cyan/12 border-cyan/40 text-cyan',
    danger: 'bg-danger/12 border-danger/40 text-danger',
    muted: 'bg-transparent border-edge text-muted',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 h-[18px] rounded-[4px] border text-2xs font-medium',
        tones,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'cyan', pulse }: { tone?: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      {pulse && (
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
          style={{ background: tone }}
        />
      )}
      <span
        className="relative inline-flex rounded-full h-1.5 w-1.5"
        style={{ background: tone }}
      />
    </span>
  );
}

/* ------------------------------------------------------------- Empty state */

export function Empty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8 py-12">
      {icon && (
        <div className="h-12 w-12 rounded-card bg-raised border border-edge grid place-items-center text-muted">
          {icon}
        </div>
      )}
      <div>
        <div className="text-sm font-medium text-dim">{title}</div>
        {hint && <div className="text-xs text-muted mt-1 max-w-xs">{hint}</div>}
      </div>
      {action}
    </div>
  );
}

/* --------------------------------------------------------------- Checkbox */

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'h-4 w-4 rounded-[4px] border grid place-items-center transition-colors shrink-0',
          checked ? 'bg-gold border-gold' : 'bg-raised border-edge hover:border-edge-strong',
        )}
      >
        {checked && <Check size={11} className="text-[#1a1206]" strokeWidth={3} />}
      </button>
      {label && <span className="text-xs text-txt">{label}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------- Misc */

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block rounded-full border-2 border-edge border-t-gold animate-spin-slow"
      style={{ width: size, height: size }}
    />
  );
}

export function ProgressBar({
  value,
  tone = 'gold',
  className,
}: {
  value: number;
  tone?: 'gold' | 'cyan' | 'danger';
  className?: string;
}) {
  const bg = { gold: 'bg-gold', cyan: 'bg-cyan', danger: 'bg-danger' }[tone];
  return (
    <div className={cn('h-1 bg-edge rounded-full overflow-hidden', className)}>
      <motion.div
        className={cn('h-full rounded-full', bg)}
        animate={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      />
    </div>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <h3 className="label">{children}</h3>
      {right}
    </div>
  );
}
