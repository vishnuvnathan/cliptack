/** @type {import('tailwindcss').Config} */

// Every themed colour is a space-separated RGB triplet held in a CSS variable
// (defined in src/styles.css, switched by `data-theme` on <html>). The
// `<alpha-value>` placeholder is what keeps utilities like `bg-accent/15` and
// `border-accent/60` working -- a plain hex or a pre-built `rgb()` string would
// silently drop the opacity.
const themed = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: themed("panel"),
        panelalt: themed("panelalt"),
        edge: themed("edge"),
        accent: themed("accent"),
        // Text colour for content sitting on a solid accent background.
        onaccent: themed("onaccent"),
        // The grey ramp is re-pointed rather than replaced class by class, so
        // the ~120 existing `zinc-*` utilities flip with the theme untouched.
        zinc: {
          100: themed("zinc-100"),
          200: themed("zinc-200"),
          300: themed("zinc-300"),
          400: themed("zinc-400"),
          500: themed("zinc-500"),
          600: themed("zinc-600"),
          700: themed("zinc-700"),
          800: themed("zinc-800"),
        },
      },
      fontFamily: {
        ui: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
