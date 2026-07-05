import * as path from 'node:path'
import { expect } from 'chai'
import { ipcMain } from 'electron'

import { ElectronChromeExtensions } from '../'
import { emittedOnce } from './events-helpers'
import { createCrxSession, waitForBackgroundScriptEvaluated } from './crx-helpers'
import { useExtensionBrowser, useServer } from './hooks'

interface WebRequestLogEntry {
  listenerId: string
  details: any
}

interface SessionListenerCall {
  event: string
  listener: string
}

const SESSION_WEB_REQUEST_EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred',
]

/** session.webRequest events used by the chrome-webRequest fixture, sorted. */
const FIXTURE_ATTACHED_EVENTS = ['onBeforeRequest', 'onCompleted', 'onSendHeaders']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntil = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return
    await sleep(100)
  }
  throw new Error('Timed out waiting for condition')
}

/** Records (de)registration of session.webRequest listeners. */
const observeSessionWebRequest = (session: Electron.Session) => {
  const calls: SessionListenerCall[] = []
  const webRequest: any = session.webRequest
  for (const event of SESSION_WEB_REQUEST_EVENTS) {
    const original = webRequest[event].bind(webRequest)
    webRequest[event] = (listener: any) => {
      calls.push({ event, listener: listener === null ? 'null' : typeof listener })
      return original(listener)
    }
  }
  return calls
}

describe('chrome.webRequest', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'chrome-webRequest' })

  const sendToBackground = async (message: { type: string }) => {
    const p = emittedOnce(ipcMain, 'success')
    await browser.webContents.executeJavaScript(`exec('${JSON.stringify(message)}')`)
    const [, result] = await p
    return result
  }

  const getLog = (): Promise<WebRequestLogEntry[]> =>
    sendToBackground({ type: 'get-webrequest-log' })

  const waitForLog = async (predicate: (log: WebRequestLogEntry[]) => boolean) => {
    let log: WebRequestLogEntry[] = []
    for (let attempt = 0; attempt < 30; attempt++) {
      log = await getLog()
      if (predicate(log)) return log
      await sleep(100)
    }
    throw new Error(`Timed out waiting for webRequest log. Received: ${JSON.stringify(log)}`)
  }

  const findEntry = (log: WebRequestLogEntry[], listenerId: string, url: string) =>
    log.find((entry) => entry.listenerId === listenerId && entry.details.url === url)

  it('emits onBeforeRequest and onCompleted for page loads', async () => {
    const url = server.getUrl()
    const log = await waitForLog(
      (log) => !!findEntry(log, 'onBeforeRequest', url) && !!findEntry(log, 'onCompleted', url),
    )

    const beforeRequest = findEntry(log, 'onBeforeRequest', url)!.details
    expect(beforeRequest.url).to.equal(url)
    expect(beforeRequest.method).to.equal('GET')
    expect(beforeRequest.type).to.equal('main_frame')
    expect(beforeRequest.tabId).to.equal(browser.webContents.id)
    expect(beforeRequest.frameId).to.equal(0)
    expect(beforeRequest.parentFrameId).to.equal(-1)
    expect(beforeRequest.requestId).to.be.a('string')
    expect(beforeRequest.timeStamp).to.be.a('number')

    const completed = findEntry(log, 'onCompleted', url)!.details
    expect(completed.statusCode).to.equal(200)
    expect(completed.requestId).to.equal(beforeRequest.requestId)
  })

  it('emits events for subresource requests', async () => {
    const url = `${server.getUrl()}sub-resource`
    await browser.webContents.executeJavaScript(`void fetch('${url}')`)

    const log = await waitForLog((log) => !!findEntry(log, 'onBeforeRequest', url))

    const beforeRequest = findEntry(log, 'onBeforeRequest', url)!.details
    expect(beforeRequest.type).to.equal('xmlhttprequest')
    expect(beforeRequest.method).to.equal('GET')
    expect(beforeRequest.tabId).to.equal(browser.webContents.id)
  })

  it('does not emit events for URLs excluded by the listener filter', async () => {
    const url = server.getUrl()
    const log = await waitForLog((log) => !!findEntry(log, 'onCompleted', url))

    const filteredEntries = log.filter((entry) => entry.listenerId === 'onBeforeRequestFiltered')
    expect(filteredEntries).to.be.empty
  })

  it('includes headers only when requested by extraInfoSpec', async () => {
    const url = server.getUrl()
    const log = await waitForLog(
      (log) =>
        !!findEntry(log, 'onCompleted', url) &&
        !!findEntry(log, 'onCompletedWithHeaders', url) &&
        !!findEntry(log, 'onSendHeaders', url),
    )

    const completed = findEntry(log, 'onCompleted', url)!.details
    expect(completed.responseHeaders).to.be.undefined

    const completedWithHeaders = findEntry(log, 'onCompletedWithHeaders', url)!.details
    expect(completedWithHeaders.responseHeaders).to.be.an('array')
    const contentType = completedWithHeaders.responseHeaders.find(
      (header: any) => header.name.toLowerCase() === 'content-type',
    )
    expect(contentType?.value).to.equal('text/html')

    const sendHeaders = findEntry(log, 'onSendHeaders', url)!.details
    expect(sendHeaders.requestHeaders).to.be.an('array')
    expect(sendHeaders.requestHeaders[0].name).to.be.a('string')
    expect(sendHeaders.requestHeaders[0].value).to.be.a('string')
  })

  it('detaches session listeners when extension listeners are removed', async () => {
    const calls = observeSessionWebRequest(browser.session)

    await sendToBackground({ type: 'remove-webrequest-listeners' })

    await waitUntil(() => calls.length >= FIXTURE_ATTACHED_EVENTS.length)
    expect(calls.map((call) => call.event).sort()).to.deep.equal(FIXTURE_ATTACHED_EVENTS)
    expect(calls.every((call) => call.listener === 'null')).to.be.true
  })
})

describe('chrome.webRequest session listener attachment', () => {
  const fixtures = path.join(__dirname, 'fixtures')

  it('only attaches session listeners for events with extension listeners', async () => {
    const { session: customSession } = createCrxSession()
    const calls = observeSessionWebRequest(customSession)

    new ElectronChromeExtensions({
      license: 'internal-license-do-not-use' as any,
      session: customSession,
    })

    const sessionExtensions = customSession.extensions || customSession

    // An extension without webRequest listeners must not attach any
    // session.webRequest listeners which would disable Chromium's built-in
    // extension webRequest and declarativeNetRequest handling.
    const rpcExtension = await sessionExtensions.loadExtension(path.join(fixtures, 'rpc'))
    await waitForBackgroundScriptEvaluated(rpcExtension, customSession)
    await sleep(100)
    expect(calls).to.be.empty

    // The chrome-webRequest fixture listens for onBeforeRequest,
    // onSendHeaders, onCompleted and onAuthRequired. Only the events
    // supported by session.webRequest should be attached.
    const extension = await sessionExtensions.loadExtension(
      path.join(fixtures, 'chrome-webRequest'),
    )
    await waitForBackgroundScriptEvaluated(extension, customSession)

    await waitUntil(() => calls.length >= FIXTURE_ATTACHED_EVENTS.length)
    expect(calls.map((call) => call.event).sort()).to.deep.equal(FIXTURE_ATTACHED_EVENTS)
    expect(calls.every((call) => call.listener === 'function')).to.be.true
  })
})
