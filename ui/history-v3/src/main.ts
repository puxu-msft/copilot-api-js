import { createApp } from "vue"

import App from "./App.vue"
import { vuetify } from "./plugins/vuetify"
import router from "./router"
// Vuetify styles load first (via plugin), then project styles.
// Project reset.css is scoped to NOT affect Vuetify components — see reset.css.
import "./styles/reset.css"
import "./styles/variables.css"
import "./styles/base.css"
import "./styles/scrollbar.css"
import "./styles/transitions.css"
import "./styles/diff2html-overrides.css"
import "./styles/json-viewer.css"

const app = createApp(App)
app.use(vuetify)
app.use(router)
app.mount("#app")
