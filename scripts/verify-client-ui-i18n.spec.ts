import { describe, expect, it } from 'vitest'
import { clientSourceRoot, findUiI18nViolations } from './verify-client-ui-i18n.ts'

function messages(source: string): string[] {
  return findUiI18nViolations('packages/client/ui-example/src/client/View.tsx', source)
    .map(violation => violation.text)
}

describe('Client UI i18n source check', () => {
  it('rejects direct JSX copy and copy-bearing attributes', () => {
    expect(messages(`
      const View = ({ ready }: { ready: boolean }) => <section aria-label="Overview">
        <span>Hard-coded text</span>
        <input placeholder={ready ? 'Search now' : ` + "`Wait ${'${ready}'}`" + `} />
        <div runningSummary="Still working" />
      </section>
    `)).toEqual(['Overview', 'Hard-coded text', 'Search now', 'Wait', 'Still working'])
  })

  it('rejects copy kept in label data and copy helper returns', () => {
    expect(messages(`
      const TABS = [{ id: 'summary', label: 'Summary' }]
      function statusLabel(status: string): string {
        if (status === 'done') return 'Complete'
        return 'Still running'
      }
      function duration(): string { return 'Not recorded' }
      function mode(): string { return 'compact' }
      function displayFailureMessage(): string { return 'API key is invalid' }
      const emptySummary = 'Nothing to show'
      function Dialog({ closeLabel = 'Close dialog' }: { closeLabel?: string }) { return closeLabel }
    `)).toEqual([
      'Summary', 'Complete', 'Still running', 'Not recorded', 'API key is invalid',
      'Nothing to show', 'Close dialog',
    ])
  })

  it('normalizes native separators before deriving a Client source root', () => {
    expect(clientSourceRoot('packages/extensions/sample/src/client/View.tsx'))
      .toBe('packages/extensions/sample/src/client')
    expect(clientSourceRoot('packages\\extensions\\sample\\src\\client\\View.tsx'))
      .toBe('packages/extensions/sample/src/client')
    expect(clientSourceRoot('packages/extensions/sample/src/server/index.ts')).toBeUndefined()
  })

  it('accepts translated copy, dynamic values, structural attributes, and language tokens', () => {
    expect(messages(`
      const View = ({ t, value }: { t: (key: string) => string; value: string }) => (
        <section className="root" role="region" aria-label={t('overview')}>
          <span>{t('status.complete')}</span>
          <code>null</code>
          {value === 'pending' && <output>{value}</output>}
          <output>{value}</output>
        </section>
      )
    `)).toEqual([])
  })

  it('does not inspect locale dictionary owners', () => {
    expect(findUiI18nViolations(
      'packages/client/ui-example/src/client/locales.ts',
      'export const en = { title: "Hard-coded by design" }',
    )).toEqual([])
  })

  it('keeps ARIA keyboard tokens and references literal while checking descriptive prop-bag text', () => {
    expect(messages(`
      const aria = { 'aria-keyshortcuts': 'Control+P F2', 'aria-controls': 'DetailsPanel', 'aria-haspopup': 'dialog' }
      const shortcut = { keys: ['F2'], aria: 'F2' }
      const labels = [{ shortcut: { keys: ['Control', 'P'], aria: 'Control+P' } }]
      const View = () => <MenuItem aria={{ 'aria-keyshortcuts': 'F2' }} />
      const Rename = () => <MenuItem shortcut={{ keys: ['F2'], aria: 'F2' }} />
    `)).toEqual([])
    expect(messages(`
      const View = () => <MenuItem aria={{
        'aria-label': 'Rename terminal',
        'aria-description': 'Change its visible name',
        'aria-valuetext': 'Ready to rename',
        'aria-roledescription': 'Terminal action',
      }} />
    `)).toEqual(['Rename terminal', 'Change its visible name', 'Ready to rename', 'Terminal action'])
    expect(messages('const View = () => <div aria-roledescription="Desktop viewer" />'))
      .toEqual(['Desktop viewer'])
    expect(messages('const label = { aria: "Rename terminal" }')).toEqual(['Rename terminal'])
  })

  it('rejects Electron dialog, title, prompt, and DOM copy outside locale owners', () => {
    const source = `
      dialog.showMessageBox({ title: 'Update available', message: 'Install it now?' })
      window.setTitle('Desktop plugins')
      window.prompt('Target version')
      status.textContent = 'Finished'
    `
    expect(findUiI18nViolations('apps/desktop/src/main.ts', source).map(row => row.text)).toEqual([
      'Update available',
      'Install it now?',
      'Desktop plugins',
      'Target version',
      'Finished',
    ])
  })
})
