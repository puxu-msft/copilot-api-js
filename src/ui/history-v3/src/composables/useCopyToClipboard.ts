import { useToast } from './useToast'

export function useCopyToClipboard() {
  const { show } = useToast()

  async function copy(text: string, label = 'Copied!') {
    try {
      await navigator.clipboard.writeText(text)
      show(label, 'success')
    } catch {
      show('Copy failed', 'error')
    }
  }

  return { copy }
}
