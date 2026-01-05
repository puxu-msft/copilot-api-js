import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const APP_DIR = path.join(os.homedir(), ".local", "share", "copilot-api")

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
    // File exists, ensure it has secure permissions (owner read/write only)
    const stats = await fs.stat(filePath)
    const currentMode = stats.mode & 0o777
    if (currentMode !== 0o600) {
      await fs.chmod(filePath, 0o600)
    }
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
