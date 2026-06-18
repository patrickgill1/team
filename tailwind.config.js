/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
    extend: {
      colors: {
        fire: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#0f172a',
        },
        navy: {
          600: '#1e3a5f',
          700: '#172e4a',
          800: '#122340',
          900: '#0f1f35',
          950: '#0a1628',
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
