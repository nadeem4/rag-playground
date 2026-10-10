/**
 * The app's mark, the same drawing as web/public/favicon.svg: a page cut into
 * pieces on the accent tile. Decoration beside the name, so it is hidden from
 * screen readers. The colours are fixed, as in the favicon, so the mark looks
 * the same in both themes.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 32 32" width={size} height={size} className="shrink-0">
      <rect x="1" y="1" width="30" height="30" rx="7" fill="#0f6e51" />
      <path d="M8 6h12l5 5v15a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" fill="#fdfdfc" />
      <path d="M20 6v5h5z" fill="#d0f1e2" />
      <rect x="9.5" y="13" width="13" height="3" rx="1" fill="#e68d9c" />
      <rect x="9.5" y="17.5" width="9" height="3" rx="1" fill="#5cb6e6" />
      <rect x="9.5" y="22" width="11" height="3" rx="1" fill="#e19766" />
    </svg>
  )
}
