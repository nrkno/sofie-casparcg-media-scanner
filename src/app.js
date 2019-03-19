// @ts-check
const express = require('express')
const pinoHttp = require('pino-http')
const cors = require('cors')
const PouchDB = require('pouchdb-node')
const util = require('util')
const path = require('path')
const { generateInfo, generateThumb, generateAdvancedMetadata, scanFile, lookForFile } = require('./scanner')
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

  function stepThrough (array, index) {
    if (index === undefined) {
      index = 0
    }
    if (index >= array.length) {
      return
    }
    const item = array[index]
    generateThumb(config, item).then(async () => {
      await db.put(item)
      stepThrough(array, index + 1)
    }).catch(() => {
      stepThrough(array, index + 1)
    })
  }

  app.get('/thumbnail/generate', wrap(async (req, res) => {
    res.set('content-type', 'text/plain')

    try {
      const result = await db.allDocs({
        include_docs: true
      })
      const files = result.rows.map(i => i.doc)
      // set up a procedure to iterate through the results and generate thumbnails in sequence
      stepThrough(files)
      res.send(`202 THUMBNAIL GENERATE_ALL OK\r\n`)
    } catch (e) {
      logger.error(e)
      logger.error(e.stack)

      res.send(`501 THUMBNAIL GENERATE_ALL ERROR\r\n`)
    }
  }))

  function metaGenerate (res, idString, dbGeneration, name, fileStat) {
    res.set('content-type', 'text/plain')
    if (dbGeneration[idString] && !dbGeneration[idString].done) {
      res.send(`203 ${name} BEING PROCESSED\r\n`)
      return
    }

    dbGeneration[idString] = {
      done: false,
      status: 'processing',
      error: false
    }
    db.get(idString)
      .then(doc => {
        switch (name) {
          case 'THUMBNAIL GENERATE':
            return generateThumb(config, doc)
              .then(() => {
                return db.put(doc)
              })
          case 'PREVIEW GENERATE':
            const mediaId = doc._id
            return generatePreview(db, config, logger, mediaId)
          case 'MEDIA INFO':
            return generateInfo(config, doc)
              .then(() => {
                return db.put(doc)
              })
              .then(() => {
                logger.info(`Generated info for "${idString}"`)
                dbGeneration[idString].status = 'success'
              })
          case 'METADATA':
            return generateAdvancedMetadata(config, doc)
              .then((doc) => {
                return db.put(doc)
              })
          default:
            return Promise.reject(new Error('Invalid Name ' + name))
        }
      })
      .then(() => {
        dbGeneration[idString].status = 'success'
        dbGeneration[idString].done = true
      })
      .catch(error => {
        if (name === 'MEDIA INFO') {
          dbGeneration[idString].error = error
          dbGeneration[idString].status = 'degraded'
          return scanFile(db, config, logger, fileStat.mediaPath, fileStat.mediaId, fileStat.mediaStat)
            .then((data) => {
              dbGeneration[idString].status = 'success'
              return data
            })
        }
        return Promise.reject(error)
      })
      .catch(error => {
        logger.error(error)
        logger.error(error.stack)

        dbGeneration[idString].status = 'error'
        dbGeneration[idString].error = error
        dbGeneration[idString].done = true
      })
    res.send(`202 ${name} QUEUED OK\r\n`)
  }

  function metaStatus (id, name, dbGeneration, req, res) {
    const preserveState = req.query.preserveState
    if (dbGeneration[id]) {
      switch (dbGeneration[id].status) {
        case 'success':
          res.send(`202 ${name} OK\r\n`)
          if (!preserveState) { dbGeneration[id] = undefined }
          return
        case 'processing':
        case 'degraded':
          res.send(`203 ${name} IN PROGRESS\r\n`)
          return
        case 'error':
          res.send(`500 ${name} ERROR\r\n`)
          if (!preserveState) { dbGeneration[id] = undefined }
          return
        default:
          res.send(`500 UNKNOWN STATUS: ${dbGeneration[id].status}\r\n`)
          if (dbGeneration[id].done && !preserveState) { dbGeneration[id] = undefined }
      }
    } else {
      res.send(`404 ${name} NOT FOUND\r\n`)
    }
  }

  let ongoingThumbnailGeneration = {}
  app.post('/thumbnail/generateAsync/:id', wrap(async (req, res) => {
    let thumbnailId = req.params.id.toUpperCase()
    metaGenerate(res, thumbnailId, ongoingThumbnailGeneration, 'THUMBNAIL GENERATE')
  }))

  app.get('/thumbnail/generateAsync/:id', wrap(async (req, res) => {
    let thumbnailId = req.params.id.toUpperCase()
    metaStatus(thumbnailId, 'THUMBNAIL GENERATE', ongoingThumbnailGeneration, req, res)
  }))

  app.get('/thumbnail/generate/:id', wrap(async (req, res) => {
    res.set('content-type', 'text/plain')

    try {
      const doc = await db.get(req.params.id.toUpperCase())
      await generateThumb(config, doc)
      db.put(doc)

      res.send(`202 THUMBNAIL GENERATE OK\r\n`)
    } catch (e) {
      logger.error(e)
      logger.error(e.stack)

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

  let ongoingPreviewGenerations = {}
  app.post('/preview/generateAsync/:id', wrap(async (req, res) => {
    let previewId = req.params.id.toUpperCase()
    metaGenerate(res, previewId, ongoingPreviewGenerations, 'PREVIEW GENERATE')
  }))
  app.get('/preview/generateAsync/:id', wrap(async (req, res) => {
    let previewId = req.params.id.toUpperCase()
    metaStatus(previewId, 'PREVIEW GENERATE', ongoingPreviewGenerations, req, res)
  }))

  app.get('/preview/generate/:id', wrap(async (req, res) => {
    res.set('content-type', 'text/plain')

    try {
      const doc = await db.get(req.params.id.toUpperCase())
      const mediaId = doc._id

      await generatePreview(db, config, logger, mediaId)
      res.send(`202 PREVIEW GENERATE OK\r\n`)
    } catch (e) {
      logger.error(e)
      logger.error(e.stack)

      res.send(`500 PREVIEW GENERATE ERROR\r\n`)
    }
  }))

  /**
   * Start media scan of file
   */
  let ongoingMediaInfoScans = {}
  app.post('/media/scanAsync/:fileName', wrap(async (req, res) => {
    logger.info(`Looking for file "${req.params.fileName}"...`)
    const stat = await lookForFile(req.params.fileName, config)

    if (stat === false) {
      res.send(`404 FILE NOT FOUND\r\n`)
      return
    }

    const mediaId = req.params.fileName
      .replace(/\.[^/.]+$/, '')
      .replace(/\\+/g, '/')
      .toUpperCase()

    metaGenerate(res, mediaId, ongoingMediaInfoScans, 'MEDIA INFO', stat)
  }))

  /**
   * Get status of a media scan
   */
  app.get('/media/scanAsync/:fileName', wrap(async (req, res) => {
    const mediaId = req.params.fileName
      .replace(/\.[^/.]+$/, '')
      .replace(/\\+/g, '/')
      .toUpperCase()
    metaStatus(mediaId, 'MEDIA INFO', ongoingMediaInfoScans, req, res)
  }))

  /**
   * Start media scan of file
   */
  let ongoingMediaMetadataScans = {}
  app.post('/metadata/scanAsync/:fileName', wrap(async (req, res) => {
    logger.info(`Looking for file "${req.params.fileName}"...`)
    const stat = await lookForFile(req.params.fileName, config)

    if (stat === false) {
      res.send(`404 FILE NOT FOUND\r\n`)
      return
    }

    const mediaId = req.params.fileName
      .replace(/\.[^/.]+$/, '')
      .replace(/\\+/g, '/')
      .toUpperCase()

    metaGenerate(res, mediaId, ongoingMediaMetadataScans, 'METADATA', stat)
  }))

  /**
   * Get status of a media scan
   */
  app.get('/metadata/scanAsync/:fileName', wrap(async (req, res) => {
    const mediaId = req.params.fileName
      .replace(/\.[^/.]+$/, '')
      .replace(/\\+/g, '/')
      .toUpperCase()
    metaStatus(mediaId, 'METADATA', ongoingMediaInfoScans, req, res)
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
      logger.info(`Generated info for "${mediaId}"`)
      await db.put(doc)
    } catch (e) {
      logger.info(`Looking for file "${req.params.fileName}"...`)
      const stat = await lookForFile(req.params.fileName, config)

      if (stat === false) {
        res.send(`404 FILE NOT FOUND\r\n`)
        return
      }

      await scanFile(db, config, logger, stat.mediaPath, stat.mediaId, stat.mediaStat)
        .catch(error => {
          if (error) {
            logger.error(error.stack)
          }
          logger.error({ name: 'scanFile', err: error })
        })
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
