import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real Electron IPC + decoder + private-file persistence. Collectable here; requires a GUI-capable host to execute.
test('local wallpaper normalization, chooser cancellation and appearance survive restart safely', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'examcraft-appearance-e2e-'))
  const source = join(userData, 'synthetic-original.png')
  const movedSource = join(userData, 'synthetic-original-moved.png')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNocDjwHwAFRAKAb2WvNQAAAABJRU5ErkJggg==',
    'base64',
  )
  await writeFile(source, png)
  let app: ElectronApplication | undefined
  async function launch() {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    delete env.ELECTRON_RUN_AS_NODE
    delete env.EXAMCRAFT_DEV_URL
    env.EXAMCRAFT_USER_DATA = userData
    app = await electron.launch({ args: ['.'], env })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await expect(page.getByRole('radio', { name: '深色 柔和暗色' })).toBeEnabled()
    return page
  }
  try {
    let page = await launch()
    await app!.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
    }, source)
    await page.getByRole('button', { name: '选择本地图片', exact: true }).click()
    await expect(page.getByTestId('workspace-wallpaper')).toHaveCount(1)
    await page.getByRole('radio', { name: '深色 柔和暗色' }).check()
    await page.getByRole('slider', { name: '壁纸不透明度' }).fill('23')
    await page.getByRole('combobox', { name: '壁纸填充方式' }).selectOption('tile')
    await expect(page.locator('#appearance-settings [role="status"]')).toContainText('外观已保存')
    const initial = await page.evaluate(() => window.examcraft!.getAppearance())
    expect(initial.preferences.theme).toBe('dark')
    expect(initial.wallpaper?.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(JSON.stringify(initial)).not.toContain(source)
    await app!.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    await page.getByRole('button', { name: '更换本地图片', exact: true }).click()
    await expect(page.locator('#appearance-settings [role="status"]')).toContainText('已取消选择')
    expect(await page.evaluate(() => window.examcraft!.getAppearance())).toEqual(initial)
    expect(await readFile(source)).toEqual(png)
    await rename(source, movedSource)
    await app!.close()
    app = undefined
    page = await launch()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('workspace-wallpaper')).toHaveCSS('opacity', '0.23')
    await expect(page.getByTestId('workspace-wallpaper')).toHaveCSS('background-repeat', 'repeat')
    expect(await page.evaluate(() => window.examcraft!.getAppearance())).toEqual(initial)
    await page.getByRole('button', { name: '恢复默认外观', exact: true }).click()
    await expect(page.getByTestId('workspace-wallpaper')).toHaveCount(0)
    await expect(page.locator('#appearance-settings [role="status"]')).toContainText('已恢复默认')
    expect(await readdir(join(userData, 'appearance'))).toEqual(['preferences.json'])
    expect(await readFile(movedSource)).toEqual(png)
  } finally {
    await app?.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
