export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public bodyText: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** 注入 fetch 便于测试；默认用全局 fetch。 */
export function createApi(fetchImpl: typeof fetch = fetch) {
  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetchImpl(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "Unknown error")
      throw new ApiError(res.status, `${res.status}: ${body}`, body)
    }
    return res.json() as Promise<T>
  }
  return {
    get: <T>(path: string) => request<T>(path),
    delete: async (path: string): Promise<void> => {
      await request<unknown>(path, { method: "DELETE" })
    },
  }
}

export const api = createApi()
