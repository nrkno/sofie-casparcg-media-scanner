// @ts-check
const util = require('util')
const mkdirp = require('mkdirp-promise')
const fs = require('fs')
const path = require('path')
const _ = require('lodash')
const { fileExists } = require('./util')
const { getManualMode } = require('./manual')
const { ProcessLimiter } = require('./processLimiter')

const statAsync = util.promisify(fs.stat)
const unlinkAsync = util.promisify(fs.unlink)
const renameAsync = util.promisify(fs.rename)

async function deleteWaveform (logger, mediaId) {
  const destPath = path.join('_waveforms', mediaId) + '.png'
  await unlinkAsync(destPath).catch(err => {
    if (err.code !== 'ENOENT' && err.message.indexOf('no such file or directory') === -1) {
      logger.error(err.stack)
      logger.error(err)
    }
  })
}

let lastProgressReportTimestamp = new Date()
let isCurrentlyScanning = false
async function generateWaveform (db, config, logger, mediaId) {
  try {
    const destPath = path.join('_waveforms', mediaId) + '.png'
    const doc = await db.get(mediaId)

    if (!doc.mediainfo) return {}

    const noOfStreams = doc.mediainfo.streams.filter(o => o.codec.type === 'audio').length
    if (noOfStreams === 0) return {}

    if (doc.waveformTime === doc.mediaTime && await fileExists(destPath)) {
      return
    }

    // Generate the initial waveform:
    isCurrentlyScanning = true
    const waveformLogger = logger.child({
      id: mediaId,
      path: doc.mediaPath
    })

    const tmpPath = path.join('_waveforms', mediaId) + '_generated.png'
    const dur = doc.mediainfo.format.duration
    let filterString = '"'
    let mono = false
    if (noOfStreams > 1) {
      filterString += 'amerge=2,'
    } else {
      // figure out no of channels.
      const stream = doc.mediainfo.streams.filter(o => o.codec.type === 'audio')[0]
      if (stream.channels > 1) {
        filterString += 'channelsplit,amerge=2,'
      }
    }
    const width = Math.round(dur * config.waveforms.pixelsPerSecond)
    const height = config.waveforms.height / (mono ? 2 : 1)
     // @todo: variable inputs
    filterString += `showwavespic=s=${width}x${height}:split_channels=1:scale=log:colors=${config.waveforms.colors}"`

    const args = [
      '-hide_banner',
      '-y',
      '-threads 1',
      '-i', `"${doc.mediaPath}"`,
      `-filter_complex`, filterString,
      '-frames:v 1',
      `"${tmpPath}"`
    ]

    await mkdirp(path.dirname(tmpPath))
    waveformLogger.info('Starting waveform generation')

    await ProcessLimiter('waveformFfmpeg', config.paths.ffmpeg, args,
      () => {
        lastProgressReportTimestamp = new Date()
      },
      () => {
        lastProgressReportTimestamp = new Date()
      })

    const modifier = {}
    if (!mono) { // crop the generated waveform:
      const croppedPath = path.join('_waveforms', mediaId) + '_cropped.png'
      const croppedHeight = Math.round(height / 4)
      const argsCrop = [
        '-hide_banner',
        '-y',
        '-threads 1',
        '-i', `"${tmpPath}"`,
        '-filter_complex', `"[v:0]crop=${width}:${croppedHeight}:0:0[v0];[v:0]crop=${width}:${croppedHeight}:0:${croppedHeight * 2}[v1];[v0][v1]vstack[v]"`,
        '-map [v]',
        `"${croppedPath}"`
      ]

      waveformLogger.info('Starting waveform crop')

      await ProcessLimiter('waveformCropFfmpeg', config.paths.ffmpeg, argsCrop,
        () => {
          lastProgressReportTimestamp = new Date()
        },
        () => {
          lastProgressReportTimestamp = new Date()
        })

      const waveformCroppedStat = await statAsync(croppedPath)
      modifier.waveformSize = waveformCroppedStat.size
      modifier.waveformTime = doc.mediaTime
      modifier.waveformPath = destPath

      await unlinkAsync(tmpPath)
      await renameAsync(croppedPath, destPath)
    } else {
      const waveformStat = await statAsync(tmpPath)
      modifier.waveformSize = waveformStat.size
      modifier.waveformTime = doc.mediaTime
      modifier.waveformPath = destPath

      await renameAsync(tmpPath, destPath)
    }

    let updateDoc = await db.get(mediaId)
    updateDoc = _.merge(updateDoc, modifier)

    db.put(updateDoc)

    waveformLogger.info('Finished waveform generation')

    return modifier
  } catch (err) {
    logger.error({ name: 'generatewaveform', err })
    logger.error(err.stack)
  }
  isCurrentlyScanning = false
}
async function rowChanged (id, deleted, logger, db, config) {
  if (deleted) {
    await deleteWaveform(logger, id)
  } else {
    if (!getManualMode()) await generateWaveform(db, config, logger, id)
  }
}

async function waveforms ({ config, db, logger }) {
  let changesListener = db.changes({
    since: 'now',
    live: true
  }).on('change', change => {
    return rowChanged(change.id, change.deleted, logger, db, config)
  }).on('complete', info => {
    logger.info('waveform db connection completed')
  }).on('error', err => {
    logger.error({ name: 'waveforms', err })
    logger.error(err.stack)
  })

  // Queue all for attempting to regenerate waveforms, if they are needed
  const { rows } = await db.allDocs()
  rows.forEach(row => rowChanged(row.id, false, logger, db, config))
  logger.info('Queued all for waveform validity check')
  return changesListener
}

function progressReport () {
  if (isCurrentlyScanning) {
    return lastProgressReportTimestamp
  } else {
    return false
  }
}

module.exports = {
  generatewaveform: generateWaveform,
  waveforms,
  progressReport
}
