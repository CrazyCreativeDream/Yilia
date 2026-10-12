// Paste into the Windows client's renderer DevTools Console BEFORE connecting.
(() => {
  if (window.yiliaBleCapture) throw new Error('BLE capture already installed')
  const records = []
  const restores = []
  const hex = (data) => {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
  }
  const record = (kind, detail) => {
    const entry = { at: new Date().toISOString(), kind, ...detail }
    records.push(entry)
    console.log('[yilia BLE capture]', entry)
  }
  const proto = BluetoothRemoteGATTCharacteristic.prototype
  for (const method of ['writeValue', 'writeValueWithResponse', 'writeValueWithoutResponse', 'readValue', 'startNotifications']) {
    const original = proto[method]
    if (!original) continue
    proto[method] = async function (...args) {
      const detail = { method, uuid: this.uuid, service: this.service?.uuid }
      if (method.startsWith('write')) detail.hex = hex(args[0])
      record('call', detail)
      try {
        const result = await original.apply(this, args)
        record('success', { ...detail, ...(method === 'readValue' ? { hex: hex(result) } : {}) })
        return result
      } catch (error) {
        record('error', { ...detail, name: error.name, message: error.message })
        throw error
      }
    }
    restores.push(() => { proto[method] = original })
  }
  const listen = (name, handler) => {
    window.addEventListener(name, handler)
    restores.push(() => window.removeEventListener(name, handler))
  }
  listen('dokidoki:notify', (e) => record('notify', { hex: hex(e.detail) }))
  listen('dokidoki:command', (e) => record('action', e.detail))
  listen('dokidoki:diagnostic', (e) => record('diagnostic', e.detail))
  window.yiliaBleCapture = {
    records,
    mark(note) { record('observation', { note }) },
    save() {
      const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'yilia-windows-ble.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    stop() {
      restores.reverse().forEach((restore) => restore())
      delete window.yiliaBleCapture
      return records
    },
  }
  record('capture-started', {})
  console.log('连接并控制设备；用 yiliaBleCapture.mark("设备实际动作描述") 标记，最后 yiliaBleCapture.save() 导出。')
})()
