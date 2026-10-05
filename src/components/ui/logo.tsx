/*
 * In-app brand mark. Geometry mirrors src/assets/logo.svg (canonical source)
 * and scripts/gen-icons.mjs (rasterized favicon/app icons) on a 32-unit grid:
 * folded page + "P" glyph knocked out of the tile.
 *
 * The tile follows --accent so a future brand-color change propagates; the
 * white page/fold are brand constants, matching public/favicon.svg.
 */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="6.4" fill="var(--accent)" />
      <path d="M8.64 6.72H19.2L23.36 10.88V25.28H8.64Z" fill="#fff" />
      <path d="M19.2 6.72 23.36 10.88H19.2Z" fill="#c7d2fe" />
      <path
        d="M11.04 8.96H13.92A3.68 3.68 0 0 1 13.92 16.32V22.4H11.04ZM13.92 11.2A1.44 1.44 0 0 1 13.92 14.08Z"
        fill="var(--accent)"
        fillRule="evenodd"
      />
    </svg>
  );
}
