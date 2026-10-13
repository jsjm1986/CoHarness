import {
  ChartNoAxesCombined,
  Ellipsis,
  Archive,
  FileText,
  FolderKanban,
  LogOut,
  Monitor,
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
import { NavLink, Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom'
import { AuditPage } from './pages/AuditPage.tsx'
import { ProjectDetailPage } from './pages/ProjectDetailPage.tsx'
import { ProjectListPage } from './pages/ProjectListPage.tsx'
import { UsersPage } from './pages/UsersPage.tsx'
import { UserDetailPage } from './pages/UserDetailPage.tsx'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Dialog } from './components/ui.tsx'
import { adminLanguage, setAdminLanguage, translateCopy, type AdminLanguage } from './language.ts'
import { zh as chromeZh, en as chromeEn, type ChromeCopyKey } from './chrome.copy.ts'
const PluginsPage = lazy(async () => ({ default: (await import('./pages/PluginsPage.tsx')).PluginsPage }))
import { ModelsPage } from './pages/ModelsPage.tsx'
import { UsagePage } from './pages/UsagePage.tsx'
import { DocumentsPage } from './pages/DocumentsPage.tsx'
import { ArchivesPage } from './pages/ArchivesPage.tsx'
import { DesktopsPage } from './pages/DesktopsPage.tsx'
import { SshPage } from './pages/SshPage.tsx'
import { DeploymentPage } from './pages/DeploymentPage.tsx'
import { WebhooksPage } from './pages/WebhooksPage.tsx'
import { TerminalsPage } from './pages/TerminalsPage.tsx'
import { StewardPage } from './pages/StewardPage.tsx'

export function App() {
  useEffect(() => {
    const previous = document.documentElement.lang
    document.documentElement.lang = adminLanguage()
    return () => { document.documentElement.lang = previous }
  }, [])
  return (
    <Router basename="/admin">
      <div className="adminShell" data-testid="admin-app">
        <aside className="sidebar">
          <Brand />
          <AdminNav className="sidebarNav" />
          <div className="sidebarFooter">
            <ShellTitle />
            <LanguageSelect />
            <LogoutButton />
          </div>
        </aside>
        <header className="mobileHeader">
          <Brand compact />
          <LogoutButton compact />
        </header>
        <main className="mainContent">
          <Routes>
            <Route path="/" element={<UsersPage />} />
            <Route path="/users" element={<Navigate to="/" replace />} />
            <Route path="/users/:id" element={<UserDetailPage />} />
            <Route path="/projects" element={<ProjectListPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/plugins" element={<Suspense fallback={<PluginsFallback />}><PluginsPage /></Suspense>} />
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
            <Route path="/audit" element={<AuditPage />} />
          </Routes>
        </main>
        <AdminNav className="mobileNav" />
      </div>
    </Router>
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
  { to: '/audit', labelKey: 'navAudit', icon: ScrollText },
]

function ShellTitle() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return <span>{t('shellTitle')}</span>
}

function PluginsFallback() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return <p role="status">{t('loading')}</p>
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

/** The persisted surface-language choice; it writes localStorage and the `hgw_lang` cookie, then reloads to apply everywhere. */
function LanguageSelect() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return <select className="select selectCompact languageSelect" aria-label={t('languageAria')} value={adminLanguage()}
    onChange={event => { setAdminLanguage(event.target.value as AdminLanguage); window.location.reload() }}>
    <option value="zh">中文</option>
    <option value="en">English</option>
  </select>
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
        <LanguageSelect />
      </Dialog> : null}
    </>
  )
}
