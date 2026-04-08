import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import MonitorPage from './MonitorPage'
import './styles.css'

const isMonitorRoute = window.location.pathname === '/monitor'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isMonitorRoute ? <MonitorPage /> : <App />}
  </React.StrictMode>,
)
