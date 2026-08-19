import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cymate: {
          orange: '#FD5E02',
          'orange-dark': '#DB4E00',
          navy: '#233362',
          'navy-light': '#2E4180',
          'navy-dark': '#1A2749',
          cyan: '#00E6FF',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -8px rgba(35, 51, 98, 0.12)',
      },
    },
  },
  plugins: [],
};

export default config;
