/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  // Route Tailwind's dark: variant through our own theme attribute
  // instead of the OS prefers-color-scheme media query. ThemeContext
  // writes `data-theme="dark" | "light"` onto <html>; we want `dark:`
  // classes to follow that decision so a user who forces light mode
  // gets light styles even when their OS is dark.
  darkMode: ['selector', 'html[data-theme="dark"]'],
  theme: {
    extend: {
      // GoalKickr brand palette (mirror of goalkickr-site). Cinematic
      // charcoal + crimson, bone for type. Legacy `fire` and `navy`
      // aliases are retained as a safety net so any class the sweep
      // missed still resolves — but every new usage should reach for
      // crimson/charcoal directly. Legacy aliases re-point at the new
      // values so they render identically post-migration.
      colors: {
        charcoal: {
          50:  '#f5f5f6',
          100: '#e7e7e9',
          200: '#cdced1',
          300: '#a8aaaf',
          400: '#7e8087',
          500: '#5f6166',
          600: '#48494e',
          700: '#34353a',
          800: '#1f2024',
          900: '#15161a',
          950: '#0d0d10',
        },
        crimson: {
          50:  '#fef2f3',
          100: '#fde2e4',
          200: '#fbcbd0',
          300: '#f7a4ad',
          400: '#f17282',
          500: '#e5485d',
          600: '#c8202c',
          700: '#a91a26',
          800: '#8c1922',
          900: '#741920',
          950: '#400a10',
        },
        bone: {
          DEFAULT: '#f5f3ee',
        },
        fire: {
          50:  '#fef2f3',
          100: '#fde2e4',
          200: '#fbcbd0',
          300: '#f7a4ad',
          400: '#f17282',
          500: '#e5485d',
          600: '#48494e',
          700: '#34353a',
          800: '#1f2024',
          900: '#15161a',
          950: '#0d0d10',
        },
        navy: {
          600: '#48494e',
          700: '#34353a',
          800: '#1f2024',
          900: '#15161a',
          950: '#0d0d10',
        },
        // Brand color CSS-variable layer. Defaults match crimson but
        // can be overridden per-club at runtime via useApplyClubBrand()
        // (writes --brand-primary on document.documentElement). Lets
        // new clubs use their own primary color without touching code.
        // Existing surfaces still use `crimson-*` — migrate
        // intentionally over time.
        brand: {
          primary:        'rgb(var(--brand-primary) / <alpha-value>)',
          'primary-hov':  'rgb(var(--brand-primary-hov) / <alpha-value>)',
          'primary-soft': 'rgb(var(--brand-primary-soft) / <alpha-value>)',
          'primary-dim':  'rgb(var(--brand-primary-dim) / <alpha-value>)',
          'primary-deep': 'rgb(var(--brand-primary-deep) / <alpha-value>)',
          'primary-fg':   'rgb(var(--brand-primary-fg) / <alpha-value>)',
        },
        // Semantic theme tokens — light/dark-aware via html[data-theme].
        // New components reach for these; existing charcoal-* / bone
        // classes keep working in dark mode and migrate incrementally.
        // Source values live in src/index.css under --surface-* / --ink-*
        // / --line-*. See that file for the full token table.
        surface: {
          base:     'rgb(var(--surface-base) / <alpha-value>)',
          elevated: 'rgb(var(--surface-elevated) / <alpha-value>)',
          input:    'rgb(var(--surface-input) / <alpha-value>)',
          overlay:  'rgb(var(--surface-overlay) / <alpha-value>)',
          raised:   'rgb(var(--surface-raised) / <alpha-value>)',
          tint:     'rgb(var(--surface-tint) / <alpha-value>)',
        },
        // Vignette: theme-aware "darker end" for soft page-level gradients.
        // Black in dark mode (matches the original to-black usage), slate-300
        // in light mode (subtle vignette without the harsh contrast jump).
        vignette: {
          deep: 'rgb(var(--vignette-deep) / <alpha-value>)',
        },
        ink: {
          primary:   'rgb(var(--ink-primary) / <alpha-value>)',
          secondary: 'rgb(var(--ink-secondary) / <alpha-value>)',
          muted:     'rgb(var(--ink-muted) / <alpha-value>)',
          inverse:   'rgb(var(--ink-inverse) / <alpha-value>)',
        },
        line: {
          default: 'rgb(var(--line-default) / <alpha-value>)',
          strong:  'rgb(var(--line-strong) / <alpha-value>)',
        },
      },
      animation: {
        // Subtle scale/opacity pulse for the game-day glow on the
        // next-event card. Not the standard tailwind pulse (which is
        // too aggressive) — this one fades the shadow + ring softly.
        'pulse-soft': 'pulseSoft 2.4s ease-in-out infinite',
      },
      keyframes: {
        pulseSoft: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(244,63,94,0.0)' },
          '50%':      { boxShadow: '0 0 24px 4px rgba(244,63,94,0.35)' },
        },
      },
    },
  },
  plugins: [],
}
