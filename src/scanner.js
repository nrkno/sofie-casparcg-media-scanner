// @ts-check
const ChildProcess = require('child_process')
const util = require('util')
const chokidar = require('chokidar')
const mkdirp = require('mkdirp-promise')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { getId, fileExists } = require('./util')
const moment = require('moment')
const { getManualMode } = require('./manual')

const statAsync = util.promisify(fs.stat)
const unlinkAsync = util.promisify(fs.unlink)
const readFileAsync = util.promisify(fs.readFile)

let isCurrentlyScanning = false
let currentScanId = 1

const FILE_SCAN_RETRY_LIMIT = Number(process.env.FILE_SCAN_RETRY_LIMIT) || 3
async function lookForFile (mediaGeneralId, config) {
  try {
    const mediaPath = path.join(config.paths.media, mediaGeneralId)
    const mediaStat = await statAsync(mediaPath)
    const mediaId = getId(config.paths.media, mediaPath)
    return {
      mediaPath,
      mediaStat,
      mediaId
    }
  } catch (e) {
    return false
  }
}

function isCurrentlyScanningFile () {
  return isCurrentlyScanning
}
/**
 * Returns current running scan id (number), or false (boolean)
 */
function currentlyScanningFileId () {
  if(isCurrentlyScanning){
    return currentScanId
  } else {
    return false
  }
}

let filesToScan = {}
let filesToScanFail = {}
let retrying = false
async function retryScan () {
  if (retrying) {
    return
  }
  retrying = true
  let redoRetry = false
  for (const fileObject of Object.values(filesToScan)) {
    await scanFile(
      fileObject.db,
      fileObject.config,
      fileObject.logger,
      fileObject.mediaPath,
      fileObject.mediaId,
      fileObject.mediaStat)
      .then(() => {
        delete filesToScan[fileObject.mediaId]
      })
      .catch(() => {
        redoRetry = true
      })
  }
  retrying = false
  if (redoRetry) {
    retryScan()
  }
}

async function scanFile (db, config, logger, mediaPath, mediaId, mediaStat) {
  try {
    if (!mediaId || mediaStat.isDirectory()) {
      return
    }
    if (!filesToScan[mediaId]) {
      filesToScan[mediaId] = {
        db, config, logger, mediaPath, mediaId, mediaStat
      }
    }
    if (isCurrentlyScanning) {
      return
    }
    isCurrentlyScanning = true
    currentScanId = currentScanId + 1

    const doc = await db
      .get(mediaId)
      .catch(() => ({ _id: mediaId }))

    const mediaLogger = logger.child({
      id: mediaId,
      path: mediaPath,
      size: mediaStat.size,
      mtime: mediaStat.mtime.toISOString()
    })

    if (doc.mediaPath && doc.mediaPath !== mediaPath) {
      mediaLogger.info('Skipped')
      delete filesToScanFail[mediaId]
      delete filesToScan[mediaId]
      isCurrentlyScanning = false
      return
    }

    if (doc.mediaSize === mediaStat.size && doc.mediaTime === mediaStat.mtime.getTime()) {
      isCurrentlyScanning = false
      delete filesToScanFail[mediaId]
      delete filesToScan[mediaId]
      return
    }

    doc.mediaPath = mediaPath
    doc.mediaSize = mediaStat.size
    doc.mediaTime = mediaStat.mtime.getTime()

    if (!getManualMode()) {
      await Promise.all([
        generateInfo(config, doc).catch(err => {
          mediaLogger.error({ err }, 'Info Failed')
        }),
        generateThumb(config, doc).catch(err => {
          mediaLogger.error({ err }, 'Thumbnail Failed')
        })
      ])
    }

    await db.put(doc)
    delete filesToScanFail[mediaId]
    delete filesToScan[mediaId]
    isCurrentlyScanning = false
    mediaLogger.info('Scanned')
    retryScan()
  } catch (error) {
    isCurrentlyScanning = false
    filesToScanFail[mediaId] = (filesToScanFail[mediaId] || 0) + 1
    if (filesToScanFail[mediaId] >= FILE_SCAN_RETRY_LIMIT) {
      logger.error('Skipping file. Too many retries; ' + mediaId)
      delete filesToScanFail[mediaId]
      delete filesToScan[mediaId]
    }
    retryScan()
    throw error
  }
}

