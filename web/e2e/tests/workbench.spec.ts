import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * The browser acceptance: a conversation, turn control and the side panel, end
 * to end through the UI.
 *
 * Every spec goes through the UI the way a person does — no seeding through the
 * API, because the thing under test *is* the SPA↔backend wire and seeding
 * around it is how that wire stops being tested. The one exception is the
 * directory a project points at, which is a real path on the machine and has to
 * exist before the form can name it.
 *
 * Isolation is per project (the config runs these in parallel against one
 * backend): every spec makes its own directory and its own project, so no two
 * share a workspace, a session list, or a `report.md`.
 *
 * The backend runs the offline mock provider, whose opening demo chain is
 * `AskUserQuestion -> [skill] -> Write(report.md) -> end_turn`. The skill step
 * appears only when the workspace actually carries a `SKILL.md`, so these specs
 * assert the question / write / answer chain and leave skills to the Python
 * suite.
 *
 * **The pending question is the busy state these specs use.** The mock answers
 * in milliseconds, so there is no reliable window in which to catch a turn
 * mid-flight from a browser; a turn parked on a question is busy for as long as
 * nobody answers it, which is exactly the state Stop and Send are defined
 * against.
 */

/** Where this run's throwaway project directories live. */
const WORKDIR = path.join(os.tmpdir(), 'noeta-e2e-projects')

