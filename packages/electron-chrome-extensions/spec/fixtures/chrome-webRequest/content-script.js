/* eslint-disable */

function evalInMainWorld(fn) {
  const script = document.createElement('script')
  script.textContent = `((${fn})())`
  document.documentElement.appendChild(script)
}

function sendIpc(name, ...args) {
  const jsonArgs = [name, ...args].map((arg) => JSON.stringify(arg))
  const funcStr = `() => { electronTest.sendIpc(${jsonArgs.join(', ')}) }`
  evalInMainWorld(funcStr)
}

async function exec(action) {
  const result = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(action, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message)
      } else {
        resolve(result)
      }
    })
  })

  sendIpc('success', result)
}

window.addEventListener('message', (event) => {
  exec(event.data)
})

evalInMainWorld(() => {
  window.exec = (json) => window.postMessage(JSON.parse(json))
})
