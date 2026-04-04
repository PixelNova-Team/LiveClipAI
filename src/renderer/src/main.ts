import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/styles/global.css'
import './assets/styles/element-overrides.css'
import './composables/useTheme' // apply saved theme immediately
import App from './App.vue'
import router from './router'
import i18n from './i18n'

const app = createApp(App)

app.use(ElementPlus)
app.use(i18n)
app.use(router)

// Wait for router to be ready, then navigate to dashboard
router.isReady().then(() => {
  // Navigate to dashboard on startup
  router.push('/dashboard')
  app.mount('#app')
})
