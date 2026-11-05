import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/ai-chat-api'
import type {
  AcpProvider,
  AcpProviderList,
  AcpTestResult,
} from '@/lib/ai-chat-api'
import { CrmError } from '@/lib/api-crm'
import { AcpProvidersPane } from '@/components/preferences/panes/AcpProvidersPane'
import { visibleNavItems } from '@/components/preferences/panes'

const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: auth.role } }),
}))
vi.mock('@/lib/ai-chat-api', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/ai-chat-api')
  return {
    ...actual,
    listAcpProviders: vi.fn(),
    createAcpProvider: vi.fn(),
    updateAcpProvider: vi.fn(),
    deleteAcpProvider: vi.fn(),
    generateAcpKey: vi.fn(),
    testAcpProvider: vi.fn(),
  }
})

// Obviously fake values throughout: nothing here is a real key or host.
const PUBLIC_KEY = 'ssh-ed25519 AAAAFAKEPUBLICKEYFAKEPUBLICKEYFAKEPUBLICKEY'
const HOST_KEY = 'ssh-ed25519 AAAAFAKEHOSTKEYFAKEHOSTKEYFAKEHOSTKEYFAKEHOST'
const LINE = `from="192.0.2.10",restrict,command="/opt/fake/launch jarvis" ${PUBLIC_KEY} mk1-jarvis`
const FINGERPRINT = 'SHA256:fakefingerprintfakefingerprintfakefingerp'
const NOT_READY =
  'This provider needs a passing Test connection first. Turn Enabled off and save, run Test connection, then turn Enabled on again.'
const RETEST_LOST =
  'Changing the roles or connection settings removes the passing test, so this provider cannot stay enabled. Turn Enabled off to save, then test and enable it again.'
const SAVED_ONLY =
  'Test connection and Generate key use the saved settings. Save or cancel first.'

const bare: AcpProvider = {
  id: 1,
  slug: 'jarvis',
  display_name: 'Jarvis',
  enabled: false,
  ssh_host: 'bot.example.test',
  ssh_port: 22,
  ssh_user: 'fake-user',
  host_key: HOST_KEY,
  host_key_fingerprint: FINGERPRINT,
  public_key: null,
  key_created_at: null,
  authorized_keys_line: null,
  launcher_path: '/opt/fake/launch',
  authorized_from: '192.0.2.10',
  session_cwd: '/srv/fake/work',
  allowed_roles: ['admin'],
  inject_mk1_tools: false,
  max_sessions: 4,
  idle_minutes: 15,
  permission_timeout_s: 240,
  agent_approval_timeout_s: 300,
  last_test_at: null,
  last_test_ok: null,
  last_test_error: null,
  last_agent_info: null,
  last_capabilities: null,
  live_sessions: 0,
  updated_at: '2026-11-03T10:00:00Z',
}
const keyed: AcpProvider = {
  ...bare,
  public_key: PUBLIC_KEY,
  key_created_at: '2026-11-03T09:00:00Z',
  authorized_keys_line: LINE,
}
const standardUntested: AcpProvider = {
  ...keyed,
  allowed_roles: ['admin', 'standard'],
  last_test_ok: null,
}

const failedTest: AcpTestResult = {
  ok: false,
  error: 'Could not connect.',
  stderr_tail: ['Permission denied (publickey).', '<b>x</b>'],
  timings_ms: {
    connect: null,
    initialize: null,
    new_session: null,
    tools: null,
  },
  agent_info: null,
  capabilities: null,
  tools: [],
}
const passedTest: AcpTestResult = {
  ok: true,
  error: null,
  stderr_tail: null,
  timings_ms: { connect: 812, initialize: null, new_session: 430, tools: 95 },
  agent_info: { name: 'fake-agent', version: '9.9.9' },
  capabilities: { loadSession: true },
  tools: ['todo_list', 'mcp__mk1__find_sample'],
}

