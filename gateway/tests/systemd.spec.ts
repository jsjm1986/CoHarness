import { describe, expect, it } from 'vitest'
import { renderUserUnit, unitName, type SystemdOptions, type SystemdUser } from '../src/systemd.ts'

const OPTS: SystemdOptions = {
  usersRoot: '/srv/harness/users',
  projectRuntimesRoot: '/srv/harness/project-runtimes',
  projectPathRoots: ['/data/projects'],
  execStart: '/usr/local/bin/node /opt/dsh/lib/bin.js web --no-open --port {port}',
  gatewayDir: '/srv/harness/gateway',
  inaccessiblePaths: ['/srv/harness/gateway-data/bootstrap-admin-password'],
  memoryMax: '1G',
  cpuQuota: '100%',
}

const ALICE: SystemdUser = {
  username: 'alice',
  port: 42001,
  homePath: '/srv/harness/users/alice/home',
  dshHome: '/srv/harness/users/alice/dsh',
}

describe('unitName', () => {
  it('distinguishes legacy units from individual generations without username collisions', () => {
    expect(unitName('alice')).toBe('harness-alice.service')
    const fingerprint = 'a'.repeat(64)
    expect(unitName('alice', 2, fingerprint)).toBe(`harness-alice@2-${fingerprint}.service`)
    expect(unitName('alice-2')).not.toBe(unitName('alice', 2, fingerprint))
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => unitName('alice', generation, fingerprint)).toThrow('invalid runtime generation')
    }
    expect(() => unitName('alice', 2)).toThrow('invalid runtime credential fingerprint')
    expect(() => unitName('alice', undefined, fingerprint)).toThrow('invalid runtime credential fingerprint')
    expect(() => unitName('alice', 2, 'bad')).toThrow('invalid runtime credential fingerprint')
  })
})

