import debug from 'debug'
import { ExtensionContext } from '../context'
import { getExtensionManifest, matchesPattern } from './common'

const d = debug('electron-chrome-extensions:webRequest')

/**
 * `chrome.webRequest` events backed by Electron's `session.webRequest` module.
 *
 * This implementation is observational only. Electron's blocking callbacks
 * are always resolved immediately without modification—extensions can observe
 * requests, but can't block or modify them.
 */
type WebRequestEventName =
  | 'onBeforeRequest'
  | 'onBeforeSendHeaders'
  | 'onSendHeaders'
  | 'onHeadersReceived'
  | 'onResponseStarted'
  | 'onBeforeRedirect'
  | 'onCompleted'
  | 'onErrorOccurred'

const WEB_REQUEST_EVENTS: WebRequestEventName[] = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred',
]

/** Events which Electron invokes with a callback capable of blocking the request. */
const BLOCKING_EVENTS: Set<WebRequestEventName> = new Set([
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onHeadersReceived',
] as WebRequestEventName[])

/**
 * Union of the properties found in Electron's webRequest listener details.
 * Each event provides a subset of these.
 */
interface ElectronRequestDetails {
  id: number
  url: string
  method: string
  webContentsId?: number
  webContents?: Electron.WebContents
  frame?: Electron.WebFrameMain | null
  resourceType: string
  referrer: string
  timestamp: number
  uploadData?: Electron.UploadData[]
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[]>
  statusLine?: string
  statusCode?: number
  redirectURL?: string
  ip?: string
  fromCache?: boolean
  error?: string
}

/** Electron resource types which map to different Chrome resource type names. */
const RESOURCE_TYPE_MAP: { [key: string]: string } = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  xhr: 'xmlhttprequest',
  cspReport: 'csp_report',
  webSocket: 'websocket',
}

const getResourceType = (resourceType: string) => RESOURCE_TYPE_MAP[resourceType] || resourceType

const getFrameId = (frame: Electron.WebFrameMain | null | undefined) =>
  frame ? (frame === frame.top ? 0 : frame.frameTreeNodeId) : -1

const getParentFrameId = (frame: Electron.WebFrameMain | null | undefined) => {
  const parentFrame = frame?.parent
  return parentFrame ? getFrameId(parentFrame) : -1
}

