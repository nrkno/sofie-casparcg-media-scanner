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
const { crossPlatformKillProcessIfValid } = require('./processHandler')
const _ = require('lodash')
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

let lastProgressReportTimestamp = new Date()
function progressReport () {
  if (isCurrentlyScanning) {
    return lastProgressReportTimestamp
  } else {
    return false
  }
}

/**
 * Returns current running scan id (number), or false (boolean)
 */
function currentlyScanningFileId () {
  if (isCurrentlyScanning) {
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
      fileObject.mediaStat,
      fileObject.generateInfo)
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

async function scanFile (db, config, logger, mediaPath, mediaId, mediaStat, generateInfoWhenFound) {
  try {
    if (!mediaId || mediaStat.isDirectory()) {
      return
    }
    filesToScan[mediaId] = {
      db, config, logger, mediaPath, mediaId, mediaStat, generateInfoWhenFound
    }
    if (!getManualMode() && isCurrentlyScanning) { // if MS is in manualMode, then 
      return
    }
    isCurrentlyScanning = true
    currentScanId = currentScanId + 1
    lastProgressReportTimestamp = new Date()

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

    if (doc.mediaSize === mediaStat.size &&
        doc.mediaTime === mediaStat.mtime.getTime() &&
        (!getManualMode() ?
          doc.mediainfo && doc.thumbSize
        : true)
    ) {
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
    } else if (getManualMode() && generateInfoWhenFound) { // Check if basic file probe should be run in manualMode
      await generateInfo(config, doc).catch(err => {
        mediaLogger.error({ err }, 'Info Failed')
      })
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
    if (runningThumbnailProcess) {
      console.error('runningThumbnailProcess already exists')
    }
    runningThumbnailProcess = ChildProcess.exec(args.join(' '), (err, stdout, stderr) => err ? reject(err) : resolve())
    runningThumbnailProcess.on('exit', function () {
      runningThumbnailProcess = null
    })
  })

  const modifier = {}

  const thumbStat = await statAsync(tmpPath)
  modifier.thumbSize = thumbStat.size
  modifier.thumbTime = thumbStat.mtime.getTime()
  modifier.tinf = [
    `"${getId(config.paths.media, doc.mediaPath)}"`,
    moment(doc.thumbTime).format('YYYYMMDDTHHmmss'),
    // TODO (fix) Binary or base64 size?
    doc.thumbSize
  ].join(' ') + '\r\n'

  modifier._attachments = {
    'thumb.png': {
      content_type: 'image/png',
      data: (await readFileAsync(tmpPath))
    }
  }
  await unlinkAsync(tmpPath)
  _.merge(doc, modifier)
  return modifier
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
    if (runningffprobeProcess) {
      console.log('runningffprobeProcess already exists')
    }
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

  const modifier = {}

  modifier.cinf = generateCinf(config, doc, json)

  if (config.metadata !== null) {
    modifier.mediainfo = await generateBasicMetadata(config, doc, json)
    doc.mediainfo = modifier.mediainfo

    if (!getManualMode()) {
      _.merge(modifier.mediainfo, await generateAdvancedMetadata(config, doc))
    }
  }

  _.merge(doc, modifier)
  return modifier
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
  return Promise.all([
    crossPlatformKillProcessIfValid(runningMediaInfoProcessSpawn),
    crossPlatformKillProcessIfValid(runningMediaInfoProcessRawVideo),
    crossPlatformKillProcessIfValid(runningThumbnailProcess),
    crossPlatformKillProcessIfValid(runningffprobeProcess)])
}

let runningMediaInfoProcessSpawn = null
let runningMediaInfoProcessRawVideo = null
let alreadyScanning = false
function getMetadata (config, doc) {
  return new Promise((resolve, reject) => {
    if (!config.metadata.scenes && !config.metadata.freezeDetection && !config.metadata.blackDetection) {
      return resolve({})
    }

    if (!doc.mediainfo || !doc.mediainfo.format || !doc.mediainfo.format.duration) {
      return reject(new Error('Running getMetadata requires the presence of basic file data first.'))
    }

    let filterString = '' // String with combined filters.
    if (config.metadata.blackDetection) {
      filterString += `blackdetect=d=${config.metadata.blackDuration}:` +
        `pic_th=${config.metadata.blackRatio}:` +
        `pix_th=${config.metadata.blackThreshold}`
    }

    if (config.metadata.freezeDetection) {
      if (filterString) {
        filterString += ','
      }
      filterString += `freezedetect=n=${config.metadata.freezeNoise}:` +
        `d=${config.metadata.freezeDuration}`
    }

    if (config.metadata.scenes) {
      if (filterString) {
        filterString += ','
      }
      filterString += `"select='gt(scene,${config.metadata.sceneThreshold})',showinfo"`
    }

    // This process is very slow, and will take a significant amount
    // of time for big files. Consider a timeout, or something similar.
    // The way this is implemented now means that a timeout could result
    // in partial result, and not just "all or nothing".
    const args = [
      '-hide_banner',
      '-i', `${doc.mediaPath}`,
      '-filter:v', filterString,
      '-an',
      '-f', 'null',
      '-threads', '1',
      '-'
    ]

    let currentFrame = 0
    if (alreadyScanning) {
      console.log('We are already scannig. This could cause issues')
    }
    alreadyScanning = true
    if (runningMediaInfoProcessSpawn) {
      console.log('runningMediaInfoProcessSpawn already exists')
    }
    runningMediaInfoProcessSpawn = ChildProcess.spawn(config.paths.ffmpeg, args, { shell: true })
    let scenes = []
    let freezes = []
    let blacks = []
    //     crossPlatformKillProcessIfValid(runningMediaInfoProcessSpawn)
    runningMediaInfoProcessSpawn.stdout.on('data', (data) => {
      lastProgressReportTimestamp = new Date()
    })

    runningMediaInfoProcessSpawn.stderr.on('data', (data) => {
      let stringData = data.toString()
      lastProgressReportTimestamp = new Date()
      if (typeof stringData === 'string' && stringData.match(/^frame= +\d+/)) {
        currentFrame = Number(stringData.match(/^frame= +\d+/)[0].replace('frame=', ''))
      } else if (typeof stringData === 'string') {
        // Scenes
        let sceneRegex = /Parsed_showinfo_(.*)pts_time:([\d.]+)\s+/g
        let res
        do {
          res = sceneRegex.exec(stringData)
          if (res) {
            scenes.push(parseFloat(res[2]))
          }
        } while (res)

        // Black detect
        let blackDetectRegex = /(black_start:)(\d+(.\d+)?)( black_end:)(\d+(.\d+)?)( black_duration:)(\d+(.\d+))?/g
        do {
          res = blackDetectRegex.exec(stringData)
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
          res = freezeDetectRegex.exec(stringData)
          if (res) {
            freezes.push({ start: res[2] })
          }
        } while (res)

        freezeDetectRegex = /(lavfi\.freezedetect\.freeze_duration: )(\d+(.\d+)?)/g
        let i = 0
        do {
          res = freezeDetectRegex.exec(stringData)
          if (res && freezes[i]) {
            freezes[i].duration = res[2]
            i++
          }
        } while (res)

        freezeDetectRegex = /(lavfi\.freezedetect\.freeze_end: )(\d+(.\d+)?)/g
        i = 0
        do {
          res = freezeDetectRegex.exec(stringData)
          if (res && freezes[i]) {
            freezes[i].end = res[2]
            i++
          }
        } while (res)
      }
    })

    runningMediaInfoProcessSpawn.on('close', (code) => {
      if (code === 0) {
        // success
        // if freeze frame is the end of video, it is not detected fully
        if (freezes[freezes.length - 1] && !freezes[freezes.length - 1].end) {
          freezes[freezes.length - 1].end = doc.mediainfo.format.duration
          freezes[freezes.length - 1].duration = doc.mediainfo.format.duration - freezes[freezes.length - 1].start
        }
        resolve({ scenes, freezes, blacks })
      } else {
        reject(new Error('Ffmpeg failed with code ' + code))
      }
      alreadyScanning = false
    })
    runningMediaInfoProcessSpawn.on('exit', () => {
      runningMediaInfoProcessSpawn = null
    })
  })
}

function getFieldOrder (config, doc) {
  return new Promise((resolve, reject) => {
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
      '-f', 'rawvideo',
      '-y', (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      // '-threads 1', // Not needed. This is very quick even for big files.
      '-i', `"${doc.mediaPath}"`
    ]
    if (runningMediaInfoProcessRawVideo) {
      console.log('runningMediaInfoProcessRawVideo already exists')
    }
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
}

function sortBlackFreeze (tl) {
  return tl.sort((a, b) => {
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
}

function updateFreezeStartEnd (tl) {
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
  return freezes
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

async function generateBasicMetadata (config, doc, json) {
  let type = 'AUDIO'
  if (json.streams[0].pix_fmt) {
    type = (parseFloat(json.format.duration) || 0) <= (1 / 24) ? 'STILL' : 'MOVIE'
  }

  return tryToCastDoc({
    name: doc._id,
    path: doc.mediaPath,
    size: doc.mediaSize,
    time: doc.mediaTime,
    type,
    field_order: (doc.mediainfo || {}).fieldOrder,
    scenes: (doc.mediainfo || {}).scenes,
    freezes: (doc.mediainfo || {}).freezes,
    blacks: (doc.mediainfo || {}).blacks,

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

async function generateAdvancedMetadata (config, doc) {
  // TODO: We can the below
  // However; CPU usage is a concern, and I don't know how that
  // will be affected by such a parallel system.
  // const [fieldOrder, metadata] = await Promise.all([
  //   getFieldOrder(config, doc),
  //   getMetadata(config, doc, json)])

  const fieldOrder = await getFieldOrder(config, doc)
  const metadata = await getMetadata(config, doc)

  if (config.metadata.mergeBlacksAndFreezes) {
    if (
      metadata.blacks &&
      metadata.blacks.length &&
      metadata.freezes &&
      metadata.freezes.length
    ) {
      // blacks are subsets of freezes, so we can remove the freeze frame warnings during a black
      // in order to do this we create a linear timeline:
      let tl = []
      for (const black of metadata.blacks) {
        tl.push({ time: black.start, type: 'start', isBlack: true })
        tl.push({ time: black.end, type: 'end', isBlack: true })
      }
      for (const freeze of metadata.freezes) {
        tl.push({ time: freeze.start, type: 'start', isBlack: false })
        tl.push({ time: freeze.end, type: 'end', isBlack: false })
      }
      // then we sort it for time, if black & freeze start at the same time make sure black is inside the freeze
      tl = sortBlackFreeze(tl)

      // now we add freezes that aren't coinciding with blacks
      metadata.freezes = updateFreezeStartEnd(tl)
    }
  }

  return tryToCastDoc({
    name: doc._id,
    path: doc.mediaPath,
    size: doc.mediaSize,
    time: doc.mediaTime,

    field_order: fieldOrder,
    scenes: metadata.scenes,
    freezes: metadata.freezes,
    blacks: metadata.blacks
  })
}

function fileAdded (mediaPath, mediaStat, db, config, logger) {
  const mediaId = getId(config.paths.media, mediaPath)
  return scanFile(db, config, logger, mediaPath, mediaId, mediaStat, false)
    .catch(error => { logger.error(error) })
}
function fileChanged (mediaPath, mediaStat, db, config, logger) {
  const mediaId = getId(config.paths.media, mediaPath)
  return scanFile(db, config, logger, mediaPath, mediaId, mediaStat, false)
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
        logger.error({ name: 'cleanDeleted', err, doc })
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
        stabilityThreshold: 4000,
        pollInterval: 1000
      }
    }, config.scanner))
    .on('add', (path, stat) => {
      return fileAdded(path, stat, db, config, logger)
    })
    .on('change', (path, stat) => {
      return fileChanged(path, stat, db, config, logger)
    })
    .on('unlink', (path, stat) => {
      return fileUnlinked(path, stat, db, config, logger)
    })
    .on('ready', () => {
      logger.info('Watcher ready!')
    })
    .on('error', (err) => {
      if (err) {
        logger.error(err.stack)
      }
      logger.error({ name: 'chokidar', err })
    })

  cleanDeleted(config, db, logger)
  return watcher
}

module.exports = {
  generateThumb,
  generateInfo: generateInfo,
  generateAdvancedInfo: generateAdvancedMetadata,
  scanFile,
  lookForFile,
  isCurrentlyScanningFile,
  progressReport,
  currentlyScanningFileId,
  killAllChildProcesses,
  scanner
}