function freshDirectory(name: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const directory = path.join(WORKDIR, `${name}-${unique}`)
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

/** The composer's editor. A Lexical contentEditable, not a textarea. */
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' })

/** The sidebar — the app's one complementary landmark. */
const sidebar = (page: Page) => page.getByRole('complementary').first()

const runButton = (page: Page) => page.getByRole('button', { name: 'Run', exact: true })

/**
 * Reveal a turn's steps.
 *
 * The work is no longer behind a process fold — the step rows show on the
 * turn's rail directly under the message. This is kept as a no-op-when-absent
 * helper so its call sites read as "make the steps visible" regardless of the
 * chrome; if a collapsed process toggle is ever present it is clicked, and if
 * not (the current design) the steps are already on screen.
 */
async function openProcess(scope: Locator): Promise<void> {
  const toggle = scope
    .getByRole('button', { name: /step|Worked|Working/ })
    .first()
  if (await toggle.count()) await toggle.click()
}

/**
 * Create a project through the form and land on its empty session surface.
 *
 * The project id is read back off the URL rather than out of a response: the
 * URL is the authority in this product (D9), so it is also the honest place to
 * learn what was created.
 */
async function createProject(page: Page, name: string): Promise<{ id: string; directory: string }> {
  const directory = freshDirectory(name)
  await page.goto('/')

  // With projects already present the form is behind a button; on an empty
  // backend it is open already.
  const newProject = page.getByRole('button', { name: 'New project' })
  if (await newProject.isVisible().catch(() => false)) await newProject.click()

  await page.getByRole('textbox', { name: 'Name' }).fill(name)
  await page.getByRole('textbox', { name: 'Directory' }).fill(directory)
  await page.getByRole('button', { name: 'Create project' }).click()

  await page.waitForURL(/\/project\/[0-9a-f]{32}\/session$/)
  return { id: page.url().match(/\/project\/([0-9a-f]{32})\//)![1], directory }
}

/** Send the first message of a session; returns the new session id. */
async function openSessionWith(page: Page, text: string): Promise<string> {
  await composer(page).fill(text)
  await runButton(page).click()
  await page.waitForURL(/\/project\/[0-9a-f]{32}\/session\/[0-9a-f]{32}$/)
  return page.url().match(/\/session\/([0-9a-f]{32})$/)![1]
}

/** Answer the mock's opening clarifying question. */
async function answerTheQuestion(page: Page) {
  const question = page.getByTestId('question-panel')
  await expect(question).toBeVisible()
  await question.getByRole('radio').first().click()
  await question.getByRole('button', { name: 'Answer' }).click()
  await expect(question).toHaveCount(0)
}

test('a project, a session, a message, and the answer streaming back', async ({ page }) => {
  const project = await createProject(page, 'streams')

  // The composer doubles as the create-a-session surface: there is no session
  // in the URL yet, and sending one message makes both.
  await expect(composer(page)).toHaveAttribute('aria-placeholder', 'Start a new session…')
  const sessionId = await openSessionWith(page, 'hello from the browser')

  const transcript = page.getByTestId('transcript')
  await expect(transcript.getByText('hello from the browser')).toBeVisible()

  // The mock opens with a clarifying question. Answering it runs the rest of
  // the chain, which writes a file into the project directory.
  await answerTheQuestion(page)
  await expect(transcript.getByText(/report is written to/)).toBeVisible()

  // A `local` project writes into its own directory — the acceptance criterion,
  // checked on the real filesystem rather than through the file endpoint.
  await expect
    .poll(() => fs.existsSync(path.join(project.directory, 'report.md')), { timeout: 15_000 })
    .toBe(true)

  // The first message titles the session, so the sidebar is readable instead of
  // a column of identical rows.
  await expect(sidebar(page).getByRole('link', { name: 'hello from the browser' })).toBeVisible()

  // The same session then takes another turn.
  await composer(page).fill('and one more thing')
  await runButton(page).click()
  await expect(transcript.getByText('and one more thing')).toBeVisible()
  await expect(transcript.getByText(/\(mock\) Received your message/)).toBeVisible()
  expect(page.url()).toContain(`/session/${sessionId}`)
})

test('a hard refresh on the deep link restores the conversation', async ({ page }) => {
  // D9's acceptance criterion, and nothing else in the suite exercises a cold
  // load of a deep link. The conversation has to come back by *re-derivation*
  // from the event log: no client state survives a reload.
  await createProject(page, 'refresh')
  await openSessionWith(page, 'remember the reload case')

  const transcript = page.getByTestId('transcript')
  await expect(transcript.getByText('remember the reload case')).toBeVisible()
  // The agent's work (the memory step included) shows on the turn's rail; the
  // helper is a no-op now that nothing folds it away.
  await openProcess(transcript)
  await expect(transcript.getByText(/Remembered \(mock\)/)).toBeVisible()

  const deepLink = page.url()
  await page.reload()

  await expect(page).toHaveURL(deepLink)
  const reloaded = page.getByTestId('transcript')
  await expect(reloaded.getByText('remember the reload case')).toBeVisible()
  await openProcess(reloaded)
  await expect(reloaded.getByText(/Remembered \(mock\)/)).toBeVisible()
  // The memory step is a durable frame, so the step row comes back too — not
  // just the prose either side of it.
  await expect(reloaded.locator('[data-item-kind="memory"]')).toBeVisible()
  // Usable after the reload, not merely readable.
  await expect(composer(page)).toBeEnabled()
})

test('an unknown session keeps the sidebar and does not rewrite the URL', async ({ page }) => {
  const project = await createProject(page, 'notfound')
  const deadLink = `/project/${project.id}/session/${'0'.repeat(32)}`

  await page.goto(deadLink)

  await expect(page.getByText('Session not found')).toBeVisible()
  // A stale link says what happened instead of being silently repaired.
  await expect(page).toHaveURL(new RegExp(`${deadLink}$`))
  // The sidebar stays mounted, so the user is not stranded on a dead page.
  await expect(sidebar(page).getByRole('button', { name: 'New session' })).toBeVisible()
})

test('Stop withdraws a pending question and the same session carries on', async ({ page }) => {
  await createProject(page, 'stop')
  const sessionId = await openSessionWith(page, 'start something long')

  // Busy: the single Run pill is gone, replaced by an outline Stop beside a
  // primary Send that steers the running turn.
  await expect(runButton(page)).toHaveCount(0)
  // `exact`: the project here is named "stop", and the sidebar switcher names
  // the open project in its accessible label ("Project: stop…"), so a loose
  // match would resolve to two buttons. The Send lookup below is exact for the
  // same reason.
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()

  // 0.6.2: Stop on a turn parked on a question WITHDRAWS the question (the
  // "Esc" landing) instead of doing nothing. The panel clears and the session
  // returns to idle without a model turn.
  const interrupted = page.waitForResponse(
    (response) => response.url().includes('/interrupt') && response.request().method() === 'POST',
  )
  await stop.click()
  expect((await interrupted).status()).toBe(202)

  // The docked question panel is gone, and the transcript keeps the card as a
  // trace marked cancelled — the prior turn's output stays in history.
  await expect(page.getByTestId('question-panel')).toHaveCount(0)
  const transcript = page.getByTestId('transcript')
  await expect(transcript.getByText('Cancelled')).toBeVisible()

  // The SAME session accepts the next message — that is what makes Stop
  // different from Cancel.
  await expect(runButton(page)).toBeVisible()
  await composer(page).fill('carry on then')
  await runButton(page).click()
  await expect(transcript.getByText('carry on then')).toBeVisible()
  await expect(transcript.getByText(/\(mock\) Received your message/)).toBeVisible()
  expect(page.url()).toContain(`/session/${sessionId}`)
})

test('editing a message forks into a child session with the shared history', async ({ page }) => {
  await createProject(page, 'fork')
  const parentId = await openSessionWith(page, 'the opening message')
  await answerTheQuestion(page)

  const transcript = page.getByTestId('transcript')
  await expect(transcript.getByText(/report is written to/)).toBeVisible()

  // The engine refuses to branch at the *opening* message — there is no prior
  // turn to inherit — so the affordance is offered only from the second one on,
  // and this is where that rule is visible.
  await composer(page).fill('second thoughts')
  await runButton(page).click()
  // Exact: the mock's reply quotes the message back, so a loose match finds two.
  await expect(transcript.getByText('second thoughts', { exact: true })).toBeVisible()
  await expect(transcript.getByText(/\(mock\) Received your message/)).toBeVisible()

  const editAndRetry = page.getByRole('button', { name: 'Edit & retry' })
  await expect(editAndRetry).toHaveCount(1)
  await editAndRetry.click()
  await page.getByRole('textbox', { name: 'Edit message' }).fill('actually, try it this way')
  await page.getByRole('button', { name: 'Fork & send' }).click()

  // A fork is its OWN session now — the URL moves to a new session id.
  await page.waitForURL(
    (url) => /\/session\/[0-9a-f]{32}$/.test(url.pathname) && !url.pathname.endsWith(parentId),
  )
  const childId = page.url().match(/\/session\/([0-9a-f]{32})$/)![1]
  expect(childId).not.toBe(parentId)

  // The child carries the shared prefix (the opening message and the second
  // one), then the edit — never the message it replaced.
  await expect(transcript.getByText('the opening message', { exact: true })).toBeVisible()
  await expect(transcript.getByText('actually, try it this way', { exact: true })).toBeVisible()
  await expect(transcript.getByText('second thoughts', { exact: true })).toHaveCount(0)
  // And it says the workspace is shared with its source.
  await expect(page.getByText(/shares the project directory/i)).toBeVisible()

  // The original session is untouched and still in the sidebar, with the fork
  // nested under it as "… (fork)". Opening the parent by its own row (matched on
  // its session id, since two rows now share the title stem) shows what was
  // actually sent there, not the edit.
  await sidebar(page).locator(`a[href$="/session/${parentId}"]`).click()
  await page.waitForURL(new RegExp(`/session/${parentId}$`))
  await expect(transcript.getByText('second thoughts', { exact: true })).toBeVisible()
  await expect(transcript.getByText('actually, try it this way', { exact: true })).toHaveCount(0)
})

test('undoing the last turn re-bases the session in place', async ({ page }) => {
  await createProject(page, 'undo')
  const sessionId = await openSessionWith(page, 'the opening message')
  await answerTheQuestion(page)

  const transcript = page.getByTestId('transcript')
  await expect(transcript.getByText(/report is written to/)).toBeVisible()

  // A second turn, which is the one we will undo.
  await composer(page).fill('a second turn to throw away')
  await runButton(page).click()
  await expect(transcript.getByText('a second turn to throw away', { exact: true })).toBeVisible()
  await expect(transcript.getByText(/\(mock\) Received your message/)).toBeVisible()

  // Undo is offered on the latest message only, and states the file-rollback
  // risk before it runs — the mirror of the fork note.
  const undo = page.getByRole('button', { name: 'Undo last turn' })
  await expect(undo).toHaveCount(1)
  await undo.click()
  await expect(page.getByText(/restores the project files/i)).toBeVisible()
  await page.getByRole('button', { name: 'Undo & restore files' }).click()

  // No navigation — undo re-bases in place, so the URL stays on this session.
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`))
  // The second turn is gone; the first survives. The transcript truncated on
  // the `rewind` SSE frame, end to end through the wire.
  await expect(transcript.getByText('a second turn to throw away', { exact: true })).toHaveCount(0)
  await expect(transcript.getByText(/\(mock\) Received your message/)).toHaveCount(0)
  await expect(transcript.getByText('the opening message', { exact: true })).toBeVisible()

  // The session lands live again: a following message drives a fresh turn on
  // the same stream rather than being refused.
  await composer(page).fill('carry on after the undo')
  await runButton(page).click()
  await expect(transcript.getByText('carry on after the undo', { exact: true })).toBeVisible()
})

test('the side panel derives the file the agent wrote and opens it', async ({ page }) => {
  await createProject(page, 'panel')
  await openSessionWith(page, 'produce something to look at')
  await answerTheQuestion(page)

  const transcript = page.getByTestId('transcript')
  await expect(transcript.getByText(/report is written to/)).toBeVisible()

  // Nothing auto-opens: a human always clicks (D12).
  await expect(page.getByRole('button', { name: 'Close panel' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Files & preview' }).click()

  // One file view — tree on the left, preview on the right. Nothing is selected
  // yet, so the preview prompts for a pick.
  const dock = page.getByTestId('panel-dock')
  await expect(dock.getByText('Select a file to preview it.')).toBeVisible()

  // The derivation engine guesses `report.md` off the write tool's own metadata,
  // and the server resolve is what makes it collectible — surfaced in the
  // artifacts menu. Opening it there selects it in the tree.
  await dock.getByRole('button', { name: /artifact/ }).click()
  const artifact = dock.getByRole('menuitem', { name: /report\.md/ }).first()
  await expect(artifact).toBeVisible({ timeout: 15_000 })
  await artifact.click()

  // Selected, and showing the bytes the backend actually holds. The panel is a
  // read surface — no Edit affordance beneath it (file-preview is read-only).
  await expect(dock.getByRole('heading', { name: 'Structured report (mock demo)' })).toBeVisible()

  // And it closes again, because the panel is the user's to dismiss.
  await page.getByRole('button', { name: 'Hide files' }).click()
  await expect(page.getByRole('button', { name: 'Files & preview' })).toBeVisible()
})
