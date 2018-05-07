const cp = require('child_process')
const { Observable } = require('@reactivex/rxjs')
const util = require('util')
const chokidar = require('chokidar')
const mkdirp = require('mkdirp-promise')
const os = require('os')
const fs = require('fs')
const path = require('path')

const statAsync = util.promisify(fs.stat)
const unlinkAsync = util.promisify(fs.unlink)
const readFileAsync = util.promisify(fs.readFile)

module.exports = function ({ config, db, logger }) {
  Observable
    .create(o => {
      db.changes({
        since: 'now',
        live: true
      }).on('change', function (change) {
        o.next(change.id)
      }).on('error', function (err) {
        logger.error({ err })
      })
    })
    .concatMap(async id => {
      await generatePreview(id)
    })
    .subscribe()

  // TODO - scan on startup for missing previews
  
  async function generatePreview(mediaId) {
    try {
      const doc = await db.get(mediaId)
      if (doc.previewTime == doc.mediaTime){
        return
      }
      
      const mediaLogger = logger.child({
        id: mediaId,
        path: doc.mediaPath,
      })

      const tmpPath = path.join(os.tmpdir(), Math.random().toString(16)) + '.webm'

      const args = [
        // TODO (perf) Low priority process?
        config.paths.ffmpeg,
        '-hide_banner',
        '-i', `"${doc.mediaPath}"`,
        '-f', 'webm',
        '-an',
        '-c:v', 'libvpx',
        '-crf', config.previews.quality,
        '-auto-alt-ref', '0',
        `-vf scale=${config.previews.width}:${config.previews.height}`,
        '-threads 1',
        tmpPath
      ]

      await mkdirp(path.dirname(tmpPath))
      mediaLogger.info('Starting preview generation')
      await new Promise((resolve, reject) => {
        cp.exec(args.join(' '), (err, stdout, stderr) => err ? reject(err) : resolve())
      })

      const previewStat = await statAsync(tmpPath)
      doc.previewSize = previewStat.size
      doc.previewTime = previewStat.mtime.toISOString()

      doc._attachments = {
        'preview.webm': {
          content_type: 'video/webm',
          data: (await readFileAsync(tmpPath))
        }
      }

      await unlinkAsync(tmpPath)

      await db.put(doc)

      mediaLogger.info('Finished preview generation')
    } catch (err) {
      logger.error({ err })
    }
  }
}
