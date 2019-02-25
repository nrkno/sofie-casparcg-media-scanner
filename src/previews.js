// @ts-check
const ChildProcess = require('child_process')
const util = require('util')
const mkdirp = require('mkdirp-promise')
const fs = require('fs')
const path = require('path')
const { fileExists } = require('./util')
const { getManualMode } = require('./manual')
const { crossPlatformKillProcess } = require('./processHandler')

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

function killAllProcesses () {
  if (runningFFMPEGGeneratePreviewProcess) {
    crossPlatformKillProcess(runningFFMPEGGeneratePreviewProcess)
  }
}

let runningFFMPEGGeneratePreviewProcess = null
async function generatePreview (db, config, logger, mediaId) {
  try {
    const destPath = path.join('_previews', mediaId) + '.webm'
    const doc = await db.get(mediaId)
    if (doc.previewTime === doc.mediaTime && await fileExists(destPath)) {
      return
    }

    if (doc.mediaPath.match(/_watchdogIgnore_/)) {
      return // ignore watchdog file
    }

    const mediaLogger = logger.child({
      id: mediaId,
      path: doc.mediaPath
    })

    const tmpPath = destPath + '.new'

    const args = [
      // TODO (perf) Low priority process?
      config.paths.ffmpeg,
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
    await new Promise((resolve, reject) => {
      runningFFMPEGGeneratePreviewProcess = ChildProcess.exec(args.join(' '), (err, stdout, stderr) => err ? reject(err) : resolve())
      runningFFMPEGGeneratePreviewProcess.on('exit', function () {
        runningFFMPEGGeneratePreviewProcess = null
      })
    })

    const previewStat = await statAsync(tmpPath)
    doc.previewSize = previewStat.size
    doc.previewTime = doc.mediaTime
    doc.previewPath = destPath

    await renameAsync(tmpPath, destPath)

    await db.put(doc)

    mediaLogger.info('Finished preview generation')
  } catch (err) {
    logger.error({ err })
    logger.error(err.stack)
  }
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
    logger.error({ err })
    logger.error(err.stack)
  })

  // Queue all for attempting to regenerate previews, if they are needed
  const { rows } = await db.allDocs()
  rows.forEach(row => rowChanged(row.id, false, logger, db, config))
  logger.info('Queued all for preview validity check')
  return changesListener
}

module.exports = {
  generatePreview,
  killAllProcesses,
  previews
}
