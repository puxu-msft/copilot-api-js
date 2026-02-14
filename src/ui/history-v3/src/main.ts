import { createApp } from "vue"

import App from "./App.vue"
import "./styles/reset.css"
import "./styles/variables.css"
import "./styles/base.css"
import "./styles/scrollbar.css"
import "./styles/transitions.css"
import "./styles/diff2html-overrides.css"

const app = createApp(App)
app.mount("#app")
