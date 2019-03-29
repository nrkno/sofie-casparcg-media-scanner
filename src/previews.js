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

async function deletePreview (logger, mediaId) {
  const destPath = path.join('_previews', mediaId) + '.webm'
  await unlinkAsync(destPath).catch(err => {
    if (err.code !== 'ENOENT' && err.message.indexOf('no such file or directory') === -1) {
      logger.error(err.stack)
      logger.error(err)
    }
  })
}

let lastProgressReportTimestamp = new Date()
let isCurrentlyScanning = false
async function generatePreview (db, config, logger, mediaId) {
  try {
    const destPath = path.join('_previews', mediaId) + '.webm'
    const doc = await db.get(mediaId)

    if (doc.mediaPath.match(/_watchdogIgnore_/)) {
      return // ignore watchdog file
    }

    if (doc.previewTime === doc.mediaTime && await fileExists(destPath)) {
      return
    }

    isCurrentlyScanning = true
    const mediaLogger = logger.child({
      id: mediaId,
      path: doc.mediaPath
    })

    const tmpPath = destPath + '.new'

    const args = [
      '-hide_banner',
      '-y',
      '-threads 1',
      '-i', `"${doc.mediaPath}"`,
      '-f', 'webm',
      '-an',
      '-c:v', 'libvpx',
      '-b:v', config.previews.bitrate,
      '-auto-alt-ref', '0',
      `-vf scale=${config.previews.width}:${config.previews.height}`,
      '-deadline realtime',
      `"${tmpPath}"`
    ]

    await mkdirp(path.dirname(tmpPath))
    mediaLogger.info('Starting preview generation')

    await ProcessLimiter('previewFfmpeg', config.paths.ffmpeg, args,
      () => {
        lastProgressReportTimestamp = new Date()
      },
      () => {
        lastProgressReportTimestamp = new Date()
      })

    const previewStat = await statAsync(tmpPath)
    const modifier = {}
    modifier.previewSize = previewStat.size
    modifier.previewTime = doc.mediaTime
    modifier.previewPath = destPath

    await renameAsync(tmpPath, destPath)

    let updateDoc = await db.get(mediaId)
    updateDoc = _.merge(updateDoc, modifier)

    db.put(updateDoc)

    mediaLogger.info('Finished preview generation')

    return modifier
  } catch (err) {
    logger.error({ name: 'generatePreview', err })
    logger.error(err.stack)
  }
  isCurrentlyScanning = false
}
async function rowChanged (id, deleted, logger, db, config) {
  if (!getManualMode()) {
    if (deleted) {
      await deletePreview(logger, id)
    } else {
      await generatePreview(db, config, logger, id)
    }
  }
}

async function previews ({ config, db, logger }) {
  let changesListener = db.changes({
    since: 'now',
    live: true
  }).on('change', change => {
    return rowChanged(change.id, change.deleted, logger, db, config)
  }).on('complete', info => {
    logger.info('preview db connection completed')
  }).on('error', err => {
    logger.error({ name: 'previews', err })
    logger.error(err.stack)
  })

  // Queue all for attempting to regenerate previews, if they are needed
  const { rows } = await db.allDocs()
  rows.forEach(row => rowChanged(row.id, false, logger, db, config))
  logger.info('Queued all for preview validity check')
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
  generatePreview,
  previews,
  progressReport
}
