import { DeploymentContextProvider, useDeploymentContext } from './deployment-context.tsx'
import {
  ChartNoAxesCombined,
  Ellipsis,
  Archive,
  FileText,
  FolderKanban,
  LogOut,
  Monitor,
  ScreenShare,
  Network,
  Terminal,
  Puzzle,
  Rocket,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Users,
  Webhook,
  type LucideIcon,
} from 'lucide-react'
import { Link, NavLink, Navigate, Route, createBrowserRouter, RouterProvider, Routes, useLocation } from 'react-router-dom'
import { UsersPage } from './pages/UsersPage.tsx'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { createPageImport, lazyPage, PageLoading } from './components/async-route.tsx'
import { Button, Dialog, ErrorBanner, PageHeader } from './components/ui.tsx'
import { adminLanguage, setAdminLanguage, translateCopy } from './language.ts'
import { zh as chromeZh, en as chromeEn, type ChromeCopyKey } from './chrome.copy.ts'
import { ComputerSelectorProvider } from './ComputerSelector.tsx'
import { adminComputerBase, adminComputerTarget } from './computer-target.ts'
import { PendingEditsProvider, useProtectedNavigation } from './pending-edits.tsx'
import { zh as computerZh, en as computerEn } from './computer.copy.ts'

const ArchivesPage = lazyPage(async () => ({ default: (await import('./pages/ArchivesPage.tsx')).ArchivesPage }))
const AuditPage = lazyPage(async () => ({ default: (await import('./pages/AuditPage.tsx')).AuditPage }))
const DeploymentPage = lazyPage(async () => ({ default: (await import('./pages/DeploymentPage.tsx')).DeploymentPage }))
const DesktopsPage = lazyPage(async () => ({ default: (await import('./pages/DesktopsPage.tsx')).DesktopsPage }))
const DocumentsPage = lazyPage(async () => ({ default: (await import('./pages/DocumentsPage.tsx')).DocumentsPage }))
const GovernanceRecoveryPage = lazyPage(async () => ({
  default: (await import('./pages/GovernanceRecoveryPage.tsx')).GovernanceRecoveryPage,
}))
const LocalGovernanceRecoveryPage = lazyPage(async () => ({
  default: (await import('./pages/GovernanceRecoveryPage.tsx')).LocalGovernanceRecoveryPage,
}))
const modelCatalog = createPageImport(() => import('./pages/ModelsPage.tsx'))
const ModelsPage = lazyPage(async () => ({ default: (await modelCatalog.load()).ModelsPage }))
const PluginsPage = lazyPage(async () => ({ default: (await import('./pages/PluginsPage.tsx')).PluginsPage }))
const ProjectDetailPage = lazyPage(async () => ({ default: (await import('./pages/ProjectDetailPage.tsx')).ProjectDetailPage }))
const ProjectListPage = lazyPage(async () => ({ default: (await import('./pages/ProjectListPage.tsx')).ProjectListPage }))
const RemoteDesktopPage = lazyPage(async () => ({ default: (await import('./pages/RemoteDesktopPage.tsx')).RemoteDesktopPage }))
const SshPage = lazyPage(async () => ({ default: (await import('./pages/SshPage.tsx')).SshPage }))
const StewardPage = lazyPage(async () => ({ default: (await import('./pages/StewardPage.tsx')).StewardPage }))
const TerminalsPage = lazyPage(async () => ({ default: (await import('./pages/TerminalsPage.tsx')).TerminalsPage }))
const UsagePage = lazyPage(async () => ({ default: (await import('./pages/UsagePage.tsx')).UsagePage }))
const UserDetailPage = lazyPage(async () => ({ default: (await import('./pages/UserDetailPage.tsx')).UserDetailPage }))
const WebhooksPage = lazyPage(async () => ({ default: (await import('./pages/WebhooksPage.tsx')).WebhooksPage }))

export function App() {
  const path = window.location.pathname
  if (path === '/admin/governance-recovery/local' || path === '/admin/governance-recovery') {
    const RecoveryPage = path.endsWith('/local') ? LocalGovernanceRecoveryPage : GovernanceRecoveryPage
    return <PendingEditsProvider><Suspense fallback={<PageLoading />}><RecoveryPage /></Suspense></PendingEditsProvider>
  }
  return <OrdinaryAdminApp />
}

function OrdinaryAdminApp() {
  const [computer] = useState(() => {
    try { return { nodeId: adminComputerTarget(window.location.pathname), invalid: false } }
    catch { return { nodeId: undefined, invalid: true } }
  })
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: computerZh, en: computerEn }), [])
  const [router, setRouter] = useState<ReturnType<typeof createBrowserRouter>>()
  useEffect(() => {
    if (computer.invalid) return
    const owned = createBrowserRouter([{ path: '*', element: <PendingEditsProvider protectHistory>
      <DeploymentContextProvider><AdminDocument nodeId={computer.nodeId} /></DeploymentContextProvider>
    </PendingEditsProvider> }], { basename: adminComputerBase(computer.nodeId) })
    setRouter(owned)
    return () => { owned.dispose() }
  }, [computer])
  if (computer.invalid) return <main className="mainContent">
    <div className="page adminEntryNotice">
      <ErrorBanner message={t('invalid')} />
      <a className="button button-secondary" href="/admin/">{t('returnCenter')}</a>
    </div>
  </main>
  return router === undefined ? <PageLoading /> : <RouterProvider router={router} />
}

