/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/**
 * The firefly mascot as raw markup: ink rides --dsh-boot-ink, cutouts ride
 * --dsh-boot-tile, the lamp/halo/embers ride --dsh-boot-accent.
 */
const MASCOT_SVG = `<svg viewBox="0 0 64 64" width="44" height="44" fill="none" aria-hidden="true">
<ellipse cx="20" cy="26" rx="10.5" ry="5.5" stroke-width="2.6" transform="rotate(-28 20 26)" style="fill:var(--dsh-boot-tile);stroke:var(--dsh-boot-ink)"/>
<ellipse cx="44" cy="20" rx="10.5" ry="5.5" stroke-width="2.6" transform="rotate(-36 44 20)" style="fill:var(--dsh-boot-tile);stroke:var(--dsh-boot-ink)"/>
<path d="M26 14 q-3.5-6-9.5-7.5 M30.5 12.5 q-.5-7-4.5-11" stroke-width="1.9" stroke-linecap="round" style="stroke:var(--dsh-boot-ink);fill:none"/>
<circle cx="41" cy="44.5" r="13" opacity=".14" style="fill:var(--dsh-boot-accent)"/>
<circle cx="29" cy="19" r="6.8" style="fill:var(--dsh-boot-ink)"/>
<ellipse cx="33.5" cy="30.5" rx="7" ry="10" transform="rotate(16 33.5 30.5)" style="fill:var(--dsh-boot-ink)"/>
<ellipse cx="40" cy="44" rx="6.4" ry="7.2" transform="rotate(16 40 44)" style="fill:var(--dsh-boot-accent)"/>
<circle cx="38.5" cy="42.5" r="1.8" opacity=".8" style="fill:var(--dsh-boot-tile)"/>
<circle cx="52" cy="38.5" r="1.7" style="fill:var(--dsh-boot-accent)"/>
<circle cx="53.5" cy="47" r="1.3" style="fill:var(--dsh-boot-accent)"/>
<circle cx="47" cy="53.5" r="1.5" style="fill:var(--dsh-boot-accent)"/>
<circle cx="26.6" cy="18.5" r="1.5" style="fill:var(--dsh-boot-tile)"/>
</svg>`

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly brand: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.brand = div(css.brand)
    this.brand.innerHTML = MASCOT_SVG
    const wordmark = div(css.wordmark, 'COHARNESS')
    this.brand.append(wordmark)
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'Loading plugins…')
    this.card.append(this.brand, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.brand, this.spinner, this.hint)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.brand, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
