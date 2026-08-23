import type { IconProps } from './icons/props.ts'

/**
 * Render CoHarness's independent collaboration mark.
 *
 * The open arc and connected node remain legible in the sidebar rail and in
 * the blank-session hero; the mark inherits its host's `currentColor`.
 * @param props - Size and placement props supplied by the host surface.
 * @returns the CoHarness mark SVG.
 */
export function CoHarnessMark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-brand="coharness"
    >
      <path
        d="M16.875 7.125a8.25 8.25 0 1 0 0 9.75"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
      <path d="M7.5 12h9" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      <circle cx="17.25" cy="12" r="1.5" fill="currentColor" />
    </svg>
  )
}
