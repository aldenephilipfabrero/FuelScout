import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('ion-') } } })],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