function list(providers: AcpProvider[], configured = true): AcpProviderList {
  return { configured, providers }
}

/** The client of the latest `setup`. */
let qc: QueryClient

function setup(providers: AcpProvider[], configured = true) {
  vi.mocked(api.listAcpProviders).mockResolvedValue(list(providers, configured))
  const user = userEvent.setup()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AcpProvidersPane />
    </QueryClientProvider>
  )
  return user
}

const edit = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Edit Jarvis' }))
  return screen.getByRole('switch', { name: 'Enabled' })
}

// Real keyboard focus on the wrapper, not a synthetic event: a wrapper that
// is not focusable would not take it, and the tooltip would never open.
const focusReason = () =>
  act(() => screen.getByTestId('enabled-reason-trigger').focus())

const fill = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string
) => {
  const field = screen.getByLabelText(label)
  await user.clear(field)
  await user.click(field)
  await user.paste(value)
}

describe('AcpProvidersPane', () => {
  describe("the chat button's provider list", () => {
    const BUTTON_KEY = ['ai-chat', 'providers', 7]
    const stale = () => qc.getQueryState(BUTTON_KEY)?.isInvalidated
    const ready = (providers: AcpProvider[]) => {
      const user = setup(providers)
      qc.setQueryData(BUTTON_KEY, [])
      expect(stale()).toBe(false)
      return user
    }

    it('goes stale when a provider is saved', async () => {
      vi.mocked(api.updateAcpProvider).mockResolvedValue(keyed)
      const user = ready([keyed])
      await edit(user)
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(stale()).toBe(true))
    })

    it('goes stale when a key is generated', async () => {
      vi.mocked(api.generateAcpKey).mockResolvedValue(keyed)
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const user = ready([bare])
      await user.click(
        await screen.findByRole('button', { name: 'Generate key for Jarvis' })
      )
      await waitFor(() => expect(stale()).toBe(true))
    })

    it('goes stale when a provider is deleted', async () => {
      vi.mocked(api.deleteAcpProvider).mockResolvedValue()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const user = ready([bare])
      await user.click(
        await screen.findByRole('button', { name: 'Delete Jarvis' })
      )
      await waitFor(() => expect(stale()).toBe(true))
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    auth.role = 'admin'
  })

  it('lists the provider with status, roles, live sessions and the last test', async () => {
    setup([
      {
        ...keyed,
        enabled: true,
        allowed_roles: ['admin', 'standard'],
        live_sessions: 2,
        last_test_at: '2026-11-02T09:30:00Z',
        last_test_ok: true,
        last_agent_info: { name: 'fake-agent', version: '9.9.9' },
        last_capabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false },
          sessionCapabilities: { resume: {} },
        },
      },
    ])
    expect(await screen.findByText('Jarvis')).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    expect(screen.getByText(/Roles: admin, standard/)).toBeInTheDocument()
    expect(screen.getByText(/2 live sessions/)).toBeInTheDocument()
    const last = screen.getByTestId('last-test')
    expect(last).toHaveTextContent('Last test passed')
    expect(last).toHaveTextContent('fake-agent 9.9.9')
    expect(last).toHaveTextContent('loadSession')
    expect(last).toHaveTextContent('promptCapabilities.image')
    expect(last).toHaveTextContent('sessionCapabilities.resume')
    expect(last).not.toHaveTextContent('audio')
    expect(last).not.toHaveTextContent('Invalid Date')
  })

  it('shows the authorized_keys line after Generate key', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = setup([bare])
    vi.mocked(api.generateAcpKey).mockResolvedValue({
      ...keyed,
      updated_at: '2026-11-03T10:05:00Z',
    })
    await user.click(
      await screen.findByRole('button', { name: 'Generate key for Jarvis' })
    )
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/install the new line/i)
    expect(api.generateAcpKey).toHaveBeenCalledWith(1)

    const line = await screen.findByText(LINE)
    expect(line.tagName).toBe('PRE')
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible()
    expect(await navigator.clipboard.readText()).toBe(LINE)
    expect(document.body.textContent).not.toMatch(/PRIVATE KEY/)
  })

  it('warns that a new key replaces the old one, and leaves it alone when declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = setup([keyed])
    await user.click(
      await screen.findByRole('button', { name: 'Generate key for Jarvis' })
    )
    const warning = String(confirm.mock.calls[0]?.[0])
    expect(warning).toMatch(/replaces the existing key/)
    expect(warning).toMatch(/standard/)
    expect(warning).toMatch(/install the new line/i)
    expect(api.generateAcpKey).not.toHaveBeenCalled()
  })

  it('opens the form from the row Generate key returns, with Enabled off', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = setup([{ ...standardUntested, enabled: true }])
    // The server disables a standard-role provider when its key is replaced.
    vi.mocked(api.generateAcpKey).mockResolvedValue({
      ...standardUntested,
      enabled: false,
      updated_at: '2026-11-03T10:05:00Z',
    })
    await user.click(
      await screen.findByRole('button', { name: 'Generate key for Jarvis' })
    )
    await waitFor(() => expect(screen.getByText('Disabled')).toBeVisible())
    expect(await edit(user)).not.toBeChecked()
  })

  it('leaves Test connection and Generate key off while the form is open, and says why', async () => {
    const user = setup([keyed])
    expect(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    ).toBeEnabled()
    expect(screen.queryByText(SAVED_ONLY)).toBeNull()
    await edit(user)
    // Both act on the saved row: an unsaved host would be tested as the old one,
    // and a new key would remount the form over the edits.
    expect(
      screen.getByRole('button', { name: 'Test connection for Jarvis' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Generate key for Jarvis' })
    ).toBeDisabled()
    expect(screen.getByText(SAVED_ONLY)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByRole('button', { name: 'Test connection for Jarvis' })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Generate key for Jarvis' })
    ).toBeEnabled()
    expect(screen.queryByText(SAVED_ONLY)).toBeNull()
  })

  it('clears a stale test report once the form saves', async () => {
    const user = setup([keyed])
    vi.mocked(api.testAcpProvider).mockResolvedValue(passedTest)
    vi.mocked(api.updateAcpProvider).mockResolvedValue({
      ...keyed,
      ssh_host: 'other.example.test',
      last_test_ok: null,
      updated_at: '2026-11-03T10:05:00Z',
    })
    await user.click(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    )
    expect(await screen.findByTestId('test-report')).toBeInTheDocument()
    await edit(user)
    await fill(user, 'SSH host', 'other.example.test')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByLabelText('SSH host')).toBeNull())
    expect(screen.queryByTestId('test-report')).toBeNull()
  })

  it('clears a stale test report once a new key is generated', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = setup([keyed])
    vi.mocked(api.testAcpProvider).mockResolvedValue(passedTest)
    vi.mocked(api.generateAcpKey).mockResolvedValue({
      ...keyed,
      last_test_ok: null,
      updated_at: '2026-11-03T10:05:00Z',
    })
    await user.click(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    )
    expect(await screen.findByTestId('test-report')).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'Generate key for Jarvis' })
    )
    await waitFor(() => expect(api.generateAcpKey).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId('test-report')).toBeNull())
  })

  it.each([
    ['a key', { ...bare, host_key: HOST_KEY }, /Generate a key first/],
    [
      'a host key',
      {
        ...keyed,
        host_key: null,
        host_key_fingerprint: null,
      },
      /Add the host key first/,
    ],
  ])(
    'disables Enabled until a key and host key exist (missing %s)',
    async (_name, provider, reason) => {
      const user = setup([provider])
      const toggle = await edit(user)
      expect(toggle).toBeDisabled()
      // A disabled control gets no focus or hover, so the reason hangs off
      // a focusable wrapper.
      await focusReason()
      expect(await screen.findByRole('tooltip')).toHaveTextContent(reason)
    }
  )

  it('keeps Enabled disabled for a standard-role provider with no passing test', async () => {
    const user = setup([standardUntested])
    const toggle = await edit(user)
    expect(toggle).toBeDisabled()
    await focusReason()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /passing Test connection/
    )
  })

  it('lets Enabled on once a standard-role provider has passed its test', async () => {
    const user = setup([{ ...standardUntested, last_test_ok: true }])
    expect(await edit(user)).toBeEnabled()
  })

  it('lets an admin-only provider be enabled without a test', async () => {
    const user = setup([keyed])
    expect(await edit(user)).toBeEnabled()
  })

  it('takes the passing test back once a connection setting changes in the form', async () => {
    const user = setup([{ ...standardUntested, last_test_ok: true }])
    const toggle = await edit(user)
    expect(toggle).toBeEnabled()
    await fill(user, 'SSH host', 'other.example.test')
    expect(toggle).toBeDisabled()
    await focusReason()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /Save, then run Test connection again/
    )
  })

  it('takes the passing test back once standard is added to an admin-only provider', async () => {
    const user = setup([{ ...keyed, last_test_ok: true }])
    const toggle = await edit(user)
    expect(toggle).toBeEnabled()
    await user.click(screen.getByRole('checkbox', { name: 'standard' }))
    expect(toggle).toBeDisabled()
  })

  it('keeps Enabled available when only the spelling of the port changes', async () => {
    const user = setup([{ ...standardUntested, last_test_ok: true }])
    const toggle = await edit(user)
    // The server compares ints, and "022" is port 22: the test still holds.
    // fireEvent, not typing: user-event normalises a number field to "22".
    const port = screen.getByLabelText('SSH port')
    fireEvent.change(port, { target: { value: '022' } })
    expect(port).toHaveValue(22)
    expect((port as HTMLInputElement).value).toBe('022')
    expect(toggle).toBeEnabled()
    await fill(user, 'SSH port', '2222')
    expect(toggle).toBeDisabled()
  })

  it('never traps an enabled provider on: it can always be switched off', async () => {
    const user = setup([{ ...standardUntested, enabled: true }])
    const toggle = await edit(user)
    expect(toggle).toBeChecked()
    expect(toggle).toBeEnabled()
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
  })

  it('shows the host key fingerprint under the host key', async () => {
    const user = setup([keyed])
    await edit(user)
    expect(screen.getByText(FINGERPRINT)).toBeInTheDocument()
    await fill(user, 'Host key', 'ssh-ed25519 AAAAFAKEOTHER')
    expect(screen.queryByText(FINGERPRINT)).toBeNull()
  })

  it('tells the admin to paste the key type and base64 without the hostname', async () => {
    const user = setup([keyed])
    await edit(user)
    // ssh-keyscan puts the hostname first; the backend rejects that line.
    expect(
      screen.getByText(/key type and the base64 key only.*without the hostname/)
    ).toBeInTheDocument()
  })

  it('cannot save with no role chosen', async () => {
    const user = setup([keyed])
    await edit(user)
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await user.click(screen.getByRole('checkbox', { name: 'admin' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('says when the list cannot be loaded', async () => {
    vi.mocked(api.listAcpProviders).mockRejectedValue(new Error('down'))
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <AcpProvidersPane />
      </QueryClientProvider>
    )
    expect(
      await screen.findByText('Could not load the providers.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add provider' })).toBeNull()
  })

  it('offers the Mk1 tools switch as disabled, marked Phase 2', async () => {
    const user = setup([keyed])
    await edit(user)
    expect(screen.getByRole('switch', { name: 'Mk1 tools' })).toBeDisabled()
    expect(screen.getByText('Phase 2')).toBeInTheDocument()
  })

  it('sends the whole form on save, ints as numbers, with no slug', async () => {
    const user = setup([keyed])
    vi.mocked(api.updateAcpProvider).mockResolvedValue({
      ...keyed,
      display_name: 'Jarvis Two',
      updated_at: '2026-11-03T10:05:00Z',
    })
    await edit(user)
    expect(screen.getByLabelText('Slug')).toBeDisabled()
    await fill(user, 'Display name', 'Jarvis Two')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateAcpProvider).toHaveBeenCalledTimes(1))
    expect(api.updateAcpProvider).toHaveBeenCalledWith(1, {
      display_name: 'Jarvis Two',
      enabled: false,
      ssh_host: 'bot.example.test',
      ssh_port: 22,
      ssh_user: 'fake-user',
      host_key: HOST_KEY,
      launcher_path: '/opt/fake/launch',
      authorized_from: '192.0.2.10',
      session_cwd: '/srv/fake/work',
      allowed_roles: ['admin'],
      max_sessions: 4,
      idle_minutes: 15,
      permission_timeout_s: 240,
      agent_approval_timeout_s: 300,
    })
    expect(await screen.findByText('Jarvis Two')).toBeInTheDocument()
    expect(screen.queryByLabelText('Display name')).toBeNull()
  })

  it('creates a provider with its slug and the defaults', async () => {
    const user = setup([])
    vi.mocked(api.createAcpProvider).mockResolvedValue({
      ...bare,
      id: 2,
      slug: 'newbot',
      display_name: 'New bot',
    })
    await user.click(
      await screen.findByRole('button', { name: 'Add provider' })
    )
    const save = screen.getByRole('button', { name: 'Create provider' })
    expect(save).toBeDisabled()
    await fill(user, 'Slug', 'newbot')
    await fill(user, 'Display name', 'New bot')
    await fill(user, 'SSH host', 'bot.example.test')
    await fill(user, 'SSH user', 'fake-user')
    await fill(user, 'Host key', HOST_KEY)
    await fill(user, 'Launcher path', '/opt/fake/launch')
    await fill(user, 'Authorized from', '192.0.2.10')
    await fill(user, 'Session directory', '/srv/fake/work')
    expect(save).toBeEnabled()
    // A new provider has no key yet, so it cannot be enabled.
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeDisabled()
    await user.click(save)
    await waitFor(() => expect(api.createAcpProvider).toHaveBeenCalledTimes(1))
    expect(api.createAcpProvider).toHaveBeenCalledWith({
      slug: 'newbot',
      display_name: 'New bot',
      enabled: false,
      ssh_host: 'bot.example.test',
      ssh_port: 22,
      ssh_user: 'fake-user',
      host_key: HOST_KEY,
      launcher_path: '/opt/fake/launch',
      authorized_from: '192.0.2.10',
      session_cwd: '/srv/fake/work',
      allowed_roles: ['admin'],
      max_sessions: 4,
      idle_minutes: 15,
      permission_timeout_s: 240,
      agent_approval_timeout_s: 300,
    })
    expect(await screen.findByText('New bot')).toBeInTheDocument()
  })

  it('blocks a save whose approval timeout is not below the agent timeout', async () => {
    const user = setup([keyed])
    await edit(user)
    await fill(user, 'Approval timeout (s)', '400')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(
      screen.getByText(/Approval timeout must be below the agent timeout/)
    ).toBeInTheDocument()
  })

  it('says what to do on a 409 not_ready save', async () => {
    const user = setup([
      { ...standardUntested, enabled: true, last_test_ok: true },
    ])
    vi.mocked(api.updateAcpProvider).mockRejectedValue(
      new CrmError(409, 'not_ready')
    )
    await edit(user)
    // The server refuses before writing: a passing test does not survive this edit.
    await fill(user, 'SSH host', 'other.example.test')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(NOT_READY)).toBeInTheDocument()
    // The form stays open for the fix.
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeChecked()
  })

  it('warns before Save that changing roles or connection settings cannot stay enabled', async () => {
    const user = setup([
      { ...standardUntested, enabled: true, last_test_ok: true },
    ])
    await edit(user)
    expect(screen.queryByText(RETEST_LOST)).toBeNull()
    await fill(user, 'SSH host', 'other.example.test')
    expect(screen.getByText(RETEST_LOST)).toBeInTheDocument()
    // Turning Enabled off is the way through, and the warning goes with it.
    await user.click(screen.getByRole('switch', { name: 'Enabled' }))
    expect(screen.queryByText(RETEST_LOST)).toBeNull()
  })

  it('does not warn for an admin-only provider', async () => {
    const user = setup([{ ...keyed, enabled: true, last_test_ok: true }])
    await edit(user)
    await fill(user, 'SSH host', 'other.example.test')
    expect(screen.queryByText(RETEST_LOST)).toBeNull()
  })

  it('does not warn when the change does not touch the test', async () => {
    const user = setup([
      { ...standardUntested, enabled: true, last_test_ok: true },
    ])
    await edit(user)
    await fill(user, 'Display name', 'Jarvis Two')
    await fill(user, 'Max sessions', '8')
    // "022" is the same port to the server, so it must not count as a change.
    await fill(user, 'SSH port', '022')
    expect(screen.queryByText(RETEST_LOST)).toBeNull()
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeChecked()
  })

  it.each([
    [new CrmError(422, 'invalid_input'), /A value was rejected/],
    [new CrmError(422, null), /Could not save\. Nothing was changed/],
    [new CrmError(503, 'keys_not_configured'), /Key storage is not set up/],
    [new CrmError(422, 'not_supported'), /Mk1 tools are not available/],
    [new CrmError(404, 'provider_not_found'), /no longer exists/],
  ])('maps a save error (%s)', async (error, text) => {
    const user = setup([keyed])
    vi.mocked(api.updateAcpProvider).mockRejectedValue(error)
    await edit(user)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('shows the error and stderr tail as plain text after a failed test', async () => {
    const user = setup([keyed])
    vi.mocked(api.testAcpProvider).mockResolvedValue(failedTest)
    await user.click(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    )
    const report = await screen.findByTestId('test-report')
    expect(report).toHaveTextContent('Could not connect.')
    const pre = within(report).getByText(/Permission denied \(publickey\)\./)
    expect(pre.tagName).toBe('PRE')
    // Agent-side text: shown literally, never parsed as markup.
    expect(pre).toHaveTextContent('<b>x</b>')
    expect(report.querySelector('b')).toBeNull()
  })

  it('shows that the test is running and blocks a second run', async () => {
    const user = setup([keyed])
    let finish: (r: AcpTestResult) => void = () => undefined
    vi.mocked(api.testAcpProvider).mockReturnValue(
      new Promise<AcpTestResult>(resolve => {
        finish = resolve
      })
    )
    const button = await screen.findByRole('button', {
      name: 'Test connection for Jarvis',
    })
    await user.click(button)
    expect(button).toBeDisabled()
    expect(await screen.findByRole('status')).toHaveTextContent(
      /Testing the connection.*two minutes/
    )
    finish(passedTest)
    expect(await screen.findByTestId('test-report')).toBeInTheDocument()
    expect(button).toBeEnabled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows timings, capabilities and tools after a passing test, leaving out null timings', async () => {
    const user = setup([keyed])
    vi.mocked(api.testAcpProvider).mockResolvedValue(passedTest)
    await user.click(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    )
    const report = await screen.findByTestId('test-report')
    expect(report).toHaveTextContent('fake-agent 9.9.9')
    expect(report).toHaveTextContent('Connect 812 ms')
    expect(report).toHaveTextContent('New session 430 ms')
    expect(report).toHaveTextContent('Tools 95 ms')
    expect(report).not.toHaveTextContent(/null/i)
    expect(report).not.toHaveTextContent(/initialize/i)
    expect(report).toHaveTextContent('loadSession')
    expect(report).toHaveTextContent('todo_list')
    expect(report).toHaveTextContent('mcp__mk1__find_sample')
  })

  it('refetches after a test, which is what unlocks Enabled for a standard-role provider', async () => {
    const user = setup([standardUntested])
    vi.mocked(api.testAcpProvider).mockResolvedValue(passedTest)
    vi.mocked(api.listAcpProviders).mockResolvedValue(
      list([
        {
          ...standardUntested,
          last_test_ok: true,
          last_test_at: '2026-11-03T10:30:00Z',
        },
      ])
    )
    // The form is closed while testing: the test runs on the saved settings.
    await user.click(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    )
    expect(await screen.findByText(/Last test passed/)).toBeInTheDocument()
    expect(await edit(user)).toBeEnabled()
  })

  it('shows the tool list and capabilities of a failed test, so every offender is visible at once', async () => {
    const user = setup([keyed])
    vi.mocked(api.testAcpProvider).mockResolvedValue({
      ...failedTest,
      error: 'The tool list includes terminal.',
      stderr_tail: null,
      capabilities: { loadSession: true },
      tools: ['terminal', 'read_file', 'todo_list'],
    })
    await user.click(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    )
    const report = await screen.findByTestId('test-report')
    expect(report).toHaveTextContent(
      'Test failed: The tool list includes terminal.'
    )
    expect(report).toHaveTextContent(
      'Tool list: terminal, read_file, todo_list'
    )
    expect(report).toHaveTextContent('Capabilities: loadSession')
  })

  it.each([
    [new CrmError(503, 'keys_not_configured'), /Key storage is not set up/],
    [new CrmError(404, 'provider_not_found'), /no longer exists/],
    [new TypeError('network'), /Could not run the test/],
  ])('reports a test that throws (%s)', async (error, text) => {
    const user = setup([keyed])
    vi.mocked(api.testAcpProvider).mockRejectedValue(error)
    await user.click(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    )
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByTestId('test-report')).toBeNull()
  })

  it('does not offer Test connection before there is a key', async () => {
    setup([bare])
    expect(
      await screen.findByRole('button', { name: 'Test connection for Jarvis' })
    ).toBeDisabled()
    expect(screen.getByText(/No key yet/)).toBeInTheDocument()
  })

  it('says key storage is missing and disables saving and Generate key', async () => {
    const user = setup([keyed], false)
    expect(
      await screen.findByText('Key storage is not set up on this server.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Generate key for Jarvis' })
    ).toBeDisabled()
    await edit(user)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('deletes after a confirm and drops the row', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = setup([keyed])
    vi.mocked(api.deleteAcpProvider).mockResolvedValue(undefined)
    await user.click(
      await screen.findByRole('button', { name: 'Delete Jarvis' })
    )
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.deleteAcpProvider).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.queryByText('Jarvis')).toBeNull())
  })

  it('does not delete when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = setup([keyed])
    await user.click(
      await screen.findByRole('button', { name: 'Delete Jarvis' })
    )
    expect(api.deleteAcpProvider).not.toHaveBeenCalled()
  })

  it('explains a provider that has chats cannot be deleted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = setup([keyed])
    vi.mocked(api.deleteAcpProvider).mockRejectedValue(
      new CrmError(409, 'provider_in_use')
    )
    await user.click(
      await screen.findByRole('button', { name: 'Delete Jarvis' })
    )
    expect(
      await screen.findByText(
        'This provider has chats, so it cannot be deleted. Disable it instead.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Jarvis')).toBeInTheDocument()
  })

  it('non-admins get no data and no nav item', async () => {
    auth.role = 'standard'
    setup([keyed])
    expect(await screen.findByText(/Only admins/)).toBeInTheDocument()
    expect(api.listAcpProviders).not.toHaveBeenCalled()
    expect(visibleNavItems(false).some(i => i.id === 'acpProviders')).toBe(
      false
    )
    expect(visibleNavItems(true).some(i => i.id === 'acpProviders')).toBe(true)
  })
})
