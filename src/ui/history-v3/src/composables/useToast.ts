import { ref } from 'vue'

export interface ToastMessage {
  id: number
  text: string
  type: 'info' | 'success' | 'error'
}

let nextId = 0
const messages = ref<ToastMessage[]>([])

export function useToast() {
  function show(text: string, type: 'info' | 'success' | 'error' = 'info', duration = 3000) {
    const id = nextId++
    messages.value.push({ id, text, type })
    setTimeout(() => {
      messages.value = messages.value.filter(m => m.id !== id)
    }, duration)
  }

  return { messages, show }
}