describe('renderUserUnit', () => {
  it('permits verified retained paths while preserving confinement and unrelated grant rejection',()=>{
    const retained={...ALICE,homePath:'/data/retained/alice',dshHome:'/data/retained/isolated-runtime'}
    expect(()=>renderUserUnit(retained,[],OPTS)).toThrow('outside usersRoot')
    const unit=renderUserUnit({...retained,retainedData:true},[{path:retained.dshHome,mode:'rw'}],OPTS)
    expect(unit).toContain('WorkingDirectory='+retained.homePath)
    expect(unit).toContain('BindPaths='+retained.dshHome)
    expect(unit).toContain('ProtectSystem=strict')
    expect(unit).toContain('ProtectHome=tmpfs')
    expect(unit).toContain('TemporaryFileSystem='+OPTS.usersRoot+':ro')
    expect(()=>renderUserUnit({...retained,retainedData:true},[{path:'/unrelated/private',mode:'rw'}],OPTS)).toThrow('grant is outside managed roots')
    const project={...retained,kind:'project' as const,homePath:'/data/projects/team',retainedData:true as const}
    expect(renderUserUnit(project,[],OPTS)).toContain('WorkingDirectory=/data/projects/team')
    expect(()=>renderUserUnit({...project,homePath:'/unrelated/project'},[],OPTS)).toThrow('outside projectPathRoots')
  })

  const grants = [
    { path: '/srv/harness/users/alice/home', mode: 'rw' as const },
    { path: '/data/projects/team-alpha', mode: 'rw' as const },
    { path: '/data/projects/company-docs', mode: 'ro' as const },
  ]
  const unit = renderUserUnit(ALICE, grants, OPTS)

  it('applies kernel hardening: strict system, no-new-privs, private tmp', () => {
    expect(unit).toContain('ProtectSystem=strict')
    expect(unit).toContain('NoNewPrivileges=yes')
    expect(unit).toContain('PrivateTmp=yes')
    expect(unit).toContain('ProtectHome=tmpfs')
    expect(unit).toContain('CapabilityBoundingSet=~CAP_SYS_ADMIN')
  })

  it('gives administrators host visibility without changing the non-root account or fixed hardening', () => {
    const administrator = renderUserUnit(
      { ...ALICE, privileged: true },
      [{ path: '/', mode: 'rw' }],
      OPTS,
    )
    expect(administrator).toContain('User=harness-alice')
    expect(administrator).toContain('ProtectSystem=off')
    expect(administrator).toContain('ProtectHome=no')
    expect(administrator).toContain('BindPaths=/')
    expect(administrator).not.toContain('TemporaryFileSystem=')
    expect(administrator).toContain('NoNewPrivileges=yes')
    expect(administrator).toContain('CapabilityBoundingSet=~CAP_SYS_ADMIN')
    expect(administrator).toContain('InaccessiblePaths=-/srv/harness/gateway')
  })

  it('hides all user dirs then binds only this user home and grants', () => {
    // Every user directory is masked read-only...
    expect(unit).toContain('TemporaryFileSystem=/srv/harness/users:ro')
    expect(unit).toContain('TemporaryFileSystem=/srv/harness/project-runtimes:ro')
    expect(unit).toContain('TemporaryFileSystem=/data/projects:ro')
    // ...then this user's home + rw grants are bound writable...
    expect(unit).toContain('BindPaths=/srv/harness/users/alice/home')
    expect(unit).toContain('BindPaths=/data/projects/team-alpha')
    // ...and ro grants bound read-only.
    expect(unit).toContain('BindReadOnlyPaths=/data/projects/company-docs')
    // A ro grant must NOT appear as a writable bind.
    expect(unit).not.toContain('BindPaths=/data/projects/company-docs')
  })

  it('marks the gateway dir inaccessible', () => {
    expect(unit).toContain('InaccessiblePaths=-/srv/harness/gateway')
    expect(unit).toContain('InaccessiblePaths=-/srv/harness/gateway-data/bootstrap-admin-password')
  })

  it('delivers recovery policy through a read-only credential without exposing its source directory', () => {
    const policyFile = '/srv/harness/gateway/recovery policy.json'
    const policySha256 = 'b'.repeat(64)
    const recovered = renderUserUnit({ ...ALICE, recoveryPolicy: { policyFile, policySha256 } }, grants, OPTS)
    expect(recovered).toContain('Environment=HGW_RECOVERY_POLICY_FILE=%d/dsh-recovery')
    expect(recovered).toContain(`Environment=HGW_RECOVERY_POLICY_SHA256=${policySha256}`)
    expect(recovered).toContain(`LoadCredential="dsh-recovery:${policyFile}"`)
    expect(recovered).toContain('InaccessiblePaths=-/srv/harness/gateway')
    expect(recovered).not.toContain(`BindPaths=${policyFile}`)
    expect(unit).not.toContain('HGW_RECOVERY_POLICY')
    for (const unsafe of ['%d/recovery', '/tmp/a\nExecStart=bad', '/tmp/a:bad']) {
      expect(() => renderUserUnit({ ...ALICE, recoveryPolicy: { policyFile: unsafe, policySha256 } }, grants, OPTS)).toThrow()
    }
    expect(() => renderUserUnit({ ...ALICE, recoveryPolicy: { policyFile, policySha256: 'bad\nvalue' } }, grants, OPTS)).toThrow('invalid recovery policy handoff')
  })

  it('runs as a per-user system account under the user home with the grants file', () => {
    expect(unit).toContain('User=harness-alice')
    expect(unit).toContain('WorkingDirectory=/srv/harness/users/alice/home')
    expect(unit).toContain('Environment=DSH_HOME=/srv/harness/users/alice/dsh')
    expect(unit).toContain('Environment=DSH_DIRECTORY_GRANTS=/srv/harness/users/alice/dsh/directory-grants.json')
  })

  it('substitutes the port into ExecStart and applies resource limits', () => {
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/dsh/lib/bin.js" "web" "--no-open" "--port" "42001"')
    expect(unit).toContain('MemoryMax=1G')
    expect(unit).toContain('CPUQuota=100%')
  })

  it('restarts resident units unconditionally and ordinary units on failure', () => {
    expect(unit).toContain('Restart=on-failure')
    const resident = renderUserUnit({ ...ALICE, resident: true }, grants, OPTS)
    expect(resident).toContain('Restart=always')
    expect(resident).not.toContain('Restart=on-failure')
  })

  it('rejects grant paths that would break the unit file (newline / colon)', () => {
    expect(() => renderUserUnit(ALICE, [{ path: '/data/evil\nExecStart=/bin/sh', mode: 'rw' }], OPTS)).toThrow()
    expect(() => renderUserUnit(ALICE, [{ path: '/data/a:b', mode: 'rw' }], OPTS)).toThrow()
  })

  it('rejects an unsafe username', () => {
    expect(() => renderUserUnit({ ...ALICE, username: 'bad name' }, grants, OPTS)).toThrow()
  })

  it('rejects root and paths outside managed isolation roots', () => {
    expect(() => renderUserUnit({ ...ALICE, systemUser: 'root' }, grants, OPTS)).toThrow(/system user/)
    expect(() => renderUserUnit(ALICE, [{ path: '/data/unmanaged', mode: 'ro' }], OPTS)).toThrow(/managed roots/)
  })

  it('renders a project runtime with only its project and private dsh home re-bound', () => {
    const project = renderUserUnit({
      kind: 'project',
      username: 'project-41',
      runtimeKey: 'project-41',
      systemUser: 'harness-project',
      port: 42041,
      homePath: '/data/projects/compiler',
      dshHome: '/srv/harness/project-runtimes/41/dsh',
    }, [{ path: '/srv/harness/project-runtimes/41/dsh', mode: 'rw' }], OPTS)
    expect(project).toContain('BindPaths=/data/projects/compiler')
    expect(project).toContain('BindPaths=/srv/harness/project-runtimes/41/dsh')
    expect(project).not.toContain('BindPaths=/data/projects/other')
  })

  it('quotes argv fields so spaces and dollar signs cannot change systemd parsing', () => {
    const unit = renderUserUnit(ALICE, grants, {
      ...OPTS,
      execStart: ['/opt/My Harness/bin/node', '--title=hello world', '$HOME', '--port={port}'],
    })
    expect(unit).toContain('ExecStart="/opt/My Harness/bin/node" "--title=hello world" "$$HOME" "--port=42001"')
  })
})
