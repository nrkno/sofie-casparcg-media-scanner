const cp = require('child_process')
const { Observable } = require('@reactivex/rxjs')
const util = require('util')
const chokidar = require('chokidar')
const mkdirp = require('mkdirp-promise')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { getId, fileExists } = require('./util')
const moment = require('moment')

const statAsync = util.promisify(fs.stat)
const unlinkAsync = util.promisify(fs.unlink)
const readFileAsync = util.promisify(fs.readFile)

module.exports = function ({ config, db, logger }) {
  Observable
    .create(o => {
      const watcher = chokidar
        .watch(config.scanner.paths, Object.assign({
          alwaysStat: true,
          awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 1000
          }
        }, config.scanner))
        .on('error', err => logger.error({ err }))
        .on('add', (path, stat) => o.next([ path, stat ]))
        .on('change', (path, stat) => o.next([ path, stat ]))
        .on('unlink', (path, stat) => o.next([ path ]))
      return () => watcher.close()
    })
    // TODO (perf) groupBy + mergeMap with concurrency.
    .concatMap(async ([ mediaPath, mediaStat ]) => {
      const mediaId = getId(config.paths.media, mediaPath)
      try {
        if (!mediaStat) {
          await db.remove(await db.get(mediaId))
        } else {
          await scanFile(mediaPath, mediaId, mediaStat)
        }
      } catch (err) {
        logger.error({ err })
      }
    })
    .subscribe()

  async function cleanDeleted () {
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
  cleanDeleted()

  async function scanFile (mediaPath, mediaId, mediaStat) {
    if (!mediaId || mediaStat.isDirectory()) {
      return
    }

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
      return
    }

    if (doc.mediaSize === mediaStat.size && doc.mediaTime === mediaStat.mtime.getTime()) {
      return
    }

    doc.mediaPath = mediaPath
    doc.mediaSize = mediaStat.size
    doc.mediaTime = mediaStat.mtime.getTime()

    await Promise.all([
      generateInfo(doc).catch(err => {
        mediaLogger.error({ err }, 'Info Failed')
      }),
      generateThumb(doc).catch(err => {
        mediaLogger.error({ err }, 'Thumbnail Failed')
      })
    ])

    await db.put(doc)

    mediaLogger.info('Scanned')
  }

  async function generateThumb (doc) {
    const tmpPath = path.join(os.tmpdir(), Math.random().toString(16)) + '.png'

    const args = [
      // TODO (perf) Low priority process?
      config.paths.ffmpeg,
      '-hide_banner',
      '-i', `"${doc.mediaPath}"`,
      '-frames:v 1',
      `-vf thumbnail,scale=${config.thumbnails.width}:${config.thumbnails.height}`,
      '-threads 1',
      tmpPath
    ]

    await mkdirp(path.dirname(tmpPath))
    await new Promise((resolve, reject) => {
      cp.exec(args.join(' '), (err, stdout, stderr) => err ? reject(err) : resolve())
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

  async function generateInfo (doc) {
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
      cp.exec(args.join(' '), (err, stdout, stderr) => {
        if (err) {
          return reject(err)
        }

        const json = JSON.parse(stdout)
        if (!json.streams || !json.streams[0]) {
          return reject(new Error('not media'))
        }

        resolve(json)
      })
    })

    doc.cinf = generateCinf(doc, json)

    if (config.metadata !== null) {
      doc.mediainfo = await generateMediainfo(doc, json)
    }
  }

  function generateCinf (doc, json) {
    let tb = (json.streams[0].time_base || '1/25').split('/')
    let dur = parseFloat(json.format.duration) || (1 / 24)

    let type = ' AUDIO '
    if (json.streams[0].pix_fmt) {
      type = dur <= (1 / 24) ? ' STILL ' : ' MOVIE '

      const fr = String(json.streams[0].avg_frame_rate || json.streams[0].r_frame_rate || '').split('/')
      if (fr.length === 2) {
        tb = [ fr[1], fr[0] ]
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

  async function generateMediainfo (doc, json) {
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
      cp.exec(args.join(' '), (err, stdout, stderr) => {
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
    })

    const metadata = await new Promise((resolve, reject) => {
      if (!config.metadata.scenes && !config.metadata.freezeDetection && !config.metadata.blackDetection) {
        return resolve({})
      }

      let filterString = '' // String with combined filters.
      if (config.metadata.scenes) {
        filterString += `"select='gt(scene,${config.metadata.sceneThreshold})',showinfo"`

        if (config.metadata.blackDetection || config.metadata.freezeDetection) {
          filterString += ','
        }
      }

      if (config.metadata.blackDetection) {
        filterString += `blackdetect=d=${config.metadata.blackDuration}:
          pic_th=${config.metadata.blackRatio}:
          pix_th=${config.metadata.thresHold}`
          
        if (config.metadata.freezeDetection) {
          filterString += ','
        }
      }

      if (config.metadata.freezeDetection) {
        filterString += `freezedetect=n=${config.metadata.freezeNoise}:
          d=${config.metadata.freezeDuration}`
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
      cp.exec(args.join(' '), (err, stdout, stderr) => {
        if (err) {
          return reject(err)
        }

        const scenes = []
        const blacks = []
        const freezes = []

        // Scenes
        var regex = /Parsed_showinfo_(.*)pts_time:([\d.]+)\s+/g
        let res
        do {
          res = regex.exec(stderr)
          if (res) {
            scenes.push(parseFloat(res[2]))
          }
        } while (res)
        
        // Black detect
        var regex = /(black_start:)(\d+(.\d+)?)( black_end:)(\d+(.\d+)?)( black_duration:)(\d+(.\d+))?/g
        do {
            res = regex.exec(stderr)
            if (res) {
                blacks.push({
                    start: res[2],
                    duration: res[5],
                    end: res[8]
                })
            }
        } while (res)

        // Freeze detect
        regex = /(lavfi\.freezedetect\.freeze_start: )(\d+(.\d+)?)/g
        do {
            res = regex.exec(stderr)
            if (res) {
                freezes.push({ start: res[2] })
            }
        } while (res)
        
        regex = /(lavfi\.freezedetect\.freeze_duration: )(\d+(.\d+)?)/g
        let i = 0
        do {
            res = regex.exec(stderr)
            if (res) {
                freezes[i].duration = res[2]
                i++
            }
        } while (res)
        
        regex = /(lavfi\.freezedetect\.freeze_end: )(\d+(.\d+)?)/g
        i = 0
        do {
            res = regex.exec(stderr)
            if (res) {
                freezes[i].end = res[2]
                i++
            }
        } while (res)

        return resolve({ scenes, freezes, blacks })
      })
    })

    let type = 'AUDIO'
    if (json.streams[0].pix_fmt) {
      type = (parseFloat(json.format.duration) || 0) <= (1 / 24) ? 'STILL' : 'MOVIE'
    }

    return {
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
    }
  }
}
