/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        base: 'rgb(var(--c-base) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        raised: 'rgb(var(--c-raised) / <alpha-value>)',
        edge: 'rgb(var(--c-edge) / <alpha-value>)',
        'edge-strong': 'rgb(var(--c-edge-strong) / <alpha-value>)',
        gold: 'rgb(var(--c-gold) / <alpha-value>)',
        glow: 'rgb(var(--c-glow) / <alpha-value>)',
        cyan: 'rgb(var(--c-cyan) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        txt: 'rgb(var(--c-txt) / <alpha-value>)',
        dim: 'rgb(var(--c-dim) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Geist', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', '15px'],
        xs: ['12px', '17px'],
        sm: ['14px', '21px'],
        base: ['16px', '24px'],
        lg: ['20px', '28px'],
        xl: ['28px', '34px'],
        '2xl': ['40px', '46px'],
      },
      borderRadius: {
        input: '6px',
        card: '10px',
        modal: '16px',
        pill: '24px',
      },
      boxShadow: {
        glow: '0 0 12px rgb(var(--c-gold) / 0.25)',
        'glow-lg': '0 0 28px rgb(var(--c-gold) / 0.30)',
        'glow-cyan': '0 0 12px rgb(var(--c-cyan) / 0.30)',
        'glow-danger': '0 0 12px rgb(var(--c-danger) / 0.30)',
        'inner-top': 'inset 0 1px 0 rgb(255 255 255 / 0.04)',
      },
      backdropBlur: { glass: '16px' },
      keyframes: {
        'pane-glow': {
          '0%,100%': { opacity: '0.35' },
          '50%': { opacity: '1' },
        },
        'ring-out': {
          '0%': { transform: 'scale(0.75)', opacity: '0.7' },
          '100%': { transform: 'scale(1.9)', opacity: '0' },
        },
        'rise': {
          '0%': { transform: 'translateY(0) scale(0.6)', opacity: '0' },
          '15%': { opacity: '1' },
          '100%': { transform: 'translateY(-150px) scale(1.25)', opacity: '0' },
        },
        'typing-dot': {
          '0%,60%,100%': { transform: 'translateY(0)', opacity: '0.35' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' },
        },
        'shimmer': {
          '100%': { transform: 'translateX(100%)' },
        },
        'spin-slow': { to: { transform: 'rotate(360deg)' } },
      },
      animation: {
        'pane-glow': 'pane-glow 2.4s ease-in-out infinite',
        'ring-out': 'ring-out 1.8s ease-out infinite',
        rise: 'rise 2.2s ease-out forwards',
        'typing-dot': 'typing-dot 1.1s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        'spin-slow': 'spin-slow 1.4s linear infinite',
      },
    },
  },
  plugins: [],
};
