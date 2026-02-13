/** Fallback VSCode version when GitHub API is unavailable */
const FALLBACK = "1.104.3"

/** GitHub API endpoint for latest VSCode release */
const GITHUB_API_URL = "https://api.github.com/repos/microsoft/vscode/releases/latest"

/** GitHub release response shape */
interface GitHubRelease {
  tag_name: string
}

/** Fetch the latest VSCode version from GitHub releases, falling back to a hardcoded version */
export async function getVSCodeVersion() {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(GITHUB_API_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "copilot-api",
      },
    })

    if (!response.ok) {
      return FALLBACK
    }

    const release = (await response.json()) as GitHubRelease
    // tag_name is in format "1.107.1"
    const version = release.tag_name
    if (version && /^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }

    return FALLBACK
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timeout)
  }
}
