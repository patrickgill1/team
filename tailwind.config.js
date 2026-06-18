/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
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
