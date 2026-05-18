import { contextBridge } from 'electron'

// Typed bridge between renderer and main. IPC methods go here.
contextBridge.exposeInMainWorld('api', {
  // placeholder — populated in spike 1
})
