/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#F6F6F4',
        recessed: '#EFEFE9',
        surface: '#FFFFFF',
        navy: {
          DEFAULT: '#0F1E36',
          700: '#24354F',
          600: '#42526B',
          500: '#64748B',
          400: '#8A96A8',
        },
        teal: {
          accent: '#0F766E',
          hover: '#0D5D57',
          tint: '#E6F4F1',
          border: '#99D5C9',
        },
        amber: {
          warn: '#B45309',
          tint: '#FEF3C7',
          border: '#F59E0B',
        },
        crimson: {
          err: '#B91C1C',
          tint: '#FEE2E2',
          border: '#F87171',
        },
        hairline: '#E2E4E9',
        hairlineStrong: '#CFD4DC',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 30, 54, 0.04)',
        popover: '0 4px 12px rgba(15, 30, 54, 0.08), 0 1px 2px rgba(15, 30, 54, 0.04)',
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        md: '6px',
        lg: '8px',
      },
    },
  },
  plugins: [],
};