let runningThumbnailProcess = null
async function generateThumb (config, doc) {
  const tmpPath = path.join(os.tmpdir(), Math.random().toString(16)) + '.png'

  const args = [
    // TODO (perf) Low priority process?
    config.paths.ffmpeg,
    '-hide_banner',
    '-i', `"${doc.mediaPath}"`,
    '-frames:v 1',
    `-vf thumbnail,scale=${config.thumbnails.width}:${config.thumbnails.height}`,
    '-threads 1',
    `"${tmpPath}"`
  ]

  await mkdirp(path.dirname(tmpPath))
  await new Promise((resolve, reject) => {
    runningThumbnailProcess = ChildProcess.exec(args.join(' '), (err, stdout, stderr) => err ? reject(err) : resolve())
    runningThumbnailProcess.on('exit', function () {
      runningThumbnailProcess = null
    })
  })

  const thumbStat = await statAsync(tmpPath)
  doc.thumbSize = thumbStat.size
  doc.thumbTime = thumbStat.mtime.getTime()
  doc.tinf = [
    `"${getId(config.paths.media, doc.mediaPath)}"`,
    moment(doc.thumbTime).format('YYYYMMDDTHHmmss'),
    // TODO (fix) Binary or base64 size?
    doc.thumbSize
  ].join(' ') + '\r\n'

  doc._attachments = {
    'thumb.png': {
      content_type: 'image/png',
      data: (await readFileAsync(tmpPath))
    }
  }
  await unlinkAsync(tmpPath)
}
let runningffprobeProcess = null
async function generateInfo (config, doc) {
  const json = await new Promise((resolve, reject) => {
    const args = [
      // TODO (perf) Low priority process?
      config.paths.ffprobe,
      '-hide_banner',
      '-i', `"${doc.mediaPath}"`,
      '-show_streams',
      '-show_format',
      '-print_format', 'json'
    ]
    runningffprobeProcess = ChildProcess.exec(args.join(' '), (err, stdout, stderr) => {
      if (err) {
        return reject(err)
      }

      const json = JSON.parse(stdout)
      if (!json.streams || !json.streams[0]) {
        return reject(new Error('not media'))
      }
      // TODO: Remove set-timeout here. Just testing that the thing works as expected
      resolve(json)
    })
    runningffprobeProcess.on('exit', function () {
      runningffprobeProcess = null
    })
  })

  doc.cinf = generateCinf(config, doc, json)

  if (config.metadata !== null) {
    doc.mediainfo = await generateMediainfo(config, doc, json)
  }
}

function generateCinf (config, doc, json) {
  let tb = (json.streams[0].time_base || '1/25').split('/')
  let dur = parseFloat(json.format.duration) || (1 / 24)

  let type = ' AUDIO '
  if (json.streams[0].pix_fmt) {
    type = dur <= (1 / 24) ? ' STILL ' : ' MOVIE '

    const fr = String(json.streams[0].avg_frame_rate || json.streams[0].r_frame_rate || '').split('/')
    if (fr.length === 2) {
      tb = [fr[1], fr[0]]
    }
  }

  return [
    `"${getId(config.paths.media, doc.mediaPath)}"`,
    type,
    doc.mediaSize,
    moment(doc.thumbTime).format('YYYYMMDDHHmmss'),
    Math.floor((dur * tb[1]) / tb[0]) || 0,
    `${tb[0]}/${tb[1]}`
  ].join(' ') + '\r\n'
}

function killAllChildProcesses () {
  if (runningMediaInfoProcess) {
    runningMediaInfoProcess.kill()
  }
  if (runningMediaInfoProcessRawVideo) {
    runningMediaInfoProcessRawVideo.kill()
  }
  if (runningThumbnailProcess) {
    runningThumbnailProcess.kill()
  }
  if (runningffprobeProcess) {
    runningffprobeProcess.kill()
  }
}

