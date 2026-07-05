/* global chrome */

const log = []
const registrations = []

const record = (listenerId) => (details) => {
  log.push({ listenerId, details })
}

const listen = (event, listenerId, filter, extraInfoSpec) => {
  const callback = record(listenerId)
  event.addListener(callback, filter, extraInfoSpec)
  registrations.push([event, callback])
}

listen(chrome.webRequest.onBeforeRequest, 'onBeforeRequest', { urls: ['<all_urls>'] })

// Should never fire for URLs served by the spec's HTTP server.
listen(chrome.webRequest.onBeforeRequest, 'onBeforeRequestFiltered', {
  urls: ['*://no-match.invalid/*'],
})

listen(chrome.webRequest.onSendHeaders, 'onSendHeaders', { urls: ['<all_urls>'] }, [
  'requestHeaders',
])

listen(chrome.webRequest.onCompleted, 'onCompleted', { urls: ['<all_urls>'] })

listen(chrome.webRequest.onCompleted, 'onCompletedWithHeaders', { urls: ['<all_urls>'] }, [
  'responseHeaders',
])

// Never emits, but must not throw on registration.
listen(chrome.webRequest.onAuthRequired, 'onAuthRequired')

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  switch (message && message.type) {
    case 'get-webrequest-log':
      reply(log)
      break

    case 'remove-webrequest-listeners':
      registrations.forEach(([event, callback]) => {
        event.removeListener(callback)
      })
      reply(true)
      break
  }

  // Respond asynchronously
  return true
})

console.log('background-script-evaluated')
