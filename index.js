const { Transform } = require('stream')
const { inherits } = require('util')
const { launch } = require('puppeteer')
const finished = require('tap-finished')
const pump = require('pump')

const DEVICES = require('./DEVICES.js')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const noSandboxOnTravis = opts => {
  if ('TRAVIS' in process.env) {
    const chromium_flags = [ '--no-sandbox', '--disable-setuid-sandbox' ]
    if (Array.isArray(opts.args)) opts.args = opts.args.concat(chromium_flags)
    else opts.args = chromium_flags
  }
  return opts
}

const allowDevtools = opts => {
  if (opts.devtools) opts.headless = false
  return opts
}

function TapePuppetStream (opts) {
  if (!(this instanceof TapePuppetStream)) return new TapePuppetStream(opts)
  Transform.call(this)
  this._opts = allowDevtools(noSandboxOnTravis(Object.assign({}, opts || {})))
  this._accu = Buffer.alloc(0)
  if (this._opts.devices) this.end() // no stdin expected, trigger flush
  console.error(this._opts)
}

inherits(TapePuppetStream, Transform)

TapePuppetStream.prototype._transform = function transform (chunk, _, next) {
  this._accu = Buffer.concat([ this._accu, chunk ])
  next()
}

TapePuppetStream.prototype._flush = async function flush (end) {
  const self = this

  if (self._opts.devices) { // list device names and quit
    Object.keys(DEVICES).forEach(deviceName => self.push(`${deviceName}\n`))
    self.destroy()
    return end()
  }

  const shutdown = async err => {
    try {
      if (browser) await browser.close()
    } catch (error) {
      if (!err) err = error
    }
    if (!self.destroyed) self.destroy(err)
    end(err)
  }

  var browser, page
  try {
    browser = await launch(self._opts)
    page = await browser.newPage()
  } catch (err) {
    return shutdown(err)
  }

  page.on('error', shutdown)
  page.on('pageerror', shutdown)
  page.on('console', msg => self.push(`${msg._text}\n`))

  pump(self, finished(self._opts, self.emit.bind(self, 'results')), shutdown)

  try {
    if (DEVICES[self._opts.emulate])
      await page.emulate(DEVICES[self._opts.emulate])
    if (/debugger/.test(self._accu))
      await sleep(500) // HACK: allow debugger statements to become effective
    await page.evaluate(String(self._accu))
  } catch (err) {
    return shutdown(err)
  }
}

module.exports = TapePuppetStream