let runningMediaInfoProcess = null
let runningMediaInfoProcessRawVideo = null
async function generateMediainfo (config, doc, json) {
  const fieldOrder = await new Promise((resolve, reject) => {
    if (!config.metadata.fieldOrder) {
      return resolve('unknown')
    }

    const args = [
      // TODO (perf) Low priority process?
      config.paths.ffmpeg,
      '-hide_banner',
      '-filter:v', 'idet',
      '-frames:v', config.metadata.fieldOrderScanDuration,
      '-an',
      '-f', 'rawvideo', '-y', (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-i', `"${doc.mediaPath}"`
    ]
    runningMediaInfoProcessRawVideo = ChildProcess.exec(args.join(' '), (err, stdout, stderr) => {
      if (err) {
        return reject(err)
      }

      const resultRegex = /Multi frame detection: TFF:\s+(\d+)\s+BFF:\s+(\d+)\s+Progressive:\s+(\d+)/
      const res = resultRegex.exec(stderr)
      if (res === null) {
        return resolve('unknown')
      }

      const tff = parseInt(res[1])
      const bff = parseInt(res[2])
      const fieldOrder = tff <= 10 && bff <= 10 ? 'progressive' : (tff > bff ? 'tff' : 'bff')

      resolve(fieldOrder)
    })
    runningMediaInfoProcessRawVideo.on('exit', function () {
      runningMediaInfoProcessRawVideo = null
    })
  })

  const metadata = await new Promise((resolve, reject) => {
    if (!config.metadata.scenes && !config.metadata.freezeDetection && !config.metadata.blackDetection) {
      return resolve({})
    }

    let filterString = '' // String with combined filters.
    if (config.metadata.blackDetection) {
      filterString += `blackdetect=d=${config.metadata.blackDuration}:` +
        `pic_th=${config.metadata.blackRatio}:` +
        `pix_th=${config.metadata.blackThreshold}`

      if (config.metadata.freezeDetection || config.metadata.scenes) {
        filterString += ','
      }
    }

    if (config.metadata.freezeDetection) {
      filterString += `freezedetect=n=${config.metadata.freezeNoise}:` +
        `d=${config.metadata.freezeDuration}`

      if (config.metadata.scenes) {
        filterString += ','
      }
    }

    if (config.metadata.scenes) {
      filterString += `"select='gt(scene,${config.metadata.sceneThreshold})',showinfo"`
    }

    const args = [
      // TODO (perf) Low priority process?
      config.paths.ffmpeg,
      '-hide_banner',
      '-i', `"${doc.mediaPath}"`,
      '-filter:v', filterString,
      '-an',
      '-f', 'null',
      '-'
    ]
    runningMediaInfoProcess = ChildProcess.exec(args.join(' '), (err, stdout, stderr) => {
      if (err) {
        return reject(err)
      }

      let scenes = []
      let blacks = []
      let freezes = []

      // Scenes
      let sceneRegex = /Parsed_showinfo_(.*)pts_time:([\d.]+)\s+/g
      let res
      do {
        res = sceneRegex.exec(stderr)
        if (res) {
          scenes.push(parseFloat(res[2]))
        }
      } while (res)

      // Black detect
      let blackDetectRegex = /(black_start:)(\d+(.\d+)?)( black_end:)(\d+(.\d+)?)( black_duration:)(\d+(.\d+))?/g
      do {
        res = blackDetectRegex.exec(stderr)
        if (res) {
          blacks.push({
            start: res[2],
            duration: res[8],
            end: res[5]
          })
        }
      } while (res)

      // Freeze detect
      let freezeDetectRegex = /(lavfi\.freezedetect\.freeze_start: )(\d+(.\d+)?)/g
      do {
        res = freezeDetectRegex.exec(stderr)
        if (res) {
          freezes.push({ start: res[2] })
        }
      } while (res)

      freezeDetectRegex = /(lavfi\.freezedetect\.freeze_duration: )(\d+(.\d+)?)/g
      let i = 0
      do {
        res = freezeDetectRegex.exec(stderr)
        if (res && freezes[i]) {
          freezes[i].duration = res[2]
          i++
        }
      } while (res)

      freezeDetectRegex = /(lavfi\.freezedetect\.freeze_end: )(\d+(.\d+)?)/g
      i = 0
      do {
        res = freezeDetectRegex.exec(stderr)
        if (res && freezes[i]) {
          freezes[i].end = res[2]
          i++
        }
      } while (res)

      // if freeze frame is the end of video, it is not detected fully
      if (freezes[freezes.length - 1] && !freezes[freezes.length - 1].end) {
        freezes[freezes.length - 1].end = json.format.duration
        freezes[freezes.length - 1].duration = json.format.duration - freezes[freezes.length - 1].start
      }

      return resolve({ scenes, freezes, blacks })
    })
    runningMediaInfoProcess.on('exit', function () {
      runningMediaInfoProcess = null
    })
  })

  if (config.metadata.mergeBlacksAndFreezes) {
    if (
      metadata.blacks &&
      metadata.blacks.length &&
      metadata.freezes &&
      metadata.freezes.length
    ) {
      // blacks are subsets of freezes, so we can remove the freeze frame warnings during a black
      // in order to do this we create a linear timeline:
      const tl = []
      for (const black of metadata.blacks) {
        tl.push({ time: black.start, type: 'start', isBlack: true })
        tl.push({ time: black.end, type: 'end', isBlack: true })
      }
      for (const freeze of metadata.freezes) {
        tl.push({ time: freeze.start, type: 'start', isBlack: false })
        tl.push({ time: freeze.end, type: 'end', isBlack: false })
      }
      // then we sort it for time, if black & freeze start at the same time make sure black is inside the freeze
      tl.sort((a, b) => {
        if (a.time > b.time) {
          return 1
        } else if (a.time === b.time) {
          if ((a.isBlack && b.isBlack) || !(a.isBlack || b.isBlack)) {
            return 0
          } else {
            if (a.isBlack && a.type === 'start') {
              return 1
            } else if (a.isBlack && a.type === 'end') {
              return -1
            } else {
              return 0
            }
          }
        } else {
          return -1
        }
      })

      // now we add freezes that aren't coinciding with blacks
      let freeze
      let interruptedFreeze = false
      let freezes = []
      const startFreeze = (t) => {
        freeze = { start: t }
      }
      const endFreeze = t => {
        if (t === freeze.start) {
          freeze = undefined
          return
        }
        if (!freeze) return
        freeze.end = t
        freeze.duration = t - freeze.start
        freezes.push(freeze)
        freeze = undefined
      }

      for (const ev of tl) {
        if (ev.type === 'start') {
          if (ev.isBlack) {
            if (freeze) {
              interruptedFreeze = true
              endFreeze(ev.time)
            }
          } else {
            startFreeze(ev.time)
          }
        } else {
          if (ev.isBlack) {
            if (interruptedFreeze) {
              startFreeze(ev.time)
              interruptedFreeze = false
            }
          } else {
            if (freeze) {
              endFreeze(ev.time)
            } else {
              const freeze = freezes[freezes.length - 1]
              if (freeze) {
                freeze.end = ev.time
                freeze.duration = ev.time - freeze.start
                interruptedFreeze = false
              }
            }
          }
        }
      }

      metadata.freezes = freezes
    }
  }

  let type = 'AUDIO'
  if (json.streams[0].pix_fmt) {
    type = (parseFloat(json.format.duration) || 0) <= (1 / 24) ? 'STILL' : 'MOVIE'
  }

  const tryToCast = val => isNaN(Number(val)) ? val : Number(val)
  const tryToCastDoc = doc => {
    for (let key in doc) {
      let type = typeof doc[key]
      if (type === 'object') {
        doc[key] = tryToCastDoc(doc[key])
      } else {
        doc[key] = tryToCast(doc[key])
      }
    }
    return doc
  }

  return tryToCastDoc({
    name: doc._id,
    path: doc.mediaPath,
    size: doc.mediaSize,
    time: doc.mediaTime,
    type,
    field_order: fieldOrder,
    scenes: metadata.scenes,
    freezes: metadata.freezes,
    blacks: metadata.blacks,

    streams: json.streams.map(s => ({
      codec: {
        long_name: s.codec_long_name,
        type: s.codec_type,
        time_base: s.codec_time_base,
        tag_string: s.codec_tag_string,
        is_avc: s.is_avc
      },

      // Video
      width: s.width,
      height: s.height,
      sample_aspect_ratio: s.sample_aspect_ratio,
      display_aspect_ratio: s.display_aspect_ratio,
      pix_fmt: s.pix_fmt,
      bits_per_raw_sample: s.bits_per_raw_sample,

      // Audio
      sample_fmt: s.sample_fmt,
      sample_rate: s.sample_rate,
      channels: s.channels,
      channel_layout: s.channel_layout,
      bits_per_sample: s.bits_per_sample,

      // Common
      time_base: s.time_base,
      start_time: s.start_time,
      duration_ts: s.duration_ts,
      duration: s.duration,

      bit_rate: s.bit_rate,
      max_bit_rate: s.max_bit_rate,
      nb_frames: s.nb_frames
    })),
    format: {
      name: json.format.format_name,
      long_name: json.format.format_long_name,
      size: json.format.time,

      start_time: json.format.start_time,
      duration: json.format.duration,
      bit_rate: json.format.bit_rate,
      max_bit_rate: json.format.max_bit_rate
    }
  })
}

function fileAdded (mediaPath, mediaStat, db, config, logger) {
  const mediaId = getId(config.paths.media, mediaPath)
  return scanFile(db, config, logger, mediaPath, mediaId, mediaStat)
    .catch(error => { logger.error(error) })
}
function fileChanged (mediaPath, mediaStat, db, config, logger) {
  const mediaId = getId(config.paths.media, mediaPath)
  return scanFile(db, config, logger, mediaPath, mediaId, mediaStat)
    .catch(error => { logger.error(error) })
}
function fileUnlinked (mediaPath, mediaStat, db, config, logger) {
  const mediaId = getId(config.paths.media, mediaPath)
  return db.get(mediaId)
    .then(db.remove)
    .catch(error => { logger.error(error) })
}

async function cleanDeleted (config, db, logger) {
  logger.info('Checking for dead media')

  const limit = 256
  let startkey
  while (true) {
    const deleted = []

    const { rows } = await db.allDocs({
      include_docs: true,
      startkey,
      limit
    })
    await Promise.all(rows.map(async ({ doc }) => {
      try {
        const mediaFolder = path.normalize(config.scanner.paths)
        const mediaPath = path.normalize(doc.mediaPath)
        if (mediaPath.indexOf(mediaFolder) === 0 && await fileExists(doc.mediaPath)) {
          return
        }

        deleted.push({
          _id: doc._id,
          _rev: doc._rev,
          _deleted: true
        })
      } catch (err) {
        logger.error({ err, doc })
      }
    }))

    await db.bulkDocs(deleted)

    if (rows.length < limit) {
      break
    }
    startkey = rows[rows.length - 1].doc._id
  }

  logger.info(`Finished check for dead media`)
}

function scanner ({ config, db, logger }) {
  const watcher = chokidar
    .watch(config.scanner.paths, Object.assign({
      alwaysStat: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 1000
      }
    }, config.scanner))
    .on('error', err => logger.error({ err }))
    .on('add', (path, stat) => {
      return fileAdded(path, stat, db, config, logger)
    })
    .on('change', (path, stat) => {
      return fileChanged(path, stat, db, config, logger)
    })
    .on('unlink', (path, stat) => {
      return fileUnlinked(path, stat, db, config, logger)
    })

  cleanDeleted(config, db, logger)
  return watcher
}

module.exports = {
  generateThumb,
  generateInfo,
  scanFile,
  lookForFile,
  isCurrentlyScanningFile,
  currentlyScanningFileId,
  killAllChildProcesses,
  scanner
}
