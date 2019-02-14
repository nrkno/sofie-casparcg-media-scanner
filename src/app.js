const express = require('express')
const pinoHttp = require('pino-http')
const cors = require('cors')
const PouchDB = require('pouchdb-node')
const util = require('util')
const path = require('path')
const { generateInfo, generateThumb, scanFile, lookForFile } = require('./scanner')
const { generatePreview } = require('./previews')
const recursiveReadDir = require('recursive-readdir')
const { getId, fsSize } = require('./util')
const { setManualMode, getManualMode, restoreManualMode } = require('./manual')

const recursiveReadDirAsync = util.promisify(recursiveReadDir)

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

module.exports = function ({ db, config, logger }) {
  const app = express()

  restoreManualMode()

  app.use(pinoHttp({ logger }))
  app.use(cors())

  app.use('/db', require('express-pouchdb')(PouchDB, {
    mode: 'minimumForPouchDB'
  }))

  app.get('/stat/fs', wrap(async (req, res) => {
    const filesystemInfo = await fsSize()

    res.set('content-type', 'application/json')
    res.send(filesystemInfo)
  }))

  app.get('/stat/seq', wrap(async (req, res) => {
    const { update_seq } = await db.info()

    res.set('content-type', 'application/json')
    res.send({ update_seq })
  }))

  app.get('/media', wrap(async (req, res) => {
    const { rows } = await db.allDocs({ include_docs: true })

    const blob = rows
      .filter(r => r.doc.mediainfo)
      .map(r => r.doc.mediainfo)

    res.set('content-type', 'application/json')
    res.send(blob)
  }))

  app.get('/media/info/:id', wrap(async (req, res) => {
    const { mediainfo } = await db.get(req.params.id.toUpperCase())
    res.set('content-type', 'application/json')
    res.send(mediainfo || {})
  }))

  app.get('/media/thumbnail/:id', wrap(async (req, res) => {
    const { _attachments } = await db.get(req.params.id.toUpperCase(), { attachments: true, binary: true })

    if (!_attachments['thumb.png']) {
      return res.status(404).end()
    }

    res.set('content-type', 'image/png')
    res.send(_attachments['thumb.png'].data)
  }))

  app.get('/media/preview/:id', wrap(async (req, res) => {
    const { previewPath } = await db.get(req.params.id.toUpperCase())

    res.sendFile(path.join(process.cwd(), previewPath))
  }))

  app.get('/cls', wrap(async (req, res) => {
    const { rows } = await db.allDocs({ include_docs: true })

    const str = rows
      .map(row => row.doc.cinf || '')
      .reduce((acc, inf) => acc + inf, '')

    res.set('content-type', 'text/plain')
    res.send(`200 CLS OK\r\n${str}\r\n`)
  }))

  app.get('/tls', wrap(async (req, res) => {
    // TODO (perf) Use scanner?
    const rows = await recursiveReadDirAsync(config.paths.template)

    const str = rows
      .filter(x => /\.(ft|wt|ct|html)$/.test(x))
      .map(x => `${getId(config.paths.template, x)}\r\n`)
      .reduce((acc, inf) => acc + inf, '')

    res.set('content-type', 'text/plain')
    res.send(`200 TLS OK\r\n${str}\r\n`)
  }))

  app.get('/fls', wrap(async (req, res) => {
    // TODO (perf) Use scanner?
    const rows = await recursiveReadDirAsync(config.paths.font)

    const str = rows
      .map(x => `${getId(config.paths.font, x)}\r\n`)
      .reduce((acc, inf) => acc + inf, '')

    res.set('content-type', 'text/plain')
    res.send(`200 FLS OK\r\n${str}\r\n`)
  }))

  app.get('/cinf/:id', wrap(async (req, res) => {
    const { cinf } = await db.get(req.params.id.toUpperCase())
    res.set('content-type', 'text/plain')
    res.send(`201 CINF OK\r\n${cinf}`)
  }))

  app.get('/thumbnail/generate', wrap(async (req, res) => {
    res.set('content-type', 'text/plain')

    try {
      const result = await db.allDocs({
        include_docs: true
      })
      const files = result.rows.map(i => i.doc)  
      // set up a procedure to iterate through the results and generate thumbnails in sequence
      function stepThrough (array, index) {
        if (index === undefined) {
          index = 0
        }
        if (index >= array.length) { 
          return
        }
        const item = array[index];
        generateThumb(config, item).then(async () => {
          await db.put(item)
          stepThrough(array, index + 1)
        }).catch(() => {
          stepThrough(array, index + 1)
        })
      }
  
      stepThrough(files)
  
      res.send(`202 THUMBNAIL GENERATE_ALL OK\r\n`)
    } catch (e) {
      logger.error(e)

      res.send(`501 THUMBNAIL GENERATE_ALL ERROR\r\n`)
    }
  }))

  app.get('/thumbnail/generate/:id', wrap(async (req, res) => {
    res.set('content-type', 'text/plain')

    try {
      const doc = await db.get(req.params.id.toUpperCase())
      try {
        await generateThumb(config, doc)
        db.put(doc)
    
        res.send(`202 THUMBNAIL GENERATE OK\r\n`)
      } catch(e) {
        logger.error(e)
  
        res.send(`501 THUMBNAIL GENERATE ERROR\r\n`)
      }
    } catch (e) {
      logger.error(e)

      res.send(`501 THUMBNAIL GENERATE ERROR\r\n`)
    }
  }))

  app.get('/thumbnail', wrap(async (req, res) => {
    const { rows } = await db.allDocs({ include_docs: true })

    const str = rows
      .map(row => row.doc.tinf || '')
      .reduce((acc, inf) => acc + inf, '')

    res.set('content-type', 'text/plain')
    res.send(`200 THUMBNAIL LIST OK\r\n${str}\r\n`)
  }))

  app.get('/preview/generate/:id', wrap(async (req, res) => {
    res.set('content-type', 'text/plain')

    try {
      const doc = await db.get(req.params.id.toUpperCase())
      const mediaId = doc._id
      
      try {
        await generatePreview(db, config, logger, mediaId)
    
        res.send(`202 PREVIEW GENERATE OK\r\n`)
      } catch (e) {
        logger.error(e)
  
        res.send(`500 PREVIEW GENERATE ERROR\r\n`)
      }
    } catch (e) {
      logger.error(e)

      res.send(`500 PREVIEW GENERATE ERROR\r\n`)
    }
  }))

  app.get('/media/scan/:fileName', wrap(async (req, res) => {
    let doc
    try {
      const mediaId = req.params.fileName
        .replace(/\.[^/.]+$/, '')
        .replace(/\\+/g, '/')
        .toUpperCase()
      doc = await db.get(mediaId)

      await generateInfo(config, doc)
    } catch (e) {
      logger.info(`Looking for file "${req.params.fileName}"...`)
      const stat = await lookForFile(req.params.fileName, config)

      if (stat === false) {
        res.send(`404 FILE NOT FOUND\r\n`)
        return
      }
      
      await scanFile(db, config, logger, stat.mediaPath, stat.mediaId, stat.mediaStat)
    }
    
    res.set('content-type', 'text/plain')
    res.send(`202 MEDIA INFO GENERATE OK\r\n`)
  }))

  app.get('/manualMode', wrap(async (req, res) => {
    res.set('content-type', 'application/json')
    res.send(JSON.stringify({
      manualMode: getManualMode()
    }))
  }))

  app.get('/manualMode/:enabled', wrap(async (req, res) => {
    setManualMode(req.params.enabled.toLowerCase() === 'true')
    
    logger.info(`Media Scanner is now in manual mode`)

    res.set('content-type', 'application/json')
    res.send(JSON.stringify({
      manualMode: getManualMode()
    }))
  }))

  app.get('/thumbnail/:id', wrap(async (req, res) => {
    const { _attachments } = await db.get(req.params.id.toUpperCase(), { attachments: true })

    if (!_attachments['thumb.png']) {
      return res.status(404).end()
    }

    res.set('content-type', 'text/plain')
    res.send(`201 THUMBNAIL RETRIEVE OK\r\n${_attachments['thumb.png'].data}\r\n`)
  }))

  app.use((err, req, res, next) => {
    if (err) req.log.error({ err })
    if (!res.headersSent) {
      res.statusCode = err ? err.status || err.statusCode || 500 : 500
      res.end()
    } else {
      res.destroy()
    }
  })

  return app
}
