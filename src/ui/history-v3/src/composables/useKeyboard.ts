import { onMounted, onUnmounted } from "vue"

export interface KeyboardOptions {
  onNavigate: (direction: "next" | "prev") => void
  onSearch: () => void
  onEscape: () => void
}

export function useKeyboard(options: KeyboardOptions) {
  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement
    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"

    if (isInput) {
      // Only Escape works in input fields
      if (e.key === "Escape") {
        ;(target as HTMLInputElement).blur()
        options.onEscape()
      }
      return
    }

    switch (e.key) {
      case "ArrowUp":
      case "k": {
        e.preventDefault()
        options.onNavigate("prev")
        break
      }
      case "ArrowDown":
      case "j": {
        e.preventDefault()
        options.onNavigate("next")
        break
      }
      case "/": {
        e.preventDefault()
        options.onSearch()
        break
      }
      case "Escape": {
        // Don't clear selection if a modal is open (BaseModal handles its own Esc)
        if (!document.querySelector(".modal-overlay")) {
          options.onEscape()
        }
        break
      }
      default: {
        break
      }
    }
  }

  onMounted(() => {
    document.addEventListener("keydown", handleKeydown)
  })

  onUnmounted(() => {
    document.removeEventListener("keydown", handleKeydown)
  })
}
