import { createApp } from 'vue'
import { IonicVue, IonIcon } from '@ionic/vue'
import './app.css'
import './controls.css'
import './auth-gate.css'
import '@ionic/vue/css/core.css'
import '@ionic/vue/css/normalize.css'
import '@ionic/vue/css/structure.css'
import '@ionic/vue/css/typography.css'
import './mobile.css'
import App from './App.vue'

createApp(App).use(IonicVue).component('ion-icon', IonIcon).mount('#app')