function AdminDocument({ nodeId }: { nodeId: ReturnType<typeof adminComputerTarget> }) {
  const navigation = useProtectedNavigation()
  const deployment = useDeploymentContext()
  const location = useLocation()
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: computerZh, en: computerEn }), [])
  const unavailable = nodeId !== undefined && deployment.value !== null && deployment.value.scope === 'local' && nodeId !== deployment.value.entry.nodeId
  useEffect(() => {
    const previous = document.documentElement.lang
    document.documentElement.lang = adminLanguage()
    return () => { document.documentElement.lang = previous }
  }, [])
  return (
    <>
      <div className="adminShell" data-testid="admin-app">
        <aside className="sidebar">
          <Brand />
          <AdminNav className="sidebarNav" />
          <div className="sidebarFooter">
            <AccountActions />
          </div>
        </aside>
        <header className="mobileHeader">
          <Brand compact />
          <AccountActions compact />
        </header>
        <main className="mainContent">
          {deployment.error && location.pathname !== '/deployment' && <div className="page adminEntryNotice">
            <ErrorBanner message={t('policyFailed')} />
            <Button onClick={() => void deployment.refresh()}>{t('retryPolicy')}</Button>
          </div>}
          {unavailable && <div className="page adminEntryNotice">
            <ErrorBanner message={t('entryUnavailable')} />
            <a className="button button-secondary" href="/admin/" target="_blank" rel="noopener noreferrer">{t('openLocal')}</a>
          </div>}
          <ComputerSelectorProvider enabled={deployment.value?.scope === 'organization'} nodeId={nodeId} onSelect={nextNodeId => {
            navigation.navigate(`${adminComputerBase(nextNodeId)}${location.pathname}${location.search}${location.hash}`)
          }}>
            <div className="adminRouteContent" inert={unavailable || undefined} aria-disabled={unavailable || undefined}>
              <Suspense fallback={<PageLoading />}>
                <Routes>
                  <Route path="/" element={<UsersPage prepareNextPage={
                    deployment.value !== null && !deployment.error && !unavailable ? modelCatalog.prepare : undefined
                  } />} />
                  <Route path="/users" element={<Navigate to="/" replace />} />
                  <Route path="/users/:id" element={<UserDetailPage />} />
                  <Route path="/projects" element={<ProjectListPage />} />
                  <Route path="/projects/:id" element={<ProjectDetailPage />} />
                  <Route path="/plugins" element={<PluginsPage />} />
                  <Route path="/models" element={<ModelsPage />} />
                  <Route path="/usage" element={<UsagePage />} />
                  <Route path="/documents" element={<DocumentsPage />} />
                  <Route path="/archives" element={<ArchivesPage />} />
                  <Route path="/terminals" element={<TerminalsPage />} />
                  <Route path="/ssh" element={<SshPage />} />
                  <Route path="/deployment" element={<DeploymentPage />} />
                  <Route path="/steward" element={<StewardPage />} />
                  <Route path="/webhooks" element={<WebhooksPage />} />
                  <Route path="/desktops" element={<DesktopsPage />} />
                  <Route path="/remote-desktops" element={<RemoteDesktopPage />} />
                  <Route path="/audit" element={<AuditPage />} />
                  <Route path="*" element={<AdminPageNotFound />} />
                </Routes>
              </Suspense>
            </div>
          </ComputerSelectorProvider>
        </main>
        <AdminNav className="mobileNav" />
      </div>
    </>
  )
}

const NAV_ITEMS: Array<{ to: string; labelKey: ChromeCopyKey; icon: LucideIcon; end?: boolean }> = [
  { to: '/', labelKey: 'navUsers', icon: Users, end: true },
  { to: '/projects', labelKey: 'navProjects', icon: FolderKanban },
  { to: '/plugins', labelKey: 'navPlugins', icon: Puzzle },
  { to: '/models', labelKey: 'navModels', icon: Sparkles },
  { to: '/usage', labelKey: 'navUsage', icon: ChartNoAxesCombined },
  { to: '/documents', labelKey: 'navDocuments', icon: FileText },
  { to: '/archives', labelKey: 'navArchives', icon: Archive },
  { to: '/terminals', labelKey: 'navTerminals', icon: Terminal },
  { to: '/ssh', labelKey: 'navSsh', icon: Network },
  { to: '/deployment', labelKey: 'navDeployment', icon: Rocket },
  { to: '/steward', labelKey: 'navSteward', icon: ShieldCheck },
  { to: '/webhooks', labelKey: 'navWebhooks', icon: Webhook },
  { to: '/desktops', labelKey: 'navDesktops', icon: Monitor },
  { to: '/remote-desktops', labelKey: 'navRemoteDesktops', icon: ScreenShare },
  { to: '/audit', labelKey: 'navAudit', icon: ScrollText },
]

