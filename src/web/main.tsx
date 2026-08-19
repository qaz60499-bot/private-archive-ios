import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles/main.css'
import { wakeUploadScheduler } from './lib/offline/processor'

registerSW({ immediate: true })
window.addEventListener('online', () => void wakeUploadScheduler('online'))
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void wakeUploadScheduler('visible') })
void wakeUploadScheduler('startup')

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
