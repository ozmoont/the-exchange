import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Semantic tokens — map to a single ink/surface vocabulary so pages
        // don't reach for raw hex values. Adjust here, not in components.
        ink: {
          DEFAULT: "#0f172a",   // primary text, dark UI bg
          muted: "#475569",     // secondary text
          subtle: "#94a3b8",    // meta text
        },
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f8fafc",     // page bg
          raised: "#ffffff",    // card bg
          inverse: "#0f172a",   // dark surface
        },
        border: {
          DEFAULT: "#e2e8f0",
          strong: "#cbd5e1",
        },
        accent: {
          DEFAULT: "#0f172a",   // primary CTA
          hover: "#1e293b",
        },
        success: { DEFAULT: "#dcfce7", fg: "#166534" },
        warning: { DEFAULT: "#fef9c3", fg: "#854d0e" },
        danger: { DEFAULT: "#fee2e2", fg: "#991b1b" },
        info: { DEFAULT: "#dbeafe", fg: "#1e40af" },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px 0 rgba(15, 23, 42, 0.04)",
        elevated: "0 4px 12px -2px rgba(15, 23, 42, 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