function AdminPageNotFound() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return <div className="page">
    <PageHeader title={t('pageNotFound')} description={t('pageNotFoundDetail')}
      actions={<Link to="/" className="button button-primary">{t('returnToUsers')}</Link>} />
  </div>
}

/** The CoHarness firefly mark; silhouette parts ride `currentColor`, `.cut` cutouts take the surface behind them, and `.lamp` parts use the brand accent — both classes resolve in index.css. */
function BrandMark() {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <ellipse cx="20" cy="26" rx="10.5" ry="5.5" className="cut" stroke="currentColor" strokeWidth="2.6" transform="rotate(-28 20 26)" />
      <ellipse cx="44" cy="20" rx="10.5" ry="5.5" className="cut" stroke="currentColor" strokeWidth="2.6" transform="rotate(-36 44 20)" />
      <path d="M26 14 q-3.5-6-9.5-7.5 M30.5 12.5 q-.5-7-4.5-11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="41" cy="44.5" r="13" className="lamp" opacity=".14" />
      <circle cx="29" cy="19" r="6.8" fill="currentColor" />
      <ellipse cx="33.5" cy="30.5" rx="7" ry="10" fill="currentColor" transform="rotate(16 33.5 30.5)" />
      <ellipse cx="40" cy="44" rx="6.4" ry="7.2" className="lamp" transform="rotate(16 40 44)" />
      <circle cx="38.5" cy="42.5" r="1.8" className="cut" opacity=".8" />
      <circle cx="52" cy="38.5" r="1.7" className="lamp" />
      <circle cx="53.5" cy="47" r="1.3" className="lamp" />
      <circle cx="47" cy="53.5" r="1.5" className="lamp" />
      <circle cx="26.6" cy="18.5" r="1.5" className="cut" />
    </svg>
  )
}

function Brand({ compact = false }: { compact?: boolean }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return (
    <div className={`brand ${compact ? 'brandCompact' : ''}`}>
      <span className="brandMark"><BrandMark /></span>
      <span className="brandCopy">
        <strong>COHARNESS</strong>
        {compact ? null : <span>{t('brandSub')}</span>}
      </span>
    </div>
  )
}

function AccountActions({ compact = false }: { compact?: boolean }) {
  const language = adminLanguage()
  const t = translateCopy(language, { zh: chromeZh, en: chromeEn })
  const navigation = useProtectedNavigation()
  return <div className="accountActions">
    <Button type="button" variant="ghost" className="languageButton" aria-label={t('languageAria')} title={t('languageAction')}
      onClick={() => {
        if (!navigation.canReplace()) return
        setAdminLanguage(language === 'zh' ? 'en' : 'zh')
        window.location.reload()
      }}>
      <span className="languageMark" aria-hidden="true">{t('languageMark')}</span>
    </Button>
    <LogoutButton compact={compact} />
  </div>
}

function LogoutButton({ compact = false }: { compact?: boolean }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return (
    <form className={`logoutForm ${compact ? 'logoutFormCompact' : ''}`} method="post" action="/logout">
      <button
        type="submit"
        className={`button button-ghost logoutButton ${compact ? 'logoutButtonCompact' : ''}`}
        aria-label={t('logout')}
        title={t('logout')}
      >
        <LogOut aria-hidden="true" />
        {compact ? null : <span>{t('logout')}</span>}
      </button>
    </form>
  )
}

function AdminNav({ className }: { className: string }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  const [moreOpen, setMoreOpen] = useState(false)
  const { pathname } = useLocation()
  const mobile = className === 'mobileNav'
  const moreItems = NAV_ITEMS.slice(5)
  const moreActive = moreItems.some(item => pathname === item.to || pathname.startsWith(`${item.to}/`))
  return (
    <>
      <nav className={className} aria-label={t('navAria')}>
        {(mobile ? NAV_ITEMS.slice(0, 5) : NAV_ITEMS).map(({ to, labelKey, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}>
            <Icon aria-hidden="true" />
            <span>{t(labelKey)}</span>
          </NavLink>
        ))}
        {mobile ? <button type="button" className={moreActive ? 'active' : undefined}
          aria-label={t('moreAria')} aria-haspopup="dialog" aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}>
          <Ellipsis aria-hidden="true" /><span>{t('moreLabel')}</span>
        </button> : null}
      </nav>
      {mobile ? <Dialog open={moreOpen} title={t('moreTitle')} onClose={() => setMoreOpen(false)}>
        <nav className="mobileMoreNav" aria-label={t('moreAria')}>
          {moreItems.map(({ to, labelKey, icon: Icon, end }) => <NavLink key={to} to={to} end={end}
            onClick={() => setMoreOpen(false)}>
            <Icon aria-hidden="true" /><span>{t(labelKey)}</span>
          </NavLink>)}
        </nav>
      </Dialog> : null}
    </>
  )
}