/** Converts Electron request headers into Chrome's HttpHeader array. */
const convertRequestHeaders = (headers: Record<string, string>): chrome.webRequest.HttpHeader[] => {
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

/** Converts Electron response headers into Chrome's HttpHeader array. */
const convertResponseHeaders = (
  headers: Record<string, string[]>,
): chrome.webRequest.HttpHeader[] => {
  return Object.entries(headers).flatMap(([name, values]) =>
    values.map((value) => ({ name, value })),
  )
}

/**
 * Converts Electron upload data into Chrome's request body shape.
 *
 * NOTE: Only raw bytes are provided—Chrome's `formData` parsing is not
 * implemented.
 */
const convertRequestBody = (uploadData: Electron.UploadData[]) => ({
  raw: uploadData.map((data) => ({
    bytes: data.bytes
      ? data.bytes.buffer.slice(
          data.bytes.byteOffset,
          data.bytes.byteOffset + data.bytes.byteLength,
        )
      : undefined,
    file: data.file,
  })),
})

/** Match patterns which grant host access from an extension's manifest. */
const getHostPatterns = (extension: Electron.Extension): string[] => {
  const manifest = getExtensionManifest(extension)
  const permissions =
    manifest.manifest_version === 3 ? manifest.host_permissions : manifest.permissions
  return (permissions || []).filter(
    (permission) => permission === '<all_urls>' || permission.includes('://'),
  )
}

const canAccessUrl = (extension: Electron.Extension, url: string): boolean => {
  const manifest = getExtensionManifest(extension)
  if (!manifest.permissions?.includes('webRequest')) return false
  return getHostPatterns(extension).some((pattern) => matchesPattern(pattern, url))
}

export class WebRequestAPI {
  /** Number of extension listeners per event, keyed by extension ID. */
  private listeners: Map<WebRequestEventName, Map<string, number>> = new Map()

  constructor(private ctx: ExtensionContext) {
    const { router } = this.ctx
    router.events.on('listener-added', this.onListenerAdded)
    router.events.on('listener-removed', this.onListenerRemoved)
  }

  private getEventFromName(eventName: string): WebRequestEventName | undefined {
    const [apiName, event] = eventName.split('.')
    if (apiName !== 'webRequest') return
    // NOTE: 'onAuthRequired' is intentionally excluded—Electron provides no
    // session.webRequest equivalent so it never emits.
    return WEB_REQUEST_EVENTS.includes(event as WebRequestEventName)
      ? (event as WebRequestEventName)
      : undefined
  }

  private onListenerAdded = (eventName: string, extensionId: string) => {
    const event = this.getEventFromName(eventName)
    if (!event) return

    let extensionCounts = this.listeners.get(event)
    if (!extensionCounts) {
      extensionCounts = new Map()
      this.listeners.set(event, extensionCounts)
    }

    const shouldAttach = extensionCounts.size === 0
    extensionCounts.set(extensionId, (extensionCounts.get(extensionId) || 0) + 1)

    if (shouldAttach) {
      this.attachSessionListener(event)
    }
  }

  private onListenerRemoved = (eventName: string, extensionId: string) => {
    const event = this.getEventFromName(eventName)
    if (!event) return

    const extensionCounts = this.listeners.get(event)
    if (!extensionCounts) return

    const count = extensionCounts.get(extensionId) || 0
    if (count > 1) {
      extensionCounts.set(extensionId, count - 1)
    } else {
      extensionCounts.delete(extensionId)
    }

    if (extensionCounts.size === 0) {
      this.listeners.delete(event)
      this.detachSessionListener(event)
    }
  }

  /**
   * Attaches a session.webRequest listener for the given event.
   *
   * IMPORTANT: Registering any session.webRequest listener disables Chromium's
   * built-in extension webRequest and declarativeNetRequest handling for new
   * URLLoaderFactories in the session. To limit the impact, listeners are
   * attached only while at least one extension listener exists and detached
   * when the last one is removed.
   */
  private attachSessionListener(event: WebRequestEventName) {
    d(`attaching session listener for '${event}'`)

    const { webRequest } = this.ctx.session

    const listener = BLOCKING_EVENTS.has(event)
      ? (
          details: ElectronRequestDetails,
          callback: (response: Electron.CallbackResponse) => void,
        ) => {
          // Observational only: never block or modify the request.
          callback({})
          this.onRequestEvent(event, details)
        }
      : (details: ElectronRequestDetails) => {
          this.onRequestEvent(event, details)
        }

    ;(webRequest[event] as any)(listener)
  }

  private detachSessionListener(event: WebRequestEventName) {
    d(`detaching session listener for '${event}'`)
    const { webRequest } = this.ctx.session
    ;(webRequest[event] as any)(null)
  }

  /** Sends the event to each subscribed extension with access to the URL. */
  private onRequestEvent(event: WebRequestEventName, details: ElectronRequestDetails) {
    const extensionCounts = this.listeners.get(event)
    if (!extensionCounts || extensionCounts.size === 0) return

    const eventDetails = this.createEventDetails(event, details)

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    for (const extensionId of extensionCounts.keys()) {
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension) continue

      if (!canAccessUrl(extension, details.url)) {
        d(`'${event}' not sent to ${extensionId}—no host access to ${details.url}`)
        continue
      }

      this.ctx.router.sendEvent(extensionId, `webRequest.${event}`, eventDetails)
    }
  }

  /**
   * Maps Electron's listener details into Chrome's webRequest details.
   *
   * Headers and request bodies are always included when Electron provides
   * them—the renderer preload is responsible for removing any which weren't
   * requested by the listener's extraInfoSpec.
   */
  private createEventDetails(event: WebRequestEventName, details: ElectronRequestDetails) {
    const type = getResourceType(details.resourceType)

    // NOTE: frameId/parentFrameId are approximations based on Electron's
    // frameTreeNodeId, consistent with the webNavigation implementation.
    // Aside from the main frame's 0, they won't match Chrome's frame IDs.
    let frameId = -1
    let parentFrameId = -1
    try {
      frameId = type === 'main_frame' ? 0 : getFrameId(details.frame)
      parentFrameId = type === 'main_frame' ? -1 : getParentFrameId(details.frame)
    } catch {
      // WebFrameMain may have been disposed.
    }

    const tabId =
      typeof details.webContentsId === 'number' && this.ctx.store.getTabById(details.webContentsId)
        ? details.webContentsId
        : -1

    const eventDetails: Record<string, any> = {
      frameId,
      method: details.method,
      parentFrameId,
      requestId: `${details.id}`,
      tabId,
      timeStamp: details.timestamp,
      type,
      url: details.url,
    }

    switch (event) {
      case 'onBeforeRequest':
        if (details.uploadData && details.uploadData.length > 0) {
          eventDetails.requestBody = convertRequestBody(details.uploadData)
        }
        break
      case 'onBeforeSendHeaders':
      case 'onSendHeaders':
        eventDetails.requestHeaders = convertRequestHeaders(details.requestHeaders || {})
        break
      case 'onHeadersReceived':
        eventDetails.responseHeaders = convertResponseHeaders(details.responseHeaders || {})
        eventDetails.statusCode = details.statusCode
        eventDetails.statusLine = details.statusLine
        break
      case 'onResponseStarted':
        eventDetails.responseHeaders = convertResponseHeaders(details.responseHeaders || {})
        eventDetails.fromCache = details.fromCache
        eventDetails.statusCode = details.statusCode
        eventDetails.statusLine = details.statusLine
        break
      case 'onBeforeRedirect':
        eventDetails.responseHeaders = convertResponseHeaders(details.responseHeaders || {})
        eventDetails.redirectUrl = details.redirectURL
        eventDetails.fromCache = details.fromCache
        eventDetails.statusCode = details.statusCode
        eventDetails.statusLine = details.statusLine
        if (details.ip) eventDetails.ip = details.ip
        break
      case 'onCompleted':
        eventDetails.responseHeaders = convertResponseHeaders(details.responseHeaders || {})
        eventDetails.fromCache = details.fromCache
        eventDetails.statusCode = details.statusCode
        eventDetails.statusLine = details.statusLine
        break
      case 'onErrorOccurred':
        eventDetails.error = details.error
        eventDetails.fromCache = details.fromCache
        break
    }

    return eventDetails
  }
}
