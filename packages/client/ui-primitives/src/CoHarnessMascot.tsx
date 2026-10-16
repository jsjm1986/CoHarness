import type { IconProps } from './icons/props.ts'

const TILE = 'var(--dsw-alias-bg-base, Canvas)'

const ACCENT_STYLE =
  '.coh-mascot-accent{fill:#2563eb}body[data-ds-dark-theme] .coh-mascot-accent{fill:#6b93ff}'

const MOTION_STYLE =
  '.coh-mascot-busy{--flap:11deg;--bob:1.6px}' +
  '.coh-mascot-ambient{--flap:13deg;--bob:2.6px}' +
  '.coh-mascot-wing-l{transform-box:fill-box;transform-origin:85% 75%}' +
  '.coh-mascot-wing-r{transform-box:fill-box;transform-origin:18% 90%}' +
  '.coh-mascot-busy .coh-mascot-wing-l{animation:coh-mascot-flap-l .34s ease-in-out infinite}' +
  '.coh-mascot-busy .coh-mascot-wing-r{animation:coh-mascot-flap-r .34s ease-in-out infinite}' +
  '.coh-mascot-busy .coh-mascot-lamp{animation:coh-mascot-lamp 1.7s ease-in-out infinite}' +
  '.coh-mascot-busy{animation:coh-mascot-bob 1.7s ease-in-out infinite}' +
  '.coh-mascot-ambient .coh-mascot-wing-l{animation:coh-mascot-flap-l .5s ease-in-out infinite}' +
  '.coh-mascot-ambient .coh-mascot-wing-r{animation:coh-mascot-flap-r .5s ease-in-out infinite}' +
  '.coh-mascot-ambient .coh-mascot-lamp{animation:coh-mascot-lamp 1.6s ease-in-out infinite}' +
  '.coh-mascot-ambient{animation:coh-mascot-bob 1.6s ease-in-out infinite}' +
  '@keyframes coh-mascot-flap-l{0%,100%{transform:rotate(0deg)}50%{transform:rotate(calc(var(--flap) * -1))}}' +
  '@keyframes coh-mascot-flap-r{0%,100%{transform:rotate(0deg)}50%{transform:rotate(var(--flap))}}' +
  '@keyframes coh-mascot-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(calc(var(--bob) * -1))}}' +
  '@keyframes coh-mascot-lamp{0%,100%{opacity:1}50%{opacity:.4}}' +
  '@media (prefers-reduced-motion:reduce){.coh-mascot-wing-l,.coh-mascot-wing-r,.coh-mascot-lamp,.coh-mascot-busy,.coh-mascot-ambient{animation:none}}'

/** Props for {@link CoHarnessMascot}: icon sizing plus the animation mode. */
export interface CoHarnessMascotProps extends IconProps {
  /** Animate the mascot as actively working: wings flap at their roots, the
   * body bobs, and the lamp breathes. Honors `prefers-reduced-motion`.
   * Takes precedence over `ambient`. */
  busy?: boolean | undefined
  /** Animate the mascot as an idle-alive brand mark on resting surfaces:
   * the same wing flap and lamp breath as `busy` at a slower, wider tempo.
   * Honors `prefers-reduced-motion`. */
  ambient?: boolean | undefined
}

/**
 * Render CoHarness's firefly mascot.
 *
 * Silhouette parts ride `currentColor`; cutouts paint the base background
 * token so the bug still reads on the hero backdrop. The lamp, halo, and ember
 * dots use the product's fixed brand blue, carried on `.coh-mascot-accent` by
 * the inline style so the mark brightens under `body[data-ds-dark-theme]`
 * without depending on theme-token naming. The animated variants keep the same
 * geometry: each wing tilts through a wrapper group so its own CSS rotation
 * composes with the drawn angle.
 * @param props - Size, placement, and animation props supplied by the host surface.
 * @returns the firefly mascot SVG.
 */
export function CoHarnessMascot({ size = 24, className, busy = false, ambient = false }: CoHarnessMascotProps) {
  const mode = busy ? 'busy' : ambient ? 'ambient' : undefined
  const animated = mode !== undefined
  const classes = [className, mode === undefined ? undefined : `coh-mascot-${mode}`].filter(Boolean).join(' ')
  const leftWing = (
    <ellipse
      cx="20" cy="26" rx="10.5" ry="5.5"
      style={{ fill: TILE, stroke: 'currentColor' }} strokeWidth="2.6"
      className={animated ? 'coh-mascot-wing-l' : undefined}
      transform={animated ? undefined : 'rotate(-28 20 26)'}
    />
  )
  const rightWing = (
    <ellipse
      cx="44" cy="20" rx="10.5" ry="5.5"
      style={{ fill: TILE, stroke: 'currentColor' }} strokeWidth="2.6"
      className={animated ? 'coh-mascot-wing-r' : undefined}
      transform={animated ? undefined : 'rotate(-36 44 20)'}
    />
  )
  const lamp = (
    <>
      <ellipse cx="40" cy="44" rx="6.4" ry="7.2" className="coh-mascot-accent" transform="rotate(16 40 44)" />
      <circle cx="38.5" cy="42.5" r="1.8" style={{ fill: TILE }} opacity=".8" />
    </>
  )
  return (
    <svg
      width={size}
      height={size}
      className={classes || undefined}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-brand="coharness-mascot"
    >
      <style>{animated ? ACCENT_STYLE + MOTION_STYLE : ACCENT_STYLE}</style>
      {animated ? <g transform="rotate(-28 20 26)">{leftWing}</g> : leftWing}
      {animated ? <g transform="rotate(-36 44 20)">{rightWing}</g> : rightWing}
      <path d="M26 14 q-3.5-6-9.5-7.5 M30.5 12.5 q-.5-7-4.5-11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="41" cy="44.5" r="13" className="coh-mascot-accent" opacity=".14" />
      <circle cx="29" cy="19" r="6.8" fill="currentColor" />
      <ellipse cx="33.5" cy="30.5" rx="7" ry="10" fill="currentColor" transform="rotate(16 33.5 30.5)" />
      {animated ? <g className="coh-mascot-lamp">{lamp}</g> : lamp}
      <circle cx="52" cy="38.5" r="1.7" className="coh-mascot-accent" />
      <circle cx="53.5" cy="47" r="1.3" className="coh-mascot-accent" />
      <circle cx="47" cy="53.5" r="1.5" className="coh-mascot-accent" />
      <circle cx="26.6" cy="18.5" r="1.5" style={{ fill: TILE }} />
    </svg>
  )
}
