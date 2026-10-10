import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication | undefined
let directory: string
async function launch() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.EXAMCRAFT_USER_DATA = directory
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  delete env.DEEPSEEK_API_KEY
  app = await electron.launch({ args: ['.'], env })
  // Synthetic public responses only. Nothing is sent to GitHub during this test.
  await app.evaluate(() => {
    globalThis.fetch = async (url) => {
      const address = String(url)
      if (address === 'https://api.github.com/users/missing')
        return new Response('', { status: 404 })
      if (address === 'https://api.github.com/users/limited')
        return new Response('', { status: 429 })
      if (address === 'https://api.github.com/users/offline')
        throw new TypeError('Synthetic offline')
      if (address === 'https://api.github.com/users/octocat')
        return new Response(
          JSON.stringify({
            login: 'octocat',
            name: 'Fixture Octocat',
            avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
          }),
        )
      if (address === 'https://api.github.com/users/fixture-next')
        return new Response(JSON.stringify({ login: 'fixture-next', name: null }))
      if (address === 'https://avatars.githubusercontent.com/u/1?s=128')
        return new Response(
          Uint8Array.from(
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
              'base64',
            ),
          ),
        )
      throw new Error(`Unexpected network request: ${address}`)
    }
  })
  const page = await app.firstWindow()
  await expect(page.getByLabel('GitHub 公开资料展示')).toBeVisible()
  return page
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-github-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('public avatar/name association, errors, cancel, persistence, change and unbind', async () => {
  let page = await launch()
  let profile = page.getByLabel('GitHub 公开资料展示')
  await profile.getByRole('button', { name: '关联', exact: true }).click()
  await expect(profile).toContainText('不验证账号归属')
  await profile.getByRole('button', { name: '取消', exact: true }).click()
  await expect(profile.getByLabel('GitHub 用户名')).toHaveCount(0)
  await profile.getByRole('button', { name: '关联', exact: true }).click()
  await profile.getByLabel('GitHub 用户名').press('Escape')
  await expect(profile.getByLabel('GitHub 用户名')).toHaveCount(0)
  await expect(profile.getByRole('button', { name: '关联', exact: true })).toBeFocused()
  await profile.getByRole('button', { name: '关联', exact: true }).click()
  for (const [username, message] of [
    ['missing', '未找到'],
    ['limited', '暂时受限'],
    ['offline', '检查网络'],
  ]) {
    await profile.getByLabel('GitHub 用户名').fill(username)
    await profile.getByRole('button', { name: '保存展示', exact: true }).click()
    await expect(profile.getByRole('alert')).toContainText(message)
  }
  await profile.getByLabel('GitHub 用户名').fill('octocat')
  await profile.getByRole('button', { name: '保存展示', exact: true }).click()
  await expect(profile).toContainText('Fixture Octocat')
  await expect(profile).toContainText('@octocat · 未验证归属')
  await expect(profile.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await app!.close()
  app = undefined
  page = await launch()
  profile = page.getByLabel('GitHub 公开资料展示')
  await expect(profile).toContainText('Fixture Octocat')
  await profile.getByRole('button', { name: '更换', exact: true }).click()
  await expect(profile.getByLabel('GitHub 用户名')).toHaveValue('octocat')
  await profile.getByLabel('GitHub 用户名').fill('fixture-next')
  await profile.getByRole('button', { name: '保存展示', exact: true }).click()
  await expect(profile).toContainText('@fixture-next')
  await expect(profile.locator('img')).toHaveCount(0)
  await profile.getByRole('button', { name: '解除', exact: true }).click()
  await expect(profile.getByRole('button', { name: '关联', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.examcraft!.getGitHubProfile())).toBeNull()
})
