import { expect, test } from '@playwright/test'

/**
 * The cold start, against a backend that has never held any data.
 *
 * This is its own Playwright project (`first-run`) and every other spec
 * depends on it, because "no projects yet" is a property of the *backend* and
 * the rest of the suite creates projects in parallel. Ordering it first is the
 * only way the empty state is observable at all; asserting it opportunistically
 * would pass or fail on worker scheduling.
 */

test('opens straight into project creation, with no sign-in of any kind', async ({ page }) => {
  await page.goto('/')

  // With nothing to pick, the create surface is already open — not a modal, and
  // not behind a button.
  await expect(page.locator('h1')).toHaveText('Projects')
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Directory' })).toBeVisible()

  // Single-user and local: nothing may ask who you are.
  await expect(page.getByLabel(/password/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign in|log in|sign up/i })).toHaveCount(0)
  await expect(page.getByText(/sign in|log in/i)).toHaveCount(0)

  // The local tier states plainly what it may do to this machine. That is an
  // acceptance criterion of the rewrite, not decoration.
  await expect(page.getByText(/no container isolation/)).toBeVisible()
  await expect(page.getByText(/shell commands are not/)).toBeVisible()

  // And the sidebar is honest about there being nothing yet.
  await expect(page.getByRole('complementary').getByText('No projects yet.')).toBeVisible()
})
