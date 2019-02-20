// @ts-check
const cp = require('child_process')
const { Observable } = require('@reactivex/rxjs')
const util = require('util')
const mkdirp = require('mkdirp-promise')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { fileExists } = require('./util')
const { getManualMode } = require('./manual')

const statAsync = util.promisify(fs.stat)
const unlinkAsync = util.promisify(fs.unlink)
const renameAsync = util.promisify(fs.rename)

async function deletePreview (logger, mediaId) {
  const destPath = path.join('_previews', mediaId) + '.webm'
  await unlinkAsync(destPath).catch(err => {
    if(err.code !== 'ENOENT' && err.message.indexOf('no such file or directory') === -1){
      logger.error(err)
    }
  })
  return
}
async function generatePreview (db, config, logger, mediaId) {
  try {
    const destPath = path.join('_previews', mediaId) + '.webm'
    const doc = await db.get(mediaId)
    if (doc.previewTime === doc.mediaTime && await fileExists(destPath)) {
      return
    }

    if (doc.mediaPath.match(/_watchdogIgnore_/)) return // ignore watchdog file

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
      cp.exec(args.join(' '), (err, stdout, stderr) => err ? reject(err) : resolve())
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

module.exports = {
  generatePreview,
  previews: function ({ config, db, logger }) {
    Observable
      .create(async o => {
        db.changes({
          since: 'now',
          live: true
        }).on('change', function (change) {
          o.next([change.id, change.deleted])
        }).on('complete', function (info) {
          logger.info('db connection completed')
        }).on('error', function (err) {
          logger.error({ err })
          logger.error(err.stack)
        })

        // Queue all for attempting to regenerate previews, if they are needed
        const { rows } = await db.allDocs()
        rows.forEach(d => o.next([d.id, false]))
        logger.info('Queued all for preview validity check')
      })
      .concatMap(async ([id, deleted]) => {
        if (!getManualMode()) {
          if(deleted){
            await deletePreview(logger, id)
          } else {
            await generatePreview(db, config, logger, id)
          }
        }
      })
      .subscribe()
  }
}
